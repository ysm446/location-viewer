import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import type { Api, MeshPayload, LibraryEntry, SatelliteTilesPayload } from '../preload/index'
import { TerrainViewer } from './viewer3d'

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
function makeStyle(tk: string): maplibregl.StyleSpecification {
  if (tk) {
    return {
      version: 8,
      sources: {
        sat: {
          type: 'raster',
          tiles: [
            `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.png?access_token=${tk}`
          ],
          tileSize: 512,
          attribution: '© Mapbox © Maxar'
        }
      },
      layers: [{ id: 'sat', type: 'raster', source: 'sat' }]
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
  style: makeStyle(''),
  center: [138.7274, 35.3606], // 富士山
  zoom: 11
})
map.addControl(new maplibregl.NavigationControl(), 'bottom-right')

// 選択範囲の矩形を描画する
function drawBBoxRect(w: number, s: number, e: number, n: number) {
  const geojson: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[w, n], [e, n], [e, s], [w, s], [w, n]]] }
  }
  const src = map.getSource('bbox') as maplibregl.GeoJSONSource | undefined
  if (src) {
    src.setData(geojson)
  } else {
    map.addSource('bbox', { type: 'geojson', data: geojson })
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
    estimate.textContent = '推定: 範囲を選択してください'
    return
  }
  const w = Math.round(lonPx(b.east, z) - lonPx(b.west, z))
  const h = Math.round(latPx(b.south, z) - latPx(b.north, z))
  const tx = Math.floor(lonPx(b.east, z) / TILE) - Math.floor(lonPx(b.west, z) / TILE) + 1
  const ty = Math.floor(latPx(b.south, z) / TILE) - Math.floor(latPx(b.north, z) / TILE) + 1
  estimate.textContent = `推定出力: ${w}×${h}px / タイル ${tx * ty}枚`
}

zoomInput.addEventListener('input', () => {
  zoomVal.textContent = zoomInput.value
  updateEstimate()
})

// ---- トークン ----
$('btn-save-token').addEventListener('click', async () => {
  token = tokenInput.value.trim()
  await api.setToken(token)
  tokenStatus.textContent = token ? 'トークンを保存しました。' : 'トークンが空です。'
  map.setStyle(makeStyle(token))
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
  selectedInfo.textContent = `${entry.width}×${entry.height}px / 標高 ${entry.minEle.toFixed(
    1
  )}〜${entry.maxEle.toFixed(1)}m${satelliteDataUrl ? ' / 衛星画像あり' : ''}`
  btnExportPng.disabled = false
  btnExportRaw.disabled = false
  markSelected()
}

// ---- 生成 ----
api.onProgress((p) => {
  progress.textContent = `ダウンロード中… ${p.done}/${p.total} タイル`
})

$('btn-generate').addEventListener('click', async () => {
  const b = currentBBox()
  if ([b.west, b.south, b.east, b.north].some((v) => isNaN(v))) {
    alert('先に範囲を選択してください。')
    return
  }
  if (!token) {
    alert('Mapbox トークンを保存してください。')
    return
  }
  progress.textContent = '準備中…'
  try {
    const bbox = b
    const res = await api.generate({
      bbox,
      zoom: parseInt(zoomInput.value),
      sourceId: sourceSel.value
    })
    showPreview(res.previewDataUrl, null, res.mesh, res.entry)
    progress.textContent = `完了（${res.tileCount}タイル）→ data/ に保存`
    await refreshLibrary()
    showTab('3d') // 生成後は3Dで確認

    // 衛星画像を取得・合成・保存（失敗してもハイトマップは保存済み）
    try {
      progress.textContent = '衛星画像を取得中…'
      const sat = await api.fetchSatellite(bbox, parseInt(zoomInput.value))
      const pngDataUrl = await compositeSatellite(sat)
      await api.saveSatellite(res.entry.id, pngDataUrl)
      if (selectedId === res.entry.id) {
        viewer?.setSatelliteTexture(pngDataUrl)
        useSatellite.disabled = false
      }
      progress.textContent = '完了（衛星画像つき）→ data/ に保存'
    } catch (e) {
      progress.textContent = '完了（標高のみ）。衛星画像の取得に失敗: ' + (e as Error).message
    }
  } catch (err) {
    progress.textContent = ''
    alert('生成に失敗しました: ' + (err as Error).message)
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
  libCount.textContent = `${entries.length}件`
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
    del.textContent = '削除'
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      if (!confirm(`「${e.name}」を削除しますか？（data/ から削除されます）`)) return
      await api.deleteLibraryItem(e.id)
      if (selectedId === e.id) {
        selectedId = null
        selectedInfo.textContent = '選択なし'
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
  progress.textContent = '読み込み中…'
  try {
    const item = await api.getLibraryItem(id)
    showPreview(item.previewDataUrl, item.satelliteDataUrl, item.mesh, item.entry)
    progress.textContent = ''
  } catch (err) {
    progress.textContent = ''
    alert('読み込みに失敗しました: ' + (err as Error).message)
  }
}

// ---- エクスポート（選択中アイテム） ----
btnExportPng.addEventListener('click', async () => {
  if (!selectedId) return
  const r = await api.exportItem(selectedId, 'png16')
  if (r.saved) progress.textContent = `書き出し: ${r.filePath}`
})
btnExportRaw.addEventListener('click', async () => {
  if (!selectedId) return
  const r = await api.exportItem(selectedId, 'raw16')
  if (r.saved) progress.textContent = `書き出し: ${r.filePath}`
})

// ---- 起動時 ----
;(async () => {
  const cfg = await api.getConfig()
  if (cfg.token) {
    token = cfg.token
    tokenInput.value = cfg.token
    tokenStatus.textContent = '保存済みトークンを読み込みました。'
    map.setStyle(makeStyle(token))
  }
  await refreshLibrary()
})()
