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

// カテゴリごとの Overpass フィルタ（正規表現は classify と一致させる）。
// 歩道（foot）＝舗装された歩行系、登山道（trail）＝自然路・登山路。
// road から除外したいのは foot/trail に該当する全 highway なので、両者を束ねた式も持つ。
const FOOT_RE = '^(footway|pedestrian|steps|cycleway)$'
const TRAIL_RE = '^(path|bridleway)$'
const FOOTTRAIL_RE = '^(footway|pedestrian|steps|cycleway|path|bridleway|construction|proposed)$'
const RAIL_RE = '^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$'
const AERIALWAY_RE =
  '^(cable_car|gondola|chair_lift|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet|zip_line|goods)$'

/**
 * way のタグからカテゴリを判定する（buildQuery のフィルタと対応させる）。
 * sac_scale（登山難易度）が付くものは歩道扱いの highway でも登山道へ寄せる。
 */
export function classify(tags: Record<string, string> | undefined): RouteCategory | null {
  if (!tags) return null
  if (tags.aerialway && new RegExp(AERIALWAY_RE).test(tags.aerialway)) return 'aerialway'
  if (tags.railway && new RegExp(RAIL_RE).test(tags.railway)) return 'rail'
  const hw = tags.highway
  if (!hw) return null
  const isFoot = new RegExp(FOOT_RE).test(hw)
  const isTrail = new RegExp(TRAIL_RE).test(hw)
  if (isFoot || isTrail) {
    // sac_scale が付けば登山道。それ以外は highway 種別で判定。
    return tags.sac_scale ? 'trail' : isTrail ? 'trail' : 'foot'
  }
  return 'road'
}

/** 選択カテゴリから Overpass QL を組み立てる。bbox は (south,west,north,east) */
function buildQuery(bbox: BBox, cats: RouteCategory[]): string {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  const parts: string[] = []
  if (cats.includes('road')) parts.push(`way["highway"]["highway"!~"${FOOTTRAIL_RE}"](${bb});`)
  if (cats.includes('foot')) parts.push(`way["highway"~"${FOOT_RE}"](${bb});`)
  if (cats.includes('trail')) {
    parts.push(`way["highway"~"${TRAIL_RE}"](${bb});`)
    // sac_scale 付きの歩道系も登山道として拾う（classify が trail へ寄せる）
    parts.push(`way["highway"~"${FOOT_RE}"]["sac_scale"](${bb});`)
  }
  if (cats.includes('rail')) parts.push(`way["railway"~"${RAIL_RE}"](${bb});`)
  if (cats.includes('aerialway')) parts.push(`way["aerialway"~"${AERIALWAY_RE}"](${bb});`)
  return `[out:json][timeout:25];(${parts.join('')});out geom;`
}

/**
 * 線分 a→b を矩形 [minX,maxX]×[minY,maxY] にクリップする（Liang–Barsky）。
 * 可視部分が無ければ null。t0/t1 は元の線分上の媒介変数（端の判定に使う）。
 */
function clipSegment(
  a: [number, number],
  b: [number, number],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): { a2: [number, number]; b2: [number, number]; t0: number; t1: number } | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const p = [-dx, dx, -dy, dy]
  const q = [a[0] - minX, maxX - a[0], a[1] - minY, maxY - a[1]]
  let t0 = 0
  let t1 = 1
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null // 矩形外を平行に進む
    } else {
      const r = q[i] / p[i]
      if (p[i] < 0) {
        if (r > t1) return null
        if (r > t0) t0 = r
      } else {
        if (r < t0) return null
        if (r < t1) t1 = r
      }
    }
  }
  return {
    a2: [a[0] + t0 * dx, a[1] + t0 * dy],
    b2: [a[0] + t1 * dx, a[1] + t1 * dy],
    t0,
    t1
  }
}

/** 折れ線を bbox でクリップし、矩形内に収まる連続区間（複数可）に分割して返す */
function clipPolylineToBBox(coords: [number, number][], bbox: BBox): [number, number][][] {
  const runs: [number, number][][] = []
  let cur: [number, number][] = []
  const pushPt = (pt: [number, number]) => {
    const last = cur[cur.length - 1]
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) cur.push(pt)
  }
  const endRun = () => {
    if (cur.length >= 2) runs.push(cur)
    cur = []
  }
  for (let i = 0; i < coords.length - 1; i++) {
    const seg = clipSegment(coords[i], coords[i + 1], bbox.west, bbox.south, bbox.east, bbox.north)
    if (!seg) {
      endRun() // この区間は完全に外 → 連続が途切れる
      continue
    }
    if (seg.t0 > 0) endRun() // 矩形に入り直した → 直前の連続は切れている
    pushPt(seg.a2)
    pushPt(seg.b2)
    if (seg.t1 < 1) endRun() // 矩形から出た → ここで連続が終わる
  }
  endRun()
  return runs
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
}

/**
 * bbox と選択カテゴリで OSM のライン群を取得する。
 * clip=true のとき、bbox からはみ出た部分を切り落として矩形内の区間に分割する。
 */
export async function fetchOsmFeatures(
  bbox: BBox,
  cats: RouteCategory[],
  clip = true
): Promise<OsmFeature[]> {
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
        'User-Agent': 'location-viewer/0.1',
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
    const name = tags.name ?? tags.ref ?? ''
    // clip=true なら bbox 外を切り落とし、矩形内の連続区間ごとに分割して出力する。
    const segments = clip ? clipPolylineToBBox(coords, bbox) : [coords]
    for (const seg of segments) {
      out.push({ osmId: el.id, name, category, coords: seg })
      if (out.length >= MAX_FEATURES) break
    }
    if (out.length >= MAX_FEATURES) break
  }
  return out
}

/**
 * 保存済みルートの再分類用に、way id 群のタグだけを取得する（ジオメトリ無しで軽量）。
 * 返り値は osmId → タグ の Map。取得できなかった id は欠落する。
 */
export async function fetchOsmTagsByIds(ids: number[]): Promise<Map<number, Record<string, string>>> {
  const map = new Map<number, Record<string, string>>()
  if (ids.length === 0) return map
  const query = `[out:json][timeout:25];way(id:${ids.join(',')});out tags;`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'location-viewer/0.1',
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
  for (const el of json.elements ?? []) {
    if (el.type === 'way') map.set(el.id, el.tags ?? {})
  }
  return map
}
