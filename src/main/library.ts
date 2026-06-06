// ワークスペース管理。
//
// 「ワークスペース」が最上位の入れ物で、ハイトマップ（地形）と地点（ランドマーク）を持つ。
// ハイトマップはワークスペース内で更新（再生成・差し替え）でき、地点は lng/lat で保持されるため
// 地形を更新しても残る。
//
// 保存レイアウト（data/<id>/）:
//   workspace.json   … メタ（名前・作成日・order）＋ heightmap メタ ＋ landmarks
//   heightmap.u16    … 全解像度の正規化16bit値（Uint16, LE）= 地形の真実
//   preview.png      … 2Dタブ用の8bitプレビュー
//   satellite.png    … 衛星テクスチャ（任意）
//
// 旧フラット構成（data/library.json + <id>.u16 等）は起動時に自動でフォルダへ移行する。
import { promises as fs } from 'fs'
import { join } from 'path'
import type { BBox } from './tiles'
import type { ZipEntry } from './zip'

const WS_FILE = 'workspace.json'
const U16_FILE = 'heightmap.u16'
const PREVIEW_FILE = 'preview.png'
const SATELLITE_FILE = 'satellite.png'
const LEGACY_INDEX = 'library.json'
const LANDMARK_LIBRARY_FILE = 'landmark-library.json'

/** 地形上のランドマーク（点）。座標は緯度経度で持ち、3D描画時にメッシュ座標へ変換する */
export interface Landmark {
  id: string
  /** 共通ランドマークライブラリから取り込んだ場合の元ID */
  libraryId?: string
  name: string
  lng: number
  lat: number
  /** 標高(メートル)。配置時にハイトマップからサンプリングするが手入力で上書き可 */
  elevation: number
  /** 3Dでの表示 ON/OFF。未設定（undefined）は表示扱い */
  visible?: boolean
}

/** 複数ロケーションで共有するランドマーク定義 */
export interface LandmarkLibraryEntry {
  id: string
  name: string
  lng: number
  lat: number
  elevation?: number
  category?: string
  source?: string
  confidence?: 'high' | 'medium' | 'low'
  notes?: string
}

/** ルート（OSM等から取り込んだライン）の種別 */
export type RouteCategory = 'road' | 'foot' | 'trail' | 'rail' | 'aerialway'

/** 地形上のルート（折れ線）。座標は lng/lat で持ち、地形を更新しても残る */
export interface Route {
  id: string
  name: string
  category: RouteCategory
  /** 取り込み元 OSM の way id（重複排除・出典用。手描き等では undefined） */
  osmId?: number
  /** [lng, lat] の折れ線 */
  coords: [number, number][]
  /** 表示 ON/OFF。未設定（undefined）は表示扱い */
  visible?: boolean
}

/** ワークスペースが現在保持するハイトマップ（地形）のメタ情報 */
export interface HeightmapMeta {
  bbox: BBox
  zoom: number
  sourceId: string
  width: number
  height: number
  minEle: number
  maxEle: number
  /** 衛星テクスチャ（satellite.png）を保存しているか */
  hasSatellite?: boolean
  /** 地形を生成/更新した日時 */
  updatedAt: number
}

/** 最上位の入れ物。ハイトマップ1つと地点群を持つ */
export interface Workspace {
  id: string
  name: string
  createdAt: number
  /** 手動並べ替え後の表示順（小さいほど上）。未設定なら createdAt 降順 */
  order?: number
  heightmap: HeightmapMeta
  landmarks: Landmark[]
  /** 地形上のルート（OSM 取り込み等）。未設定なら空扱い */
  routes: Route[]
}

function wsDir(dir: string, id: string): string {
  return join(dir, id)
}
function wsJsonPath(dir: string, id: string): string {
  return join(dir, id, WS_FILE)
}
function u16Path(dir: string, id: string): string {
  return join(dir, id, U16_FILE)
}
function previewPath(dir: string, id: string): string {
  return join(dir, id, PREVIEW_FILE)
}
function satellitePath(dir: string, id: string): string {
  return join(dir, id, SATELLITE_FILE)
}
function landmarkLibraryPath(dir: string): string {
  return join(dir, LANDMARK_LIBRARY_FILE)
}

