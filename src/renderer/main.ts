import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import type {
  Api,
  MeshPayload,
  Workspace,
  HeightmapMeta,
  SatelliteTilesPayload,
  Landmark
} from '../preload/index'
import { TerrainViewer } from './viewer3d'
import { t, setLang, getLang, applyDom, type Lang } from './i18n'
import {
  TILE_SIZE as TILE,
  lonToPixelX as lonPx,
  latToPixelY as latPx,
  pixelXToLon as pxLon,
  pixelYToLat as pxLat
} from '../shared/mercator'

// ライブラリ操作のアイコン（インラインSVG, currentColor で配色）
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>'
const ICON_DELETE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'
const ICON_DRAG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>'
const ICON_ENTER =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'

declare global {
  interface Window {
    api: Api
  }
}
const api = window.api

// ---- DOM ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const tokenInput = $<HTMLInputElement>('token')
const tokenStatus = $('token-status')
const sourceSel = $<HTMLSelectElement>('source')
const zoomInput = $<HTMLInputElement>('zoom')
const zoomVal = $('zoom-val')
const westI = $<HTMLInputElement>('west')
const eastI = $<HTMLInputElement>('east')
const southI = $<HTMLInputElement>('south')
const northI = $<HTMLInputElement>('north')
const estimate = $('estimate')
const bboxReadout = $('bbox-readout')
const previewImg = $<HTMLImageElement>('preview')
const previewEmpty = $('preview-empty')
const viewer3dInfo = $('viewer3d-info')
const progress = $('progress')
const btnExportPng = $<HTMLButtonElement>('btn-export-png')
const btnExportRaw = $<HTMLButtonElement>('btn-export-raw')
const btnUpdateTerrain = $<HTMLButtonElement>('btn-update-terrain')
const libList = $<HTMLUListElement>('library-list')
const libCount = $('lib-count')
const selectedInfo = $('selected-info')
const rviewLibraryEl = $('rview-library')
const wsBack = $('ws-back')
const landmarkList = $<HTMLUListElement>('landmark-list')
const landmarkHint = $('landmark-hint')
const btnAddLandmark = $<HTMLButtonElement>('btn-add-landmark')
const chkShowLandmarks = $<HTMLInputElement>('chk-show-landmarks')
chkShowLandmarks.addEventListener('change', () => {
  viewer?.setLandmarksVisible(chkShowLandmarks.checked)
  api.setSettings({ showLandmarks: chkShowLandmarks.checked })
})

/**
 * 右ペインを 一覧⇔詳細 で切り替える。詳細モードでは CSS で選択以外の
 * ワークスペースを隠し、選択行の下に中身（地点等）を表示する。
 */
function showWorkspaceDetail(on: boolean) {
  rviewLibraryEl.classList.toggle('detail', on)
}
wsBack.addEventListener('click', () => {
  setPlaceMode(false)
  showWorkspaceDetail(false)
})

let token = ''
let viewer: TerrainViewer | null = null
let pendingMesh: MeshPayload | null = null // 3Dタブ未生成時の保留データ
let selectedId: string | null = null
// 選択中ワークスペースのランドマーク
let landmarks: Landmark[] = []
let placeMode = false

// ---- 地図 ----
// Mapbox の各スタイルを raster タイルとして読み込む（styles/v1 の tiles エンドポイント）
const MAPBOX_STYLES: Record<string, { id: string; label: string }> = {
  satellite: { id: 'mapbox/satellite-v9', label: '衛星写真' },
  'satellite-streets': { id: 'mapbox/satellite-streets-v12', label: '衛星＋地名' },
  streets: { id: 'mapbox/streets-v12', label: '地図（地名）' },
  outdoors: { id: 'mapbox/outdoors-v12', label: '地形図' }
}
let currentStyleKey = 'satellite'

function makeStyle(tk: string, styleKey: string): maplibregl.StyleSpecification {
  if (tk) {
    const s = MAPBOX_STYLES[styleKey] ?? MAPBOX_STYLES.satellite
    // 地図ラベルを UI 言語に合わせる（衛星のみは地名なしなので影響なし）
    const lang = getLang()
    return {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: [
            `https://api.mapbox.com/styles/v1/${s.id}/tiles/512/{z}/{x}/{y}@2x?language=${lang}&access_token=${tk}`
          ],
          tileSize: 512,
          attribution: '© Mapbox © Maxar'
        }
      },
      layers: [{ id: 'base', type: 'raster', source: 'base' }]
    }
  }
  // トークン未設定時の簡易フォールバック
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap'
      }
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
  }
}

const map = new maplibregl.Map({
  container: 'map',
  style: makeStyle('', currentStyleKey),
  center: [138.7274, 35.3606], // 富士山
  zoom: 11
})
map.addControl(new maplibregl.NavigationControl(), 'bottom-right')

// 中ボタンドラッグでパン（MapLibre 標準にないので自前実装）
;(() => {
  const canvas = map.getCanvas()
  let panning = false
  let lastX = 0
  let lastY = 0
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return // 中ボタンのみ
    e.preventDefault() // 自動スクロール（丸アイコン）を抑止
    panning = true
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = 'grabbing'
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!panning) return
    // ドラッグした分だけ地図を動かす（マウス移動と逆方向に panBy）
    map.panBy([-(e.clientX - lastX), -(e.clientY - lastY)], { duration: 0 })
    lastX = e.clientX
    lastY = e.clientY
  })
  const endPan = () => {
    if (!panning) return
    panning = false
    canvas.style.cursor = ''
  }
  canvas.addEventListener('pointerup', endPan)
  canvas.addEventListener('pointercancel', endPan)
  // 中ボタンの既定のオートスクロール起動を防ぐ
  canvas.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault()
  })
})()

// スタイル切替時に bbox 矩形レイヤーが消えるので、styledata で再描画する
map.on('styledata', () => {
  const b = currentBBox()
  if ([b.west, b.south, b.east, b.north].every((v) => !isNaN(v))) {
    drawBBoxRect(b.west, b.south, b.east, b.north)
  }
})

