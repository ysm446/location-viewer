// OSM（OpenStreetMap）から道路・歩道・鉄道などのライン（way）を取得する。
//
// データ元は Overpass API。指定した bbox 内のフィーチャをタグで絞って取得し、
// lng/lat の折れ線（OsmFeature）に変換して返す。ネットワーク・分類・キャッシュは
// すべてメインプロセス側に集約する（tiles.ts と同じ思想）。
//
// ライセンス: 取得データは OpenStreetMap contributors / ODbL。表示時に出典を明記すること。
import type { BBox } from './tiles'
import type { RouteCategory } from './library'

/** 取得した1本のライン。座標は [lng, lat] の配列で持つ */
export interface OsmFeature {
  /** OSM の way id（重複排除・出典用） */
  osmId: number
  name: string
  category: RouteCategory
  coords: [number, number][]
}

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'
const TIMEOUT_MS = 30000
/** 1回の取得で扱う上限（巨大 bbox の暴発を防ぐ） */
const MAX_FEATURES = 8000

/** カテゴリごとの Overpass フィルタ（正規表現は分類と一致させる） */
const ROAD_RE = '^(footway|path|pedestrian|steps|cycleway|bridleway|construction|proposed)$'
const PATH_RE = '^(footway|path|pedestrian|steps|cycleway|bridleway)$'
const RAIL_RE = '^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$'

/** way のタグからカテゴリを判定する（buildQuery のフィルタと対応させる） */
function classify(tags: Record<string, string> | undefined): RouteCategory | null {
  if (!tags) return null
  if (tags.railway && new RegExp(RAIL_RE).test(tags.railway)) return 'rail'
  const hw = tags.highway
  if (!hw) return null
  if (new RegExp(PATH_RE).test(hw)) return 'path'
  if (new RegExp(ROAD_RE).test(hw)) return null // 歩道扱いの highway は road から除外
  return 'road'
}

/** 選択カテゴリから Overpass QL を組み立てる。bbox は (south,west,north,east) */
function buildQuery(bbox: BBox, cats: RouteCategory[]): string {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  const parts: string[] = []
  if (cats.includes('road')) parts.push(`way["highway"]["highway"!~"${ROAD_RE}"](${bb});`)
  if (cats.includes('path')) parts.push(`way["highway"~"${PATH_RE}"](${bb});`)
  if (cats.includes('rail')) parts.push(`way["railway"~"${RAIL_RE}"](${bb});`)
  return `[out:json][timeout:25];(${parts.join('')});out geom;`
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
}

/** bbox と選択カテゴリで OSM のライン群を取得する */
export async function fetchOsmFeatures(bbox: BBox, cats: RouteCategory[]): Promise<OsmFeature[]> {
  if (cats.length === 0) return []
  const query = buildQuery(bbox, cats)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass は User-Agent が無いと 406 を返す。Accept も明示しておく。
        'User-Agent': 'mapbox-importer/0.1 (heightmap tool)',
        Accept: 'application/json'
      },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal
    })
  } catch (e) {
    throw new Error(
      (e as Error).name === 'AbortError'
        ? 'OSM 取得がタイムアウトしました。範囲を狭めて再試行してください。'
        : `OSM 取得に失敗しました: ${(e as Error).message}`
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`OSM 取得に失敗しました（HTTP ${res.status}）。混雑時は少し待って再試行してください。`)
  }

  const json = (await res.json()) as { elements?: OverpassElement[] }
  const elements = json.elements ?? []
  const out: OsmFeature[] = []
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    const category = classify(el.tags)
    if (!category || !cats.includes(category)) continue
    const coords = el.geometry.map((g) => [g.lon, g.lat] as [number, number])
    const tags = el.tags ?? {}
    out.push({ osmId: el.id, name: tags.name ?? tags.ref ?? '', category, coords })
    if (out.length >= MAX_FEATURES) break
  }
  return out
}