const DEFAULT_LANDMARK_LIBRARY: LandmarkLibraryEntry[] = [
  {
    id: 'sakuradaira_parking_upper',
    name: '桜平駐車場（上）',
    lng: 138.33611,
    lat: 36.01,
    elevation: 1920,
    category: 'parking',
    source: 'YAMAP model course Google Map link; 登山口P; O-ren hut guide; DEM checked',
    confidence: 'high',
    notes: '桜平駐車場の上。登山口P掲載の 36°00′36″/138°20′10″ と既存DEMで確認。'
  },
  {
    id: 'sakuradaira_parking_middle',
    name: '桜平駐車場（中）',
    lng: 138.328956,
    lat: 36.010303,
    elevation: 1840,
    category: 'parking',
    source: 'YAMAP model course Google Map link; 登山口P; O-ren hut guide; DEM checked',
    confidence: 'high',
    notes: '桜平駐車場の中。YAMAPのGoogle Mapリンク座標を基準にし、登山口Pの標高1840mとDEMで確認。'
  },
  {
    id: 'sakuradaira_parking_lower',
    name: '桜平駐車場（下）',
    lng: 138.315039435402,
    lat: 36.0147896423738,
    elevation: 1630,
    category: 'parking',
    source: 'YAMAP model course Google Map link; 登山口P; O-ren hut guide; DEM checked',
    confidence: 'high',
    notes: '桜平駐車場の下。YAMAPのGoogle Mapリンク座標を基準にし、登山口Pの標高1630mとDEMで確認。'
  }
]

async function readWorkspaceFile(dir: string, id: string): Promise<Workspace | null> {
  try {
    const w = JSON.parse(await fs.readFile(wsJsonPath(dir, id), 'utf-8')) as Workspace
    w.landmarks = w.landmarks ?? []
    w.routes = w.routes ?? []
    // 旧種別 'path'（歩道/登山道をまとめていた）は 'foot' に寄せる。
    // 歩道/登山道の正しい振り分けは「種別を再判定」(OSM 再問い合わせ) で行う。
    for (const r of w.routes) {
      if ((r.category as string) === 'path') r.category = 'foot'
    }
    return w
  } catch {
    return null
  }
}

async function writeWorkspaceFile(dir: string, ws: Workspace): Promise<void> {
  await fs.mkdir(wsDir(dir, ws.id), { recursive: true })
  await fs.writeFile(wsJsonPath(dir, ws.id), JSON.stringify(ws, null, 2), 'utf-8')
}

async function ensureLandmarkLibrary(dir: string): Promise<void> {
  try {
    await fs.access(landmarkLibraryPath(dir))
  } catch {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(landmarkLibraryPath(dir), JSON.stringify(DEFAULT_LANDMARK_LIBRARY, null, 2), 'utf-8')
  }
}

export async function readLandmarkLibrary(dir: string): Promise<LandmarkLibraryEntry[]> {
  await ensureLandmarkLibrary(dir)
  try {
    const entries = JSON.parse(await fs.readFile(landmarkLibraryPath(dir), 'utf-8')) as LandmarkLibraryEntry[]
    return entries.filter(
      (e) =>
        typeof e.id === 'string' &&
        typeof e.name === 'string' &&
        typeof e.lng === 'number' &&
        typeof e.lat === 'number'
    )
  } catch {
    return []
  }
}

function containsBBox(bbox: BBox, lng: number, lat: number): boolean {
  return lng >= bbox.west && lng <= bbox.east && lat >= bbox.south && lat <= bbox.north
}

function approxDistanceMeters(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const r = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const lat = toRad((a.lat + b.lat) / 2)
  const dx = toRad(b.lng - a.lng) * Math.cos(lat)
  const dy = toRad(b.lat - a.lat)
  return Math.sqrt(dx * dx + dy * dy) * r
}

export function landmarkAlreadyImported(entry: LandmarkLibraryEntry, landmarks: Landmark[]): boolean {
  return landmarks.some(
    (lm) =>
      lm.libraryId === entry.id ||
      lm.id === `lm_lib_${entry.id}` ||
      (lm.name === entry.name && approxDistanceMeters(lm, entry) < 80)
  )
}

export async function landmarkLibraryCandidates(dir: string, workspaceId: string): Promise<LandmarkLibraryEntry[]> {
  const ws = await readWorkspaceFile(dir, workspaceId)
  if (!ws) return []
  const entries = await readLandmarkLibrary(dir)
  return entries.filter(
    (entry) =>
      containsBBox(ws.heightmap.bbox, entry.lng, entry.lat) && !landmarkAlreadyImported(entry, ws.landmarks)
  )
}

async function writeU16(dir: string, id: string, values16: Uint16Array): Promise<void> {
  const buf = Buffer.from(values16.buffer, values16.byteOffset, values16.byteLength)
  await fs.writeFile(u16Path(dir, id), buf)
}