// 地図スタイル切替（data/settings.json に保存）
const mapStyleSel = $<HTMLSelectElement>('map-style')
mapStyleSel.addEventListener('change', () => {
  currentStyleKey = mapStyleSel.value
  // diff:false で完全リロード（言語パラメータだけの変更でもタイルを再取得させる）
  map.setStyle(makeStyle(token, currentStyleKey), { diff: false })
  api.setSettings({ mapStyle: currentStyleKey })
})

// 言語切替（UI 文言 + 地図ラベル。data/settings.json に保存）
const langSel = $<HTMLSelectElement>('lang-select')
langSel.addEventListener('change', () => {
  const lang = langSel.value as Lang
  setLang(lang)
  refreshDynamicTexts()
  // 地図ラベルも言語に合わせて再読み込み
  // diff:false で完全リロード（言語パラメータだけの変更でもタイルを再取得させる）
  map.setStyle(makeStyle(token, currentStyleKey), { diff: false })
  api.setSettings({ lang })
})

/** data-i18n では扱えない動的テキストを現在言語で更新する */
function refreshDynamicTexts() {
  updateEstimate()
  if (!selectedId) selectedInfo.textContent = t('selected.none')
  refreshLibrary()
  renderLandmarkPanel()
}

// 選択範囲の矩形を描画する（四隅のリサイズ用ハンドルも描画）
function drawBBoxRect(w: number, s: number, e: number, n: number) {
  const poly: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[w, n], [e, n], [e, s], [w, s], [w, n]]] }
  }
  // 四隅ハンドル（corner プロパティで識別）
  const handles: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      { corner: 'nw', lng: w, lat: n },
      { corner: 'ne', lng: e, lat: n },
      { corner: 'se', lng: e, lat: s },
      { corner: 'sw', lng: w, lat: s }
    ].map((c) => ({
      type: 'Feature',
      properties: { corner: c.corner },
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] }
    }))
  }

  const src = map.getSource('bbox') as maplibregl.GeoJSONSource | undefined
  if (src) {
    src.setData(poly)
    ;(map.getSource('bbox-handles') as maplibregl.GeoJSONSource).setData(handles)
  } else {
    map.addSource('bbox', { type: 'geojson', data: poly })
    map.addLayer({
      id: 'bbox-fill',
      type: 'fill',
      source: 'bbox',
      paint: { 'fill-color': '#1177bb', 'fill-opacity': 0.15 }
    })
    map.addLayer({
      id: 'bbox-line',
      type: 'line',
      source: 'bbox',
      paint: { 'line-color': '#3aa0ff', 'line-width': 2 }
    })
    map.addSource('bbox-handles', { type: 'geojson', data: handles })
    map.addLayer({
      id: 'bbox-handles',
      type: 'circle',
      source: 'bbox-handles',
      paint: {
        'circle-radius': 4,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#1177bb',
        'circle-stroke-width': 1.5
      }
    })
  }
}

function currentBBox() {
  return {
    west: parseFloat(westI.value),
    south: parseFloat(southI.value),
    east: parseFloat(eastI.value),
    north: parseFloat(northI.value)
  }
}

function setBBoxFields(w: number, s: number, e: number, n: number) {
  westI.value = w.toFixed(5)
  southI.value = s.toFixed(5)
  eastI.value = e.toFixed(5)
  northI.value = n.toFixed(5)
  bboxReadout.textContent = `W${w.toFixed(3)} S${s.toFixed(3)} E${e.toFixed(3)} N${n.toFixed(3)}`
  drawBBoxRect(w, s, e, n)
  updateEstimate()
}

// ---- 2のべき乗スナップ ----
const snapCheckbox = $<HTMLInputElement>('snap-pow2')
let snapPow2 = false
snapCheckbox.addEventListener('change', () => {
  snapPow2 = snapCheckbox.checked
  // 既に範囲があれば即スナップ（北西を固定）
  const b = currentBBox()
  if (snapPow2 && [b.west, b.south, b.east, b.north].every((v) => !isNaN(v))) {
    const z = parseInt(zoomInput.value)
    const s = snapToPow2(b.west, b.south, b.east, b.north, z, 'w', 'n')
    setBBoxFields(s.west, s.south, s.east, s.north)
  }
  api.setSettings({ snapPow2 })
})

// ---- マウスで矩形を描いて範囲選択 ----
const btnDraw = $<HTMLButtonElement>('btn-draw')
let drawMode = false
let drawStart: maplibregl.LngLat | null = null

function setDrawMode(on: boolean) {
  drawMode = on
  drawStart = null
  btnDraw.classList.toggle('active', on)
  // 描画中は地図のドラッグパンを無効化
  if (on) map.dragPan.disable()
  else map.dragPan.enable()
  map.getCanvas().style.cursor = on ? 'crosshair' : ''
}

btnDraw.addEventListener('click', () => setDrawMode(!drawMode))

map.on('mousedown', (e) => {
  if (!drawMode) return
  drawStart = e.lngLat
})

map.on('mousemove', (e) => {
  if (!drawMode || !drawStart) return
  const w = Math.min(drawStart.lng, e.lngLat.lng)
  const east = Math.max(drawStart.lng, e.lngLat.lng)
  const s = Math.min(drawStart.lat, e.lngLat.lat)
  const n = Math.max(drawStart.lat, e.lngLat.lat)
  drawBBoxRect(w, s, east, n)
})

