// タイルの合成・RGB→標高デコード・16bit 書き出し。
import { PNG } from 'pngjs'
import { promises as fs } from 'fs'
import { TILE_SIZE, PixelRegion, DownloadedTile } from './tiles'

/** Mapbox Terrain-RGB / Terrain-DEM の標高デコード式 */
export function decodeElevation(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1
}

export interface HeightField {
  width: number
  height: number
  /** 標高（メートル）の配列。row-major, 北西が原点 */
  data: Float32Array
  minEle: number
  maxEle: number
}

/** ダウンロードしたタイル群を合成し、クロップして標高フィールドを作る */
export function buildHeightField(tiles: DownloadedTile[], region: PixelRegion): HeightField {
  const { outWidth, outHeight, left, top } = region

  // タイルを (x,y) で引けるようにする
  const tileMap = new Map<string, PNG>()
  for (const t of tiles) {
    tileMap.set(`${t.x}_${t.y}`, PNG.sync.read(t.buffer))
  }

  const data = new Float32Array(outWidth * outHeight)
  let minEle = Infinity
  let maxEle = -Infinity

  // 出力画像の各ピクセルを、対応するタイル・ピクセルから引く
  for (let oy = 0; oy < outHeight; oy++) {
    const globalY = top + oy // z 基準の絶対ピクセル
    const ty = Math.floor(globalY / TILE_SIZE)
    const inTileY = Math.floor(globalY - ty * TILE_SIZE)

    for (let ox = 0; ox < outWidth; ox++) {
      const globalX = left + ox
      const tx = Math.floor(globalX / TILE_SIZE)
      const inTileX = Math.floor(globalX - tx * TILE_SIZE)

      const png = tileMap.get(`${tx}_${ty}`)
      let ele = -10000
      if (png) {
        const idx = (png.width * inTileY + inTileX) * 4
        const r = png.data[idx]
        const g = png.data[idx + 1]
        const b = png.data[idx + 2]
        ele = decodeElevation(r, g, b)
      }
      data[oy * outWidth + ox] = ele
      if (ele < minEle) minEle = ele
      if (ele > maxEle) maxEle = ele
    }
  }

  return { width: outWidth, height: outHeight, data, minEle, maxEle }
}

/** 標高フィールドを 0..65535 に正規化した 16bit 配列に変換 */
export function normalizeTo16bit(
  hf: HeightField,
  rangeMin?: number,
  rangeMax?: number
): Uint16Array {
  const lo = rangeMin ?? hf.minEle
  const hi = rangeMax ?? hf.maxEle
  const span = hi - lo || 1
  const out = new Uint16Array(hf.width * hf.height)
  for (let i = 0; i < hf.data.length; i++) {
    let v = (hf.data[i] - lo) / span
    v = Math.max(0, Math.min(1, v))
    out[i] = Math.round(v * 65535)
  }
  return out
}

/** PNG 標準の CRC-32（チャンク用） */
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
/** pHYs チャンク（解像度メタ）。既定 3780px/m = 96DPI, unit=1(meter) */
function physChunk(ppuX = 3780, ppuY = 3780, unit = 1): Buffer {
  const data = Buffer.alloc(9)
  data.writeUInt32BE(ppuX, 0)
  data.writeUInt32BE(ppuY, 4)
  data[8] = unit
  const type = Buffer.from('pHYs')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(9, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0)
  return Buffer.concat([len, type, data, crc])
}

/**
 * 16bit RGBA PNG として書き出す（R=G=B=標高値, A=不透明 65535）。
 * World Machine / Gaea 等の「16bit RGBA + pHYs」ハイトマップ出力に合わせた形式。
 */