/** 全ワークスペースを一覧する（初回にレガシー構成を移行） */
export async function listWorkspaces(dir: string): Promise<Workspace[]> {
  await migrateLegacy(dir)
  let dirents: import('fs').Dirent[] = []
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Workspace[] = []
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const w = await readWorkspaceFile(dir, d.name)
    if (w) out.push(w)
  }
  const allOrdered = out.length > 0 && out.every((w) => typeof w.order === 'number')
  if (allOrdered) return out.sort((a, b) => a.order! - b.order!)
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getWorkspace(dir: string, id: string): Promise<Workspace | null> {
  return readWorkspaceFile(dir, id)
}

/** 新規ワークスペースを作成（地形データ＋メタを書き込む） */
export async function createWorkspace(
  dir: string,
  ws: Workspace,
  values16: Uint16Array,
  previewPng: Buffer
): Promise<void> {
  // 既存に手動並び順（order）があれば、末尾（最大+1）を付与して並びを保つ
  if (ws.order === undefined) {
    const existing = await listWorkspaces(dir)
    const orders = existing
      .map((e) => e.order)
      .filter((o): o is number => typeof o === 'number')
    if (orders.length) ws.order = Math.max(...orders) + 1
  }
  await fs.mkdir(wsDir(dir, ws.id), { recursive: true })
  await writeU16(dir, ws.id, values16)
  await fs.writeFile(previewPath(dir, ws.id), previewPng)
  await writeWorkspaceFile(dir, ws)
}

/**
 * 既存ワークスペースの地形を更新（上書き）する。landmarks は保持。
 * 古い衛星テクスチャは破棄し hasSatellite を false に戻す（範囲が変わり得るため）。
 */
export async function updateHeightmap(
  dir: string,
  id: string,
  heightmap: HeightmapMeta,
  values16: Uint16Array,
  previewPng: Buffer
): Promise<Workspace | null> {
  const w = await readWorkspaceFile(dir, id)
  if (!w) return null
  await writeU16(dir, id, values16)
  await fs.writeFile(previewPath(dir, id), previewPng)
  await fs.rm(satellitePath(dir, id), { force: true })
  w.heightmap = { ...heightmap, hasSatellite: false }
  await writeWorkspaceFile(dir, w)
  return w
}

/** 合成済み衛星 PNG を保存し、hasSatellite を立てる */
export async function saveSatellite(dir: string, id: string, png: Buffer): Promise<void> {
  const w = await readWorkspaceFile(dir, id)
  if (!w) return
  await fs.writeFile(satellitePath(dir, id), png)
  w.heightmap.hasSatellite = true
  await writeWorkspaceFile(dir, w)
}

export async function renameWorkspace(dir: string, id: string, name: string): Promise<boolean> {
  const w = await readWorkspaceFile(dir, id)
  if (!w) return false
  w.name = name
  await writeWorkspaceFile(dir, w)
  return true
}

