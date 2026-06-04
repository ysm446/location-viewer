// 外部依存なしの最小 ZIP 読み書き。
//
// ロケーションのバックアップ用途。Node 標準の zlib（deflate/inflate）だけで
// ZIP コンテナ（ローカルヘッダ＋セントラルディレクトリ＋EOCD）を組み立て/解析する。
// Zip64 は非対応（1ファイル/全体ともに 4GB 未満を前提）。
import { promises as fs } from 'fs'
import { deflateRaw, inflateRaw } from 'zlib'
import { promisify } from 'util'

const deflate = promisify(deflateRaw)
const inflate = promisify(inflateRaw)

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

// CRC32（IEEE）テーブル
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** ZIP 内のパス（'/' 区切り）。ここではフラットなファイル名のみ使う */
  name: string
  data: Buffer
}

/** エントリ群を ZIP として outPath に書き出す（deflate 圧縮） */
export async function writeZip(outPath: string, entries: ZipEntry[]): Promise<void> {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const crc = crc32(e.data)
    const compressed = await deflate(e.data)
    // 圧縮で増えるなら無圧縮(store)で格納
    const useStore = compressed.length >= e.data.length
    const method = useStore ? 0 : 8
    const body = useStore ? e.data : compressed

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time（固定）
    local.writeUInt16LE(0x21, 12) // mod date（1980-01-01。0 は不正日付なので最小値）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18) // compressed size
    local.writeUInt32LE(e.data.length, 22) // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12) // mod time
    central.writeUInt16LE(0x21, 14) // mod date
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra len
    central.writeUInt16LE(0, 32) // comment len
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  await fs.writeFile(outPath, Buffer.concat([...locals, centralBuf, eocd]))
}

/** ZIP を読み出してエントリ群（解凍済み）を返す */
export async function readZip(zipPath: string): Promise<ZipEntry[]> {
  const buf = await fs.readFile(zipPath)

  // EOCD を末尾から探す（コメント無し前提だが念のため後方スキャン）
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP として解析できません（EOCD が見つかりません）。')

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16) // central dir offset

  const out: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen)

    // ローカルヘッダ側の name/extra 長は中央と異なり得るので読み直す
    const lfNameLen = buf.readUInt16LE(localOff + 26)
    const lfExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lfNameLen + lfExtraLen
    const body = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(body) : await inflate(body)
    out.push({ name, data })

    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
