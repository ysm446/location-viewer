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
  const { tileX0, tileY0, outWidth, outHeight, left, top } = region

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

  // 念のため tileX0/tileY0 を参照（未使用警告回避・将来のデバッグ用）
  void tileX0
  void tileY0

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

/** 16bit グレースケール PNG として書き出す */
export async function exportPng16(
  filePath: string,
  width: number,
  height: number,
  values16: Uint16Array
): Promise<void> {
  const png = new PNG({
    width,
    height,
    colorType: 0, // grayscale
    bitDepth: 16,
    inputColorType: 0,
    inputHasAlpha: false
  })
  // pngjs はビッグエンディアン 16bit を期待する。各画素1チャンネル。
  const buf = Buffer.alloc(width * height * 2)
  for (let i = 0; i < values16.length; i++) {
    buf.writeUInt16BE(values16[i], i * 2)
  }
  png.data = buf
  const out = PNG.sync.write(png, { colorType: 0, bitDepth: 16, inputColorType: 0 })
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
 * 3Dプレビュー用に標高フィールドを最大 maxDim 頂点までダウンサンプリングする。
 * （フル解像度をそのままGPUへ送ると重いため）
 */
export function buildMeshData(hf: HeightField, maxDim = 256): MeshData {
  const scale = Math.max(1, Math.ceil(Math.max(hf.width, hf.height) / maxDim))
  const cols = Math.max(2, Math.floor(hf.width / scale))
  const rows = Math.max(2, Math.floor(hf.height / scale))
  const heights = new Float32Array(cols * rows)

  for (let r = 0; r < rows; r++) {
    const sy = Math.min(hf.height - 1, Math.floor((r / (rows - 1)) * (hf.height - 1)))
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(hf.width - 1, Math.floor((c / (cols - 1)) * (hf.width - 1)))
      heights[r * cols + c] = hf.data[sy * hf.width + sx]
    }
  }

  return {
    cols,
    rows,
    heights,
    minEle: hf.minEle,
    maxEle: hf.maxEle,
    aspect: hf.width / hf.height
  }
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
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / maxDim))
  const cols = Math.max(2, Math.floor(width / scale))
  const rows = Math.max(2, Math.floor(height / scale))
  const heights = new Float32Array(cols * rows)

  for (let r = 0; r < rows; r++) {
    const sy = Math.min(height - 1, Math.floor((r / (rows - 1)) * (height - 1)))
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(width - 1, Math.floor((c / (cols - 1)) * (width - 1)))
      const v = values16[sy * width + sx]
      heights[r * cols + c] = minEle + (v / 65535) * span
    }
  }

  return { cols, rows, heights, minEle, maxEle, aspect: width / height }
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