map.on('mouseup', (e) => {
  if (!drawMode || !drawStart) return
  const w = Math.min(drawStart.lng, e.lngLat.lng)
  const east = Math.max(drawStart.lng, e.lngLat.lng)
  const s = Math.min(drawStart.lat, e.lngLat.lat)
  const n = Math.max(drawStart.lat, e.lngLat.lat)
  // クリックだけ（ドラッグなし）の誤操作を無視
  if (Math.abs(east - w) > 1e-5 && Math.abs(n - s) > 1e-5) {
    if (snapPow2) {
      // 描き始めの角を固定してスナップ
      const ax = drawStart.lng <= e.lngLat.lng ? 'w' : 'e'
      const ay = drawStart.lat >= e.lngLat.lat ? 'n' : 's'
      const z = parseInt(zoomInput.value)
      const sp = snapToPow2(w, s, east, n, z, ax, ay)
      setBBoxFields(sp.west, sp.south, sp.east, sp.north)
    } else {
      setBBoxFields(w, s, east, n)
    }
  }
  setDrawMode(false) // 1回描いたら通常モードに戻す
})

// ---- 四隅ハンドルをドラッグして矩形をリサイズ ----
let dragCorner: string | null = null

// 角に応じた斜めリサイズカーソル（NW/SE=↖↘ / NE/SW=↗↙）
function cornerCursor(corner?: string): string {
  return corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize'
}

// ハンドルにカーソルを乗せたら、その角の向きの斜め矢印にする
map.on('mousemove', 'bbox-handles', (e) => {
  if (drawMode || dragCorner) return
  const corner = e.features?.[0]?.properties?.corner as string | undefined
  map.getCanvas().style.cursor = cornerCursor(corner)
})
map.on('mouseleave', 'bbox-handles', () => {
  if (!drawMode && !dragCorner) map.getCanvas().style.cursor = ''
})

map.on('mousedown', 'bbox-handles', (e) => {
  if (drawMode) return
  const f = e.features?.[0]
  if (!f) return
  dragCorner = f.properties?.corner as string
  map.dragPan.disable() // 地図移動を止めてハンドルだけ動かす
  e.preventDefault()
})

map.on('mousemove', (e) => {
  if (!dragCorner) return
  map.getCanvas().style.cursor = cornerCursor(dragCorner) // ドラッグ中も斜め矢印を維持
  const b = currentBBox()
  // ドラッグ中の角の経度・緯度を更新（反対側の角は固定）
  let { west, south, east, north } = b
  if (dragCorner.includes('w')) west = e.lngLat.lng
  if (dragCorner.includes('e')) east = e.lngLat.lng
  if (dragCorner.includes('n')) north = e.lngLat.lat
  if (dragCorner.includes('s')) south = e.lngLat.lat
  // 左右・上下が反転しても破綻しないよう min/max で正規化
  setBBoxFields(
    Math.min(west, east),
    Math.min(south, north),
    Math.max(west, east),
    Math.max(south, north)
  )
})

map.on('mouseup', () => {
  if (!dragCorner) return
  // 離した時にスナップ（動かした角の反対側を固定）
  if (snapPow2) {
    const b = currentBBox()
    const ax = dragCorner.includes('w') ? 'e' : 'w'
    const ay = dragCorner.includes('n') ? 's' : 'n'
    const z = parseInt(zoomInput.value)
    const sp = snapToPow2(b.west, b.south, b.east, b.north, z, ax, ay)
    setBBoxFields(sp.west, sp.south, sp.east, sp.north)
  }
  dragCorner = null
  map.dragPan.enable()
  map.getCanvas().style.cursor = ''
})

// ---- 矩形本体（塗り）を左ドラッグして全体移動 ----
// サイズは変えずに平行移動するので、2のべき乗サイズも保たれる。
let movingBox = false
let moveLast: maplibregl.LngLat | null = null

map.on('mouseenter', 'bbox-fill', () => {
  if (!drawMode && !dragCorner) map.getCanvas().style.cursor = 'grab'
})
map.on('mouseleave', 'bbox-fill', () => {
  if (!drawMode && !dragCorner && !movingBox) map.getCanvas().style.cursor = ''
})

map.on('mousedown', 'bbox-fill', (e) => {
  if (drawMode || dragCorner) return
  if (e.originalEvent.button !== 0) return // 左ボタンのみ
  movingBox = true
  moveLast = e.lngLat
  map.dragPan.disable() // 地図のパンを止めて矩形だけ動かす
  map.getCanvas().style.cursor = 'grabbing'
  e.preventDefault()
})

map.on('mousemove', (e) => {
  if (!movingBox || !moveLast) return
  const dLng = e.lngLat.lng - moveLast.lng
  const dLat = e.lngLat.lat - moveLast.lat
  const b = currentBBox()
  setBBoxFields(b.west + dLng, b.south + dLat, b.east + dLng, b.north + dLat)
  moveLast = e.lngLat
})

map.on('mouseup', () => {
  if (!movingBox) return
  // 2のべき乗モード時は、離した位置でタイル境界へ吸着（サイズは維持）
  if (snapPow2) {
    const b = currentBBox()
    const z = parseInt(zoomInput.value)
    const sp = snapOriginToTile(b.west, b.south, b.east, b.north, z)
    setBBoxFields(sp.west, sp.south, sp.east, sp.north)
  }
  movingBox = false
  moveLast = null
  map.dragPan.enable()
  map.getCanvas().style.cursor = ''
})

for (const el of [westI, eastI, southI, northI]) {
  el.addEventListener('change', () => {
    const b = currentBBox()
    if ([b.west, b.south, b.east, b.north].every((v) => !isNaN(v))) {
      drawBBoxRect(b.west, b.south, b.east, b.north)
      updateEstimate()
    }
  })
}

// ---- 解像度の推定（座標変換は shared/mercator.ts を使用） ----

/** 最も近い 2 のべき乗に丸める（最小32px） */
function nearestPow2(px: number): number {
  if (px < 1) return 32
  const p = Math.round(Math.log2(px))
  return Math.max(32, 2 ** p)
}

/**
 * 出力ピクセルが 2 のべき乗になるよう bbox を調整する。
 * anchorX/anchorY が固定する辺（'w'/'e', 'n'/'s'）。
 */
