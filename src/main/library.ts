// 生成したハイトマップを data/ フォルダ内に保存し、一覧・選択・削除するライブラリ。
//
// 各アイテムの保存物（data/ 内）:
//   <id>.u16            … 全解像度の正規化16bit値（Uint16, リトルエンディアン）= 唯一の真実
//   <id>.preview.png    … 2Dタブ用の8bitプレビュー
//   <id>.satellite.png  … 衛星画像テクスチャ（任意。3Dメッシュに貼る）
//   library.json        … 索引（メタ情報の配列）
//
// PNG16 / R16 のエクスポートは <id>.u16 から都度生成する。
import { promises as fs } from 'fs'
import { join } from 'path'
import type { BBox } from './tiles'

const INDEX_FILE = 'library.json'

export interface LibraryEntry {
  id: string
  name: string
  createdAt: number
  bbox: BBox
  zoom: number
  sourceId: string
  width: number
  height: number
  minEle: number
  maxEle: number
  /** 衛星テクスチャ（<id>.satellite.png）を保存しているか */
  hasSatellite?: boolean
  /** 手動並べ替え後の表示順（小さいほど上）。未設定なら createdAt 降順で並べる */
  order?: number
}

function indexPath(dir: string): string {
  return join(dir, INDEX_FILE)
}
function u16Path(dir: string, id: string): string {
  return join(dir, `${id}.u16`)
}
function previewPath(dir: string, id: string): string {
  return join(dir, `${id}.preview.png`)
}
function satellitePath(dir: string, id: string): string {
  return join(dir, `${id}.satellite.png`)
}

export async function readIndex(dir: string): Promise<LibraryEntry[]> {
  try {
    const txt = await fs.readFile(indexPath(dir), 'utf-8')
    const arr = JSON.parse(txt) as LibraryEntry[]
    // 全件に手動並べ替えの order があればそれに従う。なければ従来通り新着順。
    const allOrdered = arr.length > 0 && arr.every((e) => typeof e.order === 'number')
    if (allOrdered) return arr.sort((a, b) => a.order! - b.order!)
    return arr.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

async function writeIndex(dir: string, entries: LibraryEntry[]): Promise<void> {
  await fs.writeFile(indexPath(dir), JSON.stringify(entries, null, 2), 'utf-8')
}

/** 新規アイテムを保存して索引に追加する */
export async function addEntry(
  dir: string,
  entry: LibraryEntry,
  values16: Uint16Array,
  previewPng: Buffer
): Promise<void> {
  // Uint16 をリトルエンディアンのバイト列で保存
  const buf = Buffer.from(values16.buffer, values16.byteOffset, values16.byteLength)
  await fs.writeFile(u16Path(dir, entry.id), buf)
  await fs.writeFile(previewPath(dir, entry.id), previewPng)

  const entries = await readIndex(dir)
  // 既に手動並べ替え済み（全件 order あり）なら、新規は先頭（最小 order - 1）に置く
  const allOrdered = entries.length > 0 && entries.every((e) => typeof e.order === 'number')
  if (allOrdered) {
    entry.order = Math.min(...entries.map((e) => e.order!)) - 1
  }
  entries.push(entry)
  await writeIndex(dir, entries)
}

/** ライブラリの表示順を、与えられた id 配列の順に並べ替えて保存する */
export async function reorderEntries(dir: string, ids: string[]): Promise<boolean> {
  const entries = await readIndex(dir)
  const rank = new Map(ids.map((id, i) => [id, i]))
  for (const e of entries) {
    // 与えられた配列にない id は末尾へ
    e.order = rank.has(e.id) ? rank.get(e.id)! : ids.length
  }
  await writeIndex(dir, entries)
  return true
}

/** 合成済み衛星 PNG を保存し、索引の hasSatellite を立てる */
export async function saveSatellite(dir: string, id: string, png: Buffer): Promise<void> {
  await fs.writeFile(satellitePath(dir, id), png)
  const entries = await readIndex(dir)
  const e = findEntry(entries, id)
  if (e) {
    e.hasSatellite = true
    await writeIndex(dir, entries)
  }
}

/** アイテムの表示名を変更する */
export async function renameEntry(dir: string, id: string, name: string): Promise<boolean> {
  const entries = await readIndex(dir)
  const e = findEntry(entries, id)
  if (!e) return false
  e.name = name
  await writeIndex(dir, entries)
  return true
}

/** アイテムを削除（ファイル＋索引） */
export async function deleteEntry(dir: string, id: string): Promise<boolean> {
  const entries = await readIndex(dir)
  const next = entries.filter((e) => e.id !== id)
  if (next.length === entries.length) return false
  await writeIndex(dir, next)
  await fs.rm(u16Path(dir, id), { force: true })
  await fs.rm(previewPath(dir, id), { force: true })
  await fs.rm(satellitePath(dir, id), { force: true })
  return true
}

/** アイテムの全解像度 16bit 値を読み出す */
export async function readValues16(dir: string, id: string): Promise<Uint16Array> {
  const buf = await fs.readFile(u16Path(dir, id))
  // Buffer から独立した Uint16Array を作る（バイト境界に注意）
  const out = new Uint16Array(buf.byteLength / 2)
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt16LE(i * 2)
  return out
}

/** プレビューPNGを dataURL で読み出す */
export async function readPreviewDataUrl(dir: string, id: string): Promise<string> {
  const buf = await fs.readFile(previewPath(dir, id))
  return `data:image/png;base64,${buf.toString('base64')}`
}

/** 衛星テクスチャを dataURL で読み出す（無ければ null） */
export async function readSatelliteDataUrl(dir: string, id: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(satellitePath(dir, id))
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

export function findEntry(entries: LibraryEntry[], id: string): LibraryEntry | undefined {
  return entries.find((e) => e.id === id)
}