export async function deleteWorkspace(dir: string, id: string): Promise<boolean> {
  try {
    await fs.rm(wsDir(dir, id), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 表示順を id 配列の順に保存する */
export async function reorderWorkspaces(dir: string, ids: string[]): Promise<boolean> {
  for (let i = 0; i < ids.length; i++) {
    const w = await readWorkspaceFile(dir, ids[i])
    if (w) {
      w.order = i
      await writeWorkspaceFile(dir, w)
    }
  }
  return true
}

/** ワークスペースのランドマークを保存する */
export async function saveLandmarks(
  dir: string,
  id: string,
  landmarks: Landmark[]
): Promise<boolean> {
  const w = await readWorkspaceFile(dir, id)
  if (!w) return false
  w.landmarks = landmarks
  await writeWorkspaceFile(dir, w)
  return true
}

/** ワークスペースのルートを保存する */
export async function saveRoutes(dir: string, id: string, routes: Route[]): Promise<boolean> {
  const w = await readWorkspaceFile(dir, id)
  if (!w) return false
  w.routes = routes
  await writeWorkspaceFile(dir, w)
  return true
}

/** ワークスペースの全解像度 16bit 値を読み出す */
export async function readValues16(dir: string, id: string): Promise<Uint16Array> {
  const buf = await fs.readFile(u16Path(dir, id))
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

/**
 * ワークスペースのフォルダ内容を ZIP エントリ配列として読み出す（バックアップ用）。
 * 任意ファイル（satellite.png 等）は存在するものだけ含める。
 */
export async function readWorkspaceEntries(dir: string, id: string): Promise<ZipEntry[]> {
  if (!(await readWorkspaceFile(dir, id))) throw new Error('ワークスペースが見つかりません。')
  const files = [WS_FILE, U16_FILE, PREVIEW_FILE, SATELLITE_FILE]
  const entries: ZipEntry[] = []
  for (const f of files) {
    try {
      entries.push({ name: f, data: await fs.readFile(join(dir, id, f)) })
    } catch {
      /* 任意ファイルが無ければスキップ */
    }
  }
  return entries
}

/**
 * ZIP から取り出したエントリ群を「新しいワークスペース」として取り込む（復元）。
 * 既存と衝突しないよう id は採番し直し、表示順は末尾に置く。
 * 想定外のパス（zip slip）を防ぐため、既知のファイル名だけを書き出す。
 */
export async function importWorkspaceEntries(dir: string, entries: ZipEntry[]): Promise<Workspace> {
  const wsEntry = entries.find((e) => e.name === WS_FILE)
  if (!wsEntry) {
    throw new Error('workspace.json が見つかりません。正しいバックアップ ZIP ではありません。')
  }
  let ws: Workspace
  try {
    ws = JSON.parse(wsEntry.data.toString('utf-8')) as Workspace
  } catch {
    throw new Error('workspace.json の解析に失敗しました。')
  }
  if (!ws.heightmap) throw new Error('workspace.json に heightmap 情報がありません。')
  if (!entries.some((e) => e.name === U16_FILE)) {
    throw new Error('heightmap.u16 が見つかりません。')
  }

  // 新しい id を採番（時刻＋乱数で衝突回避）。order は末尾へ。
  const newId = `ws_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
  ws.id = newId
  ws.landmarks = ws.landmarks ?? []
  ws.routes = ws.routes ?? []
  const existing = await listWorkspaces(dir)
  const orders = existing.map((e) => e.order).filter((o): o is number => typeof o === 'number')
  ws.order = orders.length ? Math.max(...orders) + 1 : existing.length

  await fs.mkdir(wsDir(dir, newId), { recursive: true })
  // データファイルはそのまま書き出し。workspace.json は id を更新した内容で別途書く。
  const allowed = [U16_FILE, PREVIEW_FILE, SATELLITE_FILE]
  for (const e of entries) {
    if (!allowed.includes(e.name)) continue
    await fs.writeFile(join(dir, newId, e.name), e.data)
  }
  await writeWorkspaceFile(dir, ws)
  return ws
}

async function moveIfExists(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch {
    /* 元ファイルが無ければ無視 */
  }
}

/**
 * 旧フラット構成（data/library.json + <id>.u16 / .preview.png / .satellite.png / .annotations.json）
 * を data/<id>/ フォルダ構成へ移行する。library.json が無ければ何もしない（移行済み）。
 */
async function migrateLegacy(dir: string): Promise<void> {
  let legacy: Array<{
    id: string
    name: string
    createdAt: number
    order?: number
    bbox: BBox
    zoom: number
    sourceId: string
    width: number
    height: number
    minEle: number
    maxEle: number
    hasSatellite?: boolean
  }>
  try {
    legacy = JSON.parse(await fs.readFile(join(dir, LEGACY_INDEX), 'utf-8'))
  } catch {
    return
  }

  for (const e of legacy) {
    if (await readWorkspaceFile(dir, e.id)) continue // 既に移行済み
    await fs.mkdir(wsDir(dir, e.id), { recursive: true })
    await moveIfExists(join(dir, `${e.id}.u16`), u16Path(dir, e.id))
    await moveIfExists(join(dir, `${e.id}.preview.png`), previewPath(dir, e.id))
    await moveIfExists(join(dir, `${e.id}.satellite.png`), satellitePath(dir, e.id))

    let landmarks: Landmark[] = []
    try {
      const a = JSON.parse(await fs.readFile(join(dir, `${e.id}.annotations.json`), 'utf-8'))
      landmarks = a.landmarks ?? []
    } catch {
      /* 注記なし */
    }
    await fs.rm(join(dir, `${e.id}.annotations.json`), { force: true })

    await writeWorkspaceFile(dir, {
      id: e.id,
      name: e.name,
      createdAt: e.createdAt,
      order: e.order,
      heightmap: {
        bbox: e.bbox,
        zoom: e.zoom,
        sourceId: e.sourceId,
        width: e.width,
        height: e.height,
        minEle: e.minEle,
        maxEle: e.maxEle,
        hasSatellite: e.hasSatellite,
        updatedAt: e.createdAt
      },
      landmarks,
      routes: []
    })
  }
  await fs.rm(join(dir, LEGACY_INDEX), { force: true })
}