function snapToPow2(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number,
  anchorX: 'w' | 'e',
  anchorY: 'n' | 's'
) {
  const tW = nearestPow2(lonPx(east, z) - lonPx(west, z))
  if (anchorX === 'w') east = pxLon(lonPx(west, z) + tW, z)
  else west = pxLon(lonPx(east, z) - tW, z)

  const tH = nearestPow2(latPx(south, z) - latPx(north, z))
  if (anchorY === 'n') south = pxLat(latPx(north, z) + tH, z)
  else north = pxLat(latPx(south, z) - tH, z)

  return { west, south, east, north }
}

/**
 * サイズを変えずに、北西角をタイル境界（TILE px の倍数）へスナップする。
 * 移動時に呼ぶと、矩形がタイルグリッドに吸着する。
 */
function snapOriginToTile(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number
) {
  const pxW = lonPx(east, z) - lonPx(west, z)
  const pxH = latPx(south, z) - latPx(north, z)
  const left = Math.round(lonPx(west, z) / TILE) * TILE
  const top = Math.round(latPx(north, z) / TILE) * TILE
  return {
    west: pxLon(left, z),
    north: pxLat(top, z),
    east: pxLon(left + pxW, z),
    south: pxLat(top + pxH, z)
  }
}
function updateEstimate() {
  const b = currentBBox()
  const z = parseInt(zoomInput.value)
  if ([b.west, b.south, b.east, b.north].some((v) => isNaN(v))) {
    estimate.textContent = t('estimate.needRange')
    return
  }
  const w = Math.round(lonPx(b.east, z) - lonPx(b.west, z))
  const h = Math.round(latPx(b.south, z) - latPx(b.north, z))
  const tx = Math.floor(lonPx(b.east, z) / TILE) - Math.floor(lonPx(b.west, z) / TILE) + 1
  const ty = Math.floor(latPx(b.south, z) / TILE) - Math.floor(latPx(b.north, z) / TILE) + 1
  const tiles = tx * ty
  const mpx = ((w * h) / 1e6).toFixed(1)
  // 地表の実距離（km）。東西は中央緯度に沿った長さ。
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const midLat = (b.north + b.south) / 2
  const wkm = R * Math.cos(toRad(midLat)) * toRad(b.east - b.west)
  const hkm = R * toRad(b.north - b.south)
  const km = `${Math.abs(wkm).toFixed(1)}×${Math.abs(hkm).toFixed(1)}km`
  const warn = tiles > 400 ? ' ' + t('estimate.tileOver') : ''
  estimate.textContent = `${t('estimate.output')} ${km} / ${w}×${h}px (${mpx}MP) / ${tiles} ${t(
    'gen.tiles'
  )}${warn}`
}

zoomInput.addEventListener('input', () => {
  zoomVal.textContent = zoomInput.value
  updateEstimate()
})

// 標高ソースごとの最大ズーム（Terrain-DEM は z14 まで、Terrain-RGB は z18 まで）
const SOURCE_MAX_ZOOM: Record<string, number> = {
  'terrain-dem': 14,
  'terrain-rgb': 18
}
function applySourceMaxZoom() {
  const max = SOURCE_MAX_ZOOM[sourceSel.value] ?? 14
  zoomInput.max = String(max)
  if (parseInt(zoomInput.value) > max) {
    zoomInput.value = String(max)
    zoomVal.textContent = zoomInput.value
    updateEstimate()
  }
}
sourceSel.addEventListener('change', applySourceMaxZoom)

// ---- トークン ----
$('btn-save-token').addEventListener('click', async () => {
  token = tokenInput.value.trim()
  await api.setToken(token)
  tokenStatus.textContent = token ? t('token.saved') : t('token.empty')
  // diff:false で完全リロード（言語パラメータだけの変更でもタイルを再取得させる）
  map.setStyle(makeStyle(token, currentStyleKey), { diff: false })
})

// ---- 左タブ（位置選択 / 2D / 3D） ----
const tabMap = $<HTMLButtonElement>('tab-map')
const tab2d = $<HTMLButtonElement>('tab-2d')
const tab3d = $<HTMLButtonElement>('tab-3d')
const viewMap = $('view-map')
const view2d = $('view-2d')
const view3d = $('view-3d')

function showTab(which: 'map' | '2d' | '3d') {
  tabMap.classList.toggle('active', which === 'map')
  tab2d.classList.toggle('active', which === '2d')
  tab3d.classList.toggle('active', which === '3d')
  viewMap.classList.toggle('hidden', which !== 'map')
  view2d.classList.toggle('hidden', which !== '2d')
  view3d.classList.toggle('hidden', which !== '3d')

  if (which === 'map') {
    // 非表示中にサイズが変わっているので再計算
    setTimeout(() => map.resize(), 0)
  }
  if (which === '2d') {
    // 表示直後はラップのサイズが確定するのでフィットし直す
    setTimeout(() => fitPreview(), 0)
  }
  if (which === '3d') {
    if (!viewer) {
      viewer = new TerrainViewer($('viewer3d'))
      viewer.setLandmarkMoveHandler(onMoveLandmark)
      viewer.setLandmarksVisible(chkShowLandmarks.checked)
      viewer.setRenderMode(renderModeSel.value as 'default' | 'heightmap' | 'satellite')
    }
    if (pendingMesh) {
      viewer.setSatelliteTexture(pendingSatellite)
      viewer.setData(pendingMesh)
      pendingMesh = null
      pendingSatellite = null
    }
    viewer.setLandmarks(landmarks) // 初回生成時にも反映
  }
}
tabMap.addEventListener('click', () => showTab('map'))
tab2d.addEventListener('click', () => showTab('2d'))
tab3d.addEventListener('click', () => showTab('3d'))

// ---- 右タブ（ライブラリ / 環境設定） ----
const rtabLibrary = $<HTMLButtonElement>('rtab-library')
const rtabSettings = $<HTMLButtonElement>('rtab-settings')
const rviewLibrary = $('rview-library')
const rviewSettings = $('rview-settings')

