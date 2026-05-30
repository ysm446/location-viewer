import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import type { Api, MeshPayload, LibraryEntry, SatelliteTilesPayload } from '../preload/index'
import { TerrainViewer } from './viewer3d'
import { t, setLang, getLang, applyDom, type Lang } from './i18n'

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
const progress = $('progress')
const btnExportPng = $<HTMLButtonElement>('btn-export-png')
const btnExportRaw = $<HTMLButtonElement>('btn-export-raw')
const libList = $<HTMLUListElement>('library-list')
const libCount = $('lib-count')
const selectedInfo = $('selected-info')

let token = ''
let viewer: TerrainViewer | null = null
let pendingMesh: MeshPayload | null = null // 3Dタブ未生成時の保留データ
let selectedId: string | null = null

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
        'circle-radius': 6,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#1177bb',
        'circle-stroke-width': 2
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

$('btn-use-view').addEventListener('click', () => {
  const b = map.getBounds()
  setBBoxFields(b.getWest(), b.getSouth(), b.getEast(), b.getNorth())
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
    setBBoxFields(w, s, east, n)
  }
  setDrawMode(false) // 1回描いたら通常モードに戻す
})

// ---- 四隅ハンドルをドラッグして矩形をリサイズ ----
let dragCorner: string | null = null

// ハンドルにカーソルを乗せたらポインタ表示
map.on('mouseenter', 'bbox-handles', () => {
  if (!drawMode) map.getCanvas().style.cursor = 'move'
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
  dragCorner = null
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

// ---- 解像度の推定（メイン側 tiles.ts と同じ式） ----
const TILE = 512
function lonPx(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z * TILE
}
function latPx(lat: number, z: number) {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z * TILE
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
    if (!viewer) viewer = new TerrainViewer($('viewer3d'))
    if (pendingMesh) {
      viewer.setSatelliteTexture(pendingSatellite)
      viewer.setData(pendingMesh)
      pendingMesh = null
      pendingSatellite = null
    }
  }
}
tabMap.addEventListener('click', () => showTab('map'))
tab2d.addEventListener('click', () => showTab('2d'))
tab3d.addEventListener('click', () => showTab('3d'))

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

const exaggeration = $<HTMLInputElement>('exaggeration')
const exaggerationVal = $('exaggeration-val')
exaggeration.addEventListener('input', () => {
  const v = parseFloat(exaggeration.value)
  exaggerationVal.textContent = `${v.toFixed(1)}×`
  viewer?.setExaggeration(v)
})

const useSatellite = $<HTMLInputElement>('use-satellite')
useSatellite.addEventListener('change', () => {
  viewer?.setUseSatellite(useSatellite.checked)
})

// ---- プレビュー表示の共通処理 ----
// 直近に選択したアイテムの衛星テクスチャ（3Dタブ初回表示時に適用するため保持）
let pendingSatellite: string | null = null

function showPreview(
  previewDataUrl: string,
  satelliteDataUrl: string | null,
  mesh: MeshPayload,
  entry: LibraryEntry
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

  // 衛星画像チェックボックスの有効/無効
  useSatellite.disabled = !satelliteDataUrl

  selectedId = entry.id
  const satMark = satelliteDataUrl ? ` / ${t('view3d.satellite')}` : ''
  selectedInfo.textContent = `${entry.width}×${entry.height}px / ${entry.minEle.toFixed(
    1
  )}〜${entry.maxEle.toFixed(1)}m${satMark}`
  btnExportPng.disabled = false
  btnExportRaw.disabled = false
  markSelected()
}

// ---- 生成 ----
api.onProgress((p) => {
  progress.textContent = `${t('gen.downloading')} ${p.done}/${p.total} ${t('gen.tiles')}`
})

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
    const bbox = b
    const res = await api.generate({
      bbox,
      zoom: parseInt(zoomInput.value),
      sourceId: sourceSel.value
    })
    showPreview(res.previewDataUrl, null, res.mesh, res.entry)
    progress.textContent = `${res.tileCount} ${t('gen.tiles')} — ${t('gen.savedToData')}`
    await refreshLibrary()
    showTab('3d') // 生成後は3Dで確認

    // 衛星画像を取得・合成・保存（失敗してもハイトマップは保存済み）
    try {
      progress.textContent = t('gen.fetchingSatellite')
      const sat = await api.fetchSatellite(bbox, parseInt(zoomInput.value))
      const pngDataUrl = await compositeSatellite(sat)
      await api.saveSatellite(res.entry.id, pngDataUrl)
      if (selectedId === res.entry.id) {
        viewer?.setSatelliteTexture(pngDataUrl)
        useSatellite.disabled = false
      }
      progress.textContent = t('gen.doneWithSatellite')
    } catch (e) {
      progress.textContent = t('gen.doneNoSatellite') + (e as Error).message
    }
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

async function refreshLibrary() {
  const entries = await api.listLibrary()
  libCount.textContent = `${entries.length}${t('count.items')}`
  libList.innerHTML = ''
  for (const e of entries) {
    const li = document.createElement('li')
    li.className = 'lib-item'
    li.dataset.id = e.id

    const thumb = document.createElement('img')
    thumb.className = 'lib-thumb'
    // サムネは選択時に本体プレビューを読むため、ここでは軽くプレースホルダ
    thumb.alt = ''

    const meta = document.createElement('div')
    meta.className = 'lib-meta'
    const name = document.createElement('div')
    name.className = 'lib-name'
    name.textContent = e.name
    const sub = document.createElement('div')
    sub.className = 'lib-sub'
    sub.textContent = `${e.width}×${e.height} / ${e.minEle.toFixed(0)}〜${e.maxEle.toFixed(0)}m`
    meta.append(name, sub)

    const del = document.createElement('button')
    del.className = 'lib-del'
    del.textContent = t('lib.delete')
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      if (!confirm(`「${e.name}」${t('lib.deleteConfirm')}`)) return
      await api.deleteLibraryItem(e.id)
      if (selectedId === e.id) {
        selectedId = null
        selectedInfo.textContent = t('selected.none')
        previewImg.style.display = 'none'
        previewEmpty.style.display = 'block'
        btnExportPng.disabled = true
        btnExportRaw.disabled = true
      }
      await refreshLibrary()
    })

    li.addEventListener('click', () => selectItem(e.id))
    li.append(thumb, meta, del)
    libList.appendChild(li)
  }
  markSelected()
}

async function selectItem(id: string) {
  progress.textContent = t('load.loading')
  try {
    const item = await api.getLibraryItem(id)
    showPreview(item.previewDataUrl, item.satelliteDataUrl, item.mesh, item.entry)

    // 選択アイテムの範囲へ地図を移動し、bbox を反映
    const bb = item.entry.bbox
    setBBoxFields(bb.west, bb.south, bb.east, bb.north)
    zoomInput.value = String(item.entry.zoom)
    zoomVal.textContent = String(item.entry.zoom)
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