export async function exportPng16(
  filePath: string,
  width: number,
  height: number,
  values16: Uint16Array
): Promise<void> {
  const png = new PNG({
    width,
    height,
    colorType: 6, // RGBA
    bitDepth: 16,
    inputColorType: 6,
    inputHasAlpha: true
  })
  // pngjs はビッグエンディアン 16bit を期待する。1画素 = RGBA × 2byte。
  const buf = Buffer.alloc(width * height * 4 * 2)
  for (let i = 0; i < values16.length; i++) {
    const v = values16[i]
    const o = i * 8
    buf.writeUInt16BE(v, o) // R
    buf.writeUInt16BE(v, o + 2) // G
    buf.writeUInt16BE(v, o + 4) // B
    buf.writeUInt16BE(65535, o + 6) // A（不透明）
  }
  png.data = buf
  let out = PNG.sync.write(png, { colorType: 6, bitDepth: 16, inputColorType: 6 })
  // IHDR チャンク（8byte sig + 25byte IHDR）の直後に pHYs を挿入する
  const afterIhdr = 33
  out = Buffer.concat([out.subarray(0, afterIhdr), physChunk(), out.subarray(afterIhdr)])
  await fs.writeFile(filePath, out)
}

/** R16 raw（リトルエンディアン uint16、UE / World Machine 互換）として書き出す */
export async function exportRaw16(filePath: string, values16: Uint16Array): Promise<void> {
  const buf = Buffer.alloc(values16.length * 2)
  for (let i = 0; i < values16.length; i++) {
    buf.writeUInt16LE(values16[i], i * 2)
  }
  await fs.writeFile(filePath, buf)
}

export interface MeshData {
  /** グリッド頂点数（横・縦） */
  cols: number
  rows: number
  /** 各頂点の標高（メートル, row-major, 北西が原点） */
  heights: Float32Array
  minEle: number
  maxEle: number
  /** 出力画像のアスペクト比（width / height）。3D表示の縦横比に使う */
  aspect: number
}

/**
 * フル解像度のフィールドを最大 maxDim 頂点までダウンサンプリングして 3Dメッシュ用の
 * 標高グリッドを作る（フル解像度をそのままGPUへ送ると重いため）。
 * 元データ（標高 float か正規化16bit）の違いは sample コールバックで吸収する。
 */
function downsampleToMesh(
  width: number,
  height: number,
  minEle: number,
  maxEle: number,
  maxDim: number,
  sample: (sx: number, sy: number) => number
): MeshData {
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / maxDim))
  const cols = Math.max(2, Math.floor(width / scale))
  const rows = Math.max(2, Math.floor(height / scale))
  const heights = new Float32Array(cols * rows)

  for (let r = 0; r < rows; r++) {
    const sy = Math.min(height - 1, Math.floor((r / (rows - 1)) * (height - 1)))
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(width - 1, Math.floor((c / (cols - 1)) * (width - 1)))
      heights[r * cols + c] = sample(sx, sy)
    }
  }

  return { cols, rows, heights, minEle, maxEle, aspect: width / height }
}

/** 標高フィールド（生成直後, 標高メートルの float）から 3Dメッシュ用データを作る */
export function buildMeshData(hf: HeightField, maxDim = 256): MeshData {
  return downsampleToMesh(
    hf.width,
    hf.height,
    hf.minEle,
    hf.maxEle,
    maxDim,
    (sx, sy) => hf.data[sy * hf.width + sx]
  )
}

/**
 * 保存済みの正規化16bit値（フル解像度）から、3Dメッシュ用にダウンサンプリングする。
 * 値は 0..65535 の正規化値なので、min/max を使って標高(メートル)へ戻す。
 */
export function meshFromValues16(
  values16: Uint16Array,
  width: number,
  height: number,
  minEle: number,
  maxEle: number,
  maxDim = 256
): MeshData {
  const span = maxEle - minEle || 1
  return downsampleToMesh(width, height, minEle, maxEle, maxDim, (sx, sy) => {
    const v = values16[sy * width + sx]
    return minEle + (v / 65535) * span
  })
}

/** プレビュー用に 8bit グレースケール PNG（DataURL用 Buffer）を作る */
export function buildPreviewPng(width: number, height: number, values16: Uint16Array): Buffer {
  const png = new PNG({ width, height, colorType: 6 })
  for (let i = 0; i < values16.length; i++) {
    const v = values16[i] >> 8 // 16bit → 8bit
    const idx = i * 4
    png.data[idx] = v
    png.data[idx + 1] = v
    png.data[idx + 2] = v
    png.data[idx + 3] = 255
  }
  return PNG.sync.write(png)
}