function showRightTab(which: 'library' | 'settings') {
  rtabLibrary.classList.toggle('active', which === 'library')
  rtabSettings.classList.toggle('active', which === 'settings')
  rviewLibrary.classList.toggle('hidden', which !== 'library')
  rviewSettings.classList.toggle('hidden', which !== 'settings')
}
rtabLibrary.addEventListener('click', () => showRightTab('library'))
rtabSettings.addEventListener('click', () => showRightTab('settings'))

// ---- 2D プレビューのズーム/パン ----
const previewWrap = $('preview-2d-wrap')
let pvScale = 1
let pvTx = 0
let pvTy = 0

function applyPreviewTransform() {
  previewImg.style.transform = `translate(${pvTx}px, ${pvTy}px) scale(${pvScale})`
}

/** 画像をラップ内に収まるよう中央フィット */
function fitPreview() {
  const iw = previewImg.naturalWidth
  const ih = previewImg.naturalHeight
  if (!iw || !ih) return
  const ww = previewWrap.clientWidth
  const wh = previewWrap.clientHeight
  pvScale = Math.min(ww / iw, wh / ih)
  pvTx = (ww - iw * pvScale) / 2
  pvTy = (wh - ih * pvScale) / 2
  applyPreviewTransform()
}

previewImg.addEventListener('load', () => fitPreview())

previewWrap.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (!previewImg.naturalWidth) return
  const rect = previewWrap.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
  const next = Math.max(0.05, Math.min(40, pvScale * factor))
  // カーソル位置を基点にズーム
  pvTx = cx - ((cx - pvTx) * next) / pvScale
  pvTy = cy - ((cy - pvTy) * next) / pvScale
  pvScale = next
  applyPreviewTransform()
})

let pvDragging = false
let pvLastX = 0
let pvLastY = 0
previewWrap.addEventListener('pointerdown', (e) => {
  if (!previewImg.naturalWidth) return
  pvDragging = true
  pvLastX = e.clientX
  pvLastY = e.clientY
  previewWrap.classList.add('dragging')
  previewWrap.setPointerCapture(e.pointerId)
})
previewWrap.addEventListener('pointermove', (e) => {
  if (!pvDragging) return
  pvTx += e.clientX - pvLastX
  pvTy += e.clientY - pvLastY
  pvLastX = e.clientX
  pvLastY = e.clientY
  applyPreviewTransform()
})
const endPvDrag = () => {
  pvDragging = false
  previewWrap.classList.remove('dragging')
}
previewWrap.addEventListener('pointerup', endPvDrag)
previewWrap.addEventListener('pointercancel', endPvDrag)
// ダブルクリックでフィットに戻す
previewWrap.addEventListener('dblclick', () => fitPreview())

const renderModeSel = $<HTMLSelectElement>('render-mode')
renderModeSel.addEventListener('change', () => {
  const mode = renderModeSel.value as 'default' | 'heightmap' | 'satellite'
  viewer?.setRenderMode(mode)
  api.setSettings({ renderMode: mode })
})

// ---- プレビュー表示の共通処理 ----
// 直近に選択したアイテムの衛星テクスチャ（3Dタブ初回表示時に適用するため保持）
let pendingSatellite: string | null = null

function showPreview(
  previewDataUrl: string,
  satelliteDataUrl: string | null,
  mesh: MeshPayload,
  workspace: Workspace
) {
  previewImg.src = previewDataUrl
  previewImg.style.display = 'block'
  previewEmpty.style.display = 'none'

  // 3D: ビューワが既にあれば即反映、なければ次に3Dタブを開いた時に反映
  if (viewer) {
    viewer.setSatelliteTexture(satelliteDataUrl)
    viewer.setData(mesh)
  } else {
    pendingMesh = mesh
    pendingSatellite = satelliteDataUrl
  }

  selectedId = workspace.id
  const h = workspace.heightmap
  const satMark = satelliteDataUrl ? ` / ${t('view3d.satellite')}` : ''
  selectedInfo.textContent = `${h.width}×${h.height}px / ${h.minEle.toFixed(1)}〜${h.maxEle.toFixed(
    1
  )}m${satMark}`
  btnExportPng.disabled = false
  btnExportRaw.disabled = false
  btnUpdateTerrain.disabled = false
  markSelected()

  // 3Dビューポート上の寸法情報を更新
  updateViewer3dInfo(mesh, h)

  // このワークスペースのランドマークを反映（詳細モードへは入らない＝選択のみ）
  setPlaceMode(false)
  landmarks = workspace.landmarks
  viewer?.setLandmarks(landmarks)
  renderLandmarkPanel()
}

/** ワークスペースの中（詳細モード）へ入る。未選択なら先に読み込む */
async function enterWorkspace(id: string) {
  if (selectedId !== id) await selectItem(id)
  showWorkspaceDetail(true)
}

/** 3Dビューポート左上に 縦横(km) / 高さ(標高差) / px を表示する */
function updateViewer3dInfo(mesh: MeshPayload, h: HeightmapMeta) {
  const wKm = mesh.widthMeters / 1000
  const hKm = mesh.heightMeters / 1000
  const relief = mesh.maxEle - mesh.minEle // 標高差（高さ=長さ）
  viewer3dInfo.innerHTML =
    `<div>${t('view3d.size')}: ${wKm.toFixed(2)} × ${hKm.toFixed(2)} km</div>` +
    `<div>${t('view3d.height')}: ${relief.toFixed(0)} m (${(relief / 1000).toFixed(2)} km)</div>` +
    `<div>${t('view3d.elevation')}: ${mesh.minEle.toFixed(0)} 〜 ${mesh.maxEle.toFixed(0)} m</div>` +
    `<div>${t('view3d.pixels')}: ${h.width} × ${h.height} px</div>`
}

