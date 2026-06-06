// Mapbox タイルのダウンロード + 必要タイル範囲・クロップ領域の計算。
// 記事の Mercantile 相当の処理を自前実装している。
// 座標変換式（ピクセル⇔経緯度）は renderer と共有するため shared/mercator.ts に集約。

import { TILE_SIZE, lonToPixelX, latToPixelY } from '../shared/mercator'

// 既存の main 側 import 互換のため再エクスポートする
export { TILE_SIZE, lonToPixelX, latToPixelY }

export interface BBox {
  west: number
  south: number
  east: number
  north: number
}

export interface PixelRegion {
  // 切り出したい範囲の絶対ピクセル座標（z 基準）
  left: number
  top: number
  right: number
  bottom: number
  // それを覆う整数タイル範囲
  tileX0: number
  tileY0: number
  tileX1: number
  tileY1: number
  // 出力画像サイズ（ピクセル）
  outWidth: number
  outHeight: number
}

/** bbox とズームから、必要なタイル範囲と最終クロップ領域を計算する */
export function computeRegion(bbox: BBox, z: number): PixelRegion {
  const left = lonToPixelX(bbox.west, z)
  const right = lonToPixelX(bbox.east, z)
  const top = latToPixelY(bbox.north, z) // 北が上（Yが小さい）
  const bottom = latToPixelY(bbox.south, z)

  const tileX0 = Math.floor(left / TILE_SIZE)
  const tileX1 = Math.floor((right - 1e-6) / TILE_SIZE)
  const tileY0 = Math.floor(top / TILE_SIZE)
  const tileY1 = Math.floor((bottom - 1e-6) / TILE_SIZE)

  return {
    left,
    top,
    right,
    bottom,
    tileX0,
    tileY0,
    tileX1,
    tileY1,
    outWidth: Math.max(1, Math.round(right - left)),
    outHeight: Math.max(1, Math.round(bottom - top))
  }
}

export interface TileSource {
  id: string
  label: string
  maxZoom: number
  /** {z}/{x}/{y} と access_token を埋めて URL を返す */
  url: (z: number, x: number, y: number, token: string) => string
}

export const TILE_SOURCES: Record<string, TileSource> = {
  'terrain-dem': {
    id: 'terrain-dem',
    label: 'Mapbox Terrain-DEM v1 (推奨)',
    maxZoom: 14,
    url: (z, x, y, token) =>
      `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${z}/${x}/${y}@2x.pngraw?access_token=${token}`
  },
  'terrain-rgb': {
    id: 'terrain-rgb',
    label: 'Mapbox Terrain-RGB v1 (旧)',
    maxZoom: 15,
    url: (z, x, y, token) =>
      `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}@2x.pngraw?access_token=${token}`
  },
  satellite: {
    id: 'satellite',
    label: 'Mapbox Satellite',
    maxZoom: 22,
    url: (z, x, y, token) =>
      `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.png?access_token=${token}`
  }
}

export interface DownloadedTile {
  x: number
  y: number
  buffer: Buffer
}

/** タイル範囲を並列ダウンロード（同時実行数を制限） */
export async function downloadTiles(
  source: TileSource,
  region: PixelRegion,
  z: number,
  token: string,
  concurrency = 6,
  onProgress?: (done: number, total: number) => void
): Promise<DownloadedTile[]> {
  const jobs: { x: number; y: number }[] = []
  for (let ty = region.tileY0; ty <= region.tileY1; ty++) {
    for (let tx = region.tileX0; tx <= region.tileX1; tx++) {
      jobs.push({ x: tx, y: ty })
    }
  }

  const total = jobs.length
  let done = 0
  const results: DownloadedTile[] = []

  let cursor = 0
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      const url = source.url(z, job.x, job.y, token)
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(
          `タイル取得失敗 ${job.x},${job.y} (HTTP ${res.status})。トークンやズームを確認してください。`
        )
      }
      const ab = await res.arrayBuffer()
      results.push({ x: job.x, y: job.y, buffer: Buffer.from(ab) })
      done++
      onProgress?.(done, total)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker())
  await Promise.all(workers)
  return results
}
