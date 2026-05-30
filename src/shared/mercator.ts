// Web Mercator (slippy map) のピクセル⇔経緯度変換。
// メインプロセス（tiles.ts）とレンダラー（main.ts の解像度推定・スナップ）の
// 両方で同じ式を使うため、ここに集約して共有する。

export const TILE_SIZE = 512 // @2x タイルを使うので 512px

/** 経度 → ピクセルX座標（ズーム z, TILE_SIZE 基準の絶対ピクセル） */
export function lonToPixelX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z) * TILE_SIZE
}

/** 緯度 → ピクセルY座標（Web Mercator） */
export function latToPixelY(lat: number, z: number): number {
  const latRad = (lat * Math.PI) / 180
  const y = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2
  return y * Math.pow(2, z) * TILE_SIZE
}

/** ピクセルX座標 → 経度（lonToPixelX の逆変換） */
export function pixelXToLon(px: number, z: number): number {
  return (px / (Math.pow(2, z) * TILE_SIZE)) * 360 - 180
}

/** ピクセルY座標 → 緯度（latToPixelY の逆変換） */
export function pixelYToLat(px: number, z: number): number {
  const yNorm = px / (Math.pow(2, z) * TILE_SIZE)
  const latRad = Math.atan(Math.sinh((1 - 2 * yNorm) * Math.PI))
  return (latRad * 180) / Math.PI
}