// ---- ランドマーク ----
/** 選択が無くなったときにランドマーク表示をクリアする */
function clearAnnotations() {
  setPlaceMode(false)
  landmarks = []
  viewer?.setLandmarks([])
  showWorkspaceDetail(false)
  renderLandmarkPanel()
}

async function saveLandmarks() {
  if (selectedId) await api.saveLandmarks(selectedId, landmarks)
}

function setPlaceMode(on: boolean) {
  placeMode = on && !!selectedId
  btnAddLandmark.classList.toggle('active', placeMode)
  landmarkHint.hidden = !placeMode
  viewer?.setPlaceMode(placeMode, onPlaceLandmark)
}

/** 3Dクリックで地点が打たれたとき：標高をサンプリングして追加・保存 */
async function onPlaceLandmark(lng: number, lat: number) {
  if (!selectedId) return
  const ele = (await api.sampleElevation(selectedId, lng, lat)) ?? 0
  landmarks.push({
    id: `lm_${Date.now().toString(36)}`,
    name: `${t('landmark.defaultName')} ${landmarks.length + 1}`,
    lng,
    lat,
    elevation: ele
  })
  await saveLandmarks()
  viewer?.setLandmarks(landmarks)
  renderLandmarkPanel()
}

btnAddLandmark.addEventListener('click', () => {
  if (!selectedId) return
  showTab('3d') // 配置は3Dビューで行う
  setPlaceMode(!placeMode)
})

/** 3Dで地点をドラッグ移動して確定したとき：標高を取り直して保存 */
async function onMoveLandmark(id: string, lng: number, lat: number) {
  if (!selectedId) return
  const lm = landmarks.find((x) => x.id === id)
  if (!lm) return
  lm.lng = lng
  lm.lat = lat
  const ele = await api.sampleElevation(selectedId, lng, lat)
  if (ele != null) lm.elevation = ele
  await saveLandmarks()
  viewer?.setLandmarks(landmarks)
  renderLandmarkPanel()
}

/** 右ペインのランドマーク編集パネルを描画する */
function renderLandmarkPanel() {
  landmarkList.innerHTML = ''
  for (const lm of landmarks) {
    const li = document.createElement('li')
    li.className = 'lm-item'

    const top = document.createElement('div')
    top.className = 'lm-top'
    // 個別の表示/非表示チェックボックス
    const vis = document.createElement('input')
    vis.type = 'checkbox'
    vis.className = 'lm-vis'
    vis.checked = lm.visible !== false
    vis.title = t('landmark.show')
    vis.addEventListener('change', async () => {
      lm.visible = vis.checked
      await saveLandmarks()
      viewer?.setLandmarks(landmarks)
    })
    const name = document.createElement('input')
    name.className = 'lm-name'
    name.value = lm.name
    name.addEventListener('change', async () => {
      lm.name = name.value
      await saveLandmarks()
      viewer?.setLandmarks(landmarks)
    })
    const del = document.createElement('button')
    del.className = 'lib-icon lib-del'
    del.innerHTML = ICON_DELETE
    del.title = t('lib.delete')
    del.setAttribute('aria-label', t('lib.delete'))
    del.addEventListener('click', async () => {
      landmarks = landmarks.filter((x) => x.id !== lm.id)
      await saveLandmarks()
      viewer?.setLandmarks(landmarks)
      renderLandmarkPanel()
    })
    top.append(vis, name, del)

    const coords = document.createElement('div')
    coords.className = 'lm-coords'
    const mkNum = (label: string, val: number, step: string, on: (v: number) => void) => {
      const wrap = document.createElement('label')
      wrap.textContent = label
      const inp = document.createElement('input')
      inp.type = 'number'
      inp.step = step
      inp.value = String(val)
      inp.addEventListener('change', async () => {
        const v = parseFloat(inp.value)
        if (isNaN(v)) return
        on(v)
        await saveLandmarks()
        viewer?.setLandmarks(landmarks)
      })
      wrap.appendChild(inp)
      return wrap
    }
    coords.append(
      mkNum('lat', lm.lat, '0.00001', (v) => (lm.lat = v)),
      mkNum('lon', lm.lng, '0.00001', (v) => (lm.lng = v)),
      mkNum(t('landmark.elev'), lm.elevation, '1', (v) => (lm.elevation = v))
    )

    li.append(top, coords)
    landmarkList.appendChild(li)
  }
}

// ---- 生成 ----
api.onProgress((p) => {
  progress.textContent = `${t('gen.downloading')} ${p.done}/${p.total} ${t('gen.tiles')}`
})

/** 衛星画像を取得・合成して保存し、選択中なら 3D に反映する（失敗は無視） */
async function fetchAndSaveSatellite(wsId: string, bbox: ReturnType<typeof currentBBox>, zoom: number) {
  try {
    progress.textContent = t('gen.fetchingSatellite')
    const sat = await api.fetchSatellite(bbox, zoom)
    const pngDataUrl = await compositeSatellite(sat)
    await api.saveSatellite(wsId, pngDataUrl)
    if (selectedId === wsId) {
      viewer?.setSatelliteTexture(pngDataUrl)
    }
    progress.textContent = t('gen.doneWithSatellite')
  } catch (e) {
    progress.textContent = t('gen.doneNoSatellite') + (e as Error).message
  }
}

// 新規ワークスペース作成（地形を生成）
$('btn-generate').addEventListener('click', async () => {
  const b = currentBBox()
  if ([b.west, b.south, b.east, b.north].some((v) => isNaN(v))) {
    alert(t('alert.selectRange'))
    return
  }
  if (!token) {
    alert(t('alert.saveToken'))
    return
  }
  progress.textContent = t('gen.preparing')
  try {
    const zoom = parseInt(zoomInput.value)
    const res = await api.createWorkspace({ bbox: b, zoom, sourceId: sourceSel.value })
    showPreview(res.previewDataUrl, null, res.mesh, res.workspace)
    showWorkspaceDetail(true) // 生成直後はその中へ
    progress.textContent = `${res.tileCount} ${t('gen.tiles')} — ${t('gen.savedToData')}`
    await refreshLibrary()
    showTab('3d') // 生成後は3Dで確認
    await fetchAndSaveSatellite(res.workspace.id, b, zoom)
  } catch (err) {
    progress.textContent = ''
    alert(t('gen.failed') + (err as Error).message)
  }
})

// 選択中ワークスペースの地形を更新（現在の範囲・ズーム・ソースで再生成。地点は保持）
btnUpdateTerrain.addEventListener('click', async () => {
  if (!selectedId) return
  const b = currentBBox()
  if ([b.west, b.south, b.east, b.north].some((v) => isNaN(v))) {
    alert(t('alert.selectRange'))
    return
  }
  if (!token) {
    alert(t('alert.saveToken'))
    return
  }
  if (!confirm(t('terrain.updateConfirm'))) return
  progress.textContent = t('gen.preparing')
  try {
    const zoom = parseInt(zoomInput.value)
    const res = await api.updateHeightmap(selectedId, { bbox: b, zoom, sourceId: sourceSel.value })
    showPreview(res.previewDataUrl, null, res.mesh, res.workspace)
    showWorkspaceDetail(true)
    progress.textContent = `${res.tileCount} ${t('gen.tiles')} — ${t('gen.savedToData')}`
    await refreshLibrary()
    showTab('3d')
    await fetchAndSaveSatellite(res.workspace.id, b, zoom)
  } catch (err) {
    progress.textContent = ''
    alert(t('gen.failed') + (err as Error).message)
  }
})

/** WebP 衛星タイルを Canvas で合成して PNG dataURL を返す（Chromium が WebP を解釈） */
async function compositeSatellite(p: SatelliteTilesPayload): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = p.outWidth
  canvas.height = p.outHeight
  const ctx = canvas.getContext('2d')!
  await Promise.all(
    p.tiles.map(
      (t) =>
        new Promise<void>((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            ctx.drawImage(img, t.x * p.tileSize - p.left, t.y * p.tileSize - p.top)
            resolve()
          }
          img.onerror = () => reject(new Error('衛星タイルの読み込みに失敗'))
          img.src = t.dataUrl
        })
    )
  )
  return canvas.toDataURL('image/png')
}

// ---- ライブラリ ----
function markSelected() {
  for (const li of Array.from(libList.children) as HTMLElement[]) {
    li.classList.toggle('selected', li.dataset.id === selectedId)
  }
}

// ---- ライブラリのドラッグ並べ替え ----
// ドラッグ中の行。dragover で挿入位置を計算して DOM を並べ替え、dragend で順序を保存する。
let draggingEl: HTMLElement | null = null

/** カーソルの y 座標から、ドラッグ中の行を「この要素の前」に入れるべき要素を返す */
function dragAfterElement(y: number): HTMLElement | null {
  const items = Array.from(
    libList.querySelectorAll<HTMLElement>('.lib-item:not(.dragging)')
  )
  let closest: { offset: number; el: HTMLElement | null } = {
    offset: Number.NEGATIVE_INFINITY,
    el: null
  }
  for (const el of items) {
    const box = el.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closest.offset) closest = { offset, el }
  }
  return closest.el
}

libList.addEventListener('dragover', (ev) => {
  if (!draggingEl) return
  ev.preventDefault()
  const after = dragAfterElement(ev.clientY)
  if (after == null) libList.appendChild(draggingEl)
  else libList.insertBefore(draggingEl, after)
})

async function refreshLibrary() {
  const workspaces = await api.listWorkspaces()
  libCount.textContent = `${workspaces.length}${t('count.items')}`
  libList.innerHTML = ''
  for (const e of workspaces) {
    const h = e.heightmap
    const li = document.createElement('li')
    li.className = 'lib-item'
    li.dataset.id = e.id

    const thumb = document.createElement('img')
    thumb.className = 'lib-thumb'
    thumb.alt = ''
    // プレビューPNGを非同期で読み込んでサムネ表示
    api.getThumb(e.id).then((url) => {
      if (url) thumb.src = url
    })

    const meta = document.createElement('div')
    meta.className = 'lib-meta'
    const name = document.createElement('div')
    name.className = 'lib-name'
    name.textContent = e.name
    name.title = e.name
    const sub = document.createElement('div')
    sub.className = 'lib-sub'
    const lmMark = e.landmarks.length ? ` / ${e.landmarks.length}${t('landmark.count')}` : ''
    sub.textContent = `${h.width}×${h.height} / ${h.minEle.toFixed(0)}〜${h.maxEle.toFixed(0)}m${lmMark}`
    // 緯度・経度（bbox 中心）の行を追加
    const geo = document.createElement('div')
    geo.className = 'lib-sub'
    const clat = (h.bbox.north + h.bbox.south) / 2
    const clon = (h.bbox.east + h.bbox.west) / 2
    geo.textContent = `lat ${clat.toFixed(4)}, lon ${clon.toFixed(4)}`
    meta.append(name, sub, geo)

    // 名前をその場で編集する（input に差し替え → Enter/blur で確定）
    const startRename = () => {
      const input = document.createElement('input')
      input.className = 'lib-name-input'
      input.value = e.name
      name.replaceWith(input)
      input.focus()
      input.select()
      let done = false
      const commit = async (save: boolean) => {
        if (done) return
        done = true
        const newName = input.value.trim()
        if (save && newName && newName !== e.name) {
          await api.renameWorkspace(e.id, newName)
        }
        await refreshLibrary()
      }
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation()
        if (ev.key === 'Enter') commit(true)
        else if (ev.key === 'Escape') commit(false)
      })
      input.addEventListener('blur', () => commit(true))
      input.addEventListener('click', (ev) => ev.stopPropagation())
    }
    // 名前ダブルクリックで編集開始
    name.addEventListener('dblclick', (ev) => {
      ev.stopPropagation()
      startRename()
    })

    const edit = document.createElement('button')
    edit.className = 'lib-icon lib-edit'
    edit.innerHTML = ICON_EDIT
    edit.title = t('lib.rename')
    edit.setAttribute('aria-label', t('lib.rename'))
    edit.addEventListener('click', (ev) => {
      ev.stopPropagation()
      startRename()
    })

    const del = document.createElement('button')
    del.className = 'lib-icon lib-del'
    del.innerHTML = ICON_DELETE
    del.title = t('lib.delete')
    del.setAttribute('aria-label', t('lib.delete'))
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      if (!confirm(`「${e.name}」${t('lib.deleteConfirm')}`)) return
      await api.deleteWorkspace(e.id)
      if (selectedId === e.id) {
        selectedId = null
        selectedInfo.textContent = t('selected.none')
        previewImg.style.display = 'none'
        previewEmpty.style.display = 'block'
        btnExportPng.disabled = true
        btnExportRaw.disabled = true
        btnUpdateTerrain.disabled = true
        clearAnnotations()
      }
      await refreshLibrary()
    })

    // ドラッグ用ハンドル（このハンドルを掴んだ時だけ行をドラッグ可能にする）
    const handle = document.createElement('span')
    handle.className = 'lib-drag'
    handle.innerHTML = ICON_DRAG
    handle.title = t('lib.reorder')
    handle.setAttribute('aria-label', t('lib.reorder'))
    handle.addEventListener('mousedown', () => {
      li.draggable = true
    })
    handle.addEventListener('mouseup', () => {
      li.draggable = false
    })
    handle.addEventListener('click', (ev) => ev.stopPropagation())

    li.addEventListener('dragstart', (ev) => {
      draggingEl = li
      li.classList.add('dragging')
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
    })
    li.addEventListener('dragend', async () => {
      li.classList.remove('dragging')
      li.draggable = false
      draggingEl = null
      // 現在のDOM順を保存する
      const ids = (Array.from(libList.children) as HTMLElement[])
        .map((c) => c.dataset.id)
        .filter((id): id is string => !!id)
      await api.reorderWorkspaces(ids)
    })

    // 「中に入る」ボタン（詳細＝地点リストへドリルイン）
    const enter = document.createElement('button')
    enter.className = 'lib-icon lib-enter'
    enter.innerHTML = ICON_ENTER
    enter.title = t('lib.enter')
    enter.setAttribute('aria-label', t('lib.enter'))
    enter.addEventListener('click', (ev) => {
      ev.stopPropagation()
      enterWorkspace(e.id)
    })

    // 1クリック=選択（地形を表示）、ダブルクリック=中に入る
    li.addEventListener('click', () => selectItem(e.id))
    li.addEventListener('dblclick', () => enterWorkspace(e.id))
    li.append(handle, thumb, meta, edit, del, enter)
    libList.appendChild(li)
  }
  markSelected()
}

async function selectItem(id: string) {
  progress.textContent = t('load.loading')
  try {
    const item = await api.getWorkspace(id)
    showPreview(item.previewDataUrl, item.satelliteDataUrl, item.mesh, item.workspace)

    // 選択ワークスペースの範囲へ地図を移動し、bbox を反映
    const bb = item.workspace.heightmap.bbox
    setBBoxFields(bb.west, bb.south, bb.east, bb.north)
    zoomInput.value = String(item.workspace.heightmap.zoom)
    zoomVal.textContent = String(item.workspace.heightmap.zoom)
    updateEstimate()
    map.fitBounds(
      [
        [bb.west, bb.south],
        [bb.east, bb.north]
      ],
      { padding: 40, duration: 600 }
    )

    progress.textContent = ''
  } catch (err) {
    progress.textContent = ''
    alert(t('load.failed') + (err as Error).message)
  }
}

// ---- エクスポート（選択中アイテム） ----
btnExportPng.addEventListener('click', async () => {
  if (!selectedId) return
  const r = await api.exportItem(selectedId, 'png16')
  if (r.saved) progress.textContent = t('export.saved') + r.filePath
})
btnExportRaw.addEventListener('click', async () => {
  if (!selectedId) return
  const r = await api.exportItem(selectedId, 'raw16')
  if (r.saved) progress.textContent = t('export.saved') + r.filePath
})

// ---- 起動時 ----
;(async () => {
  // 環境設定（言語・地図スタイル）を先に読み込む
  const settings = await api.getSettings()
  if (settings.lang === 'ja' || settings.lang === 'en') {
    setLang(settings.lang)
    langSel.value = settings.lang
  } else {
    setLang(getLang())
  }
  applyDom() // HTML の data-i18n を現在言語で適用
  if (settings.mapStyle && MAPBOX_STYLES[settings.mapStyle]) {
    currentStyleKey = settings.mapStyle
    mapStyleSel.value = currentStyleKey
  }
  if (settings.snapPow2) {
    snapPow2 = true
    snapCheckbox.checked = true
  }
  // 3Dビューポートの描画モード・地点表示を復元（既定は default / 表示）
  if (
    settings.renderMode === 'default' ||
    settings.renderMode === 'heightmap' ||
    settings.renderMode === 'satellite'
  ) {
    renderModeSel.value = settings.renderMode
  }
  if (settings.showLandmarks === false) chkShowLandmarks.checked = false

  const cfg = await api.getConfig()
  if (cfg.token) {
    token = cfg.token
    tokenInput.value = cfg.token
    tokenStatus.textContent = t('token.loaded')
  }
  // トークン有無に関わらず、保存済みスタイルでスタイルを適用
  // diff:false で完全リロード（言語パラメータだけの変更でもタイルを再取得させる）
  map.setStyle(makeStyle(token, currentStyleKey), { diff: false })
  updateEstimate()
  await refreshLibrary()
})()
