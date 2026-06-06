import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { BBox, TILE_SIZE, TILE_SOURCES, computeRegion, downloadTiles } from './tiles'
import { fetchOsmFeatures, fetchOsmTagsByIds, classify } from './osm'
import {
  buildHeightField,
  buildMeshData,
  meshFromValues16,
  normalizeTo16bit,
  buildPreviewPng,
  exportPng16,
  exportRaw16,
  sampleElevation
} from './heightmap'
import {
  Workspace,
  HeightmapMeta,
  Landmark,
  Route,
  RouteCategory,
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateHeightmap,
  renameWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  saveLandmarks,
  saveRoutes,
  readValues16,
  readPreviewDataUrl,
  readSatelliteDataUrl,
  saveSatellite,
  readWorkspaceEntries,
  importWorkspaceEntries,
  landmarkLibraryCandidates,
  readLandmarkLibrary,
  landmarkAlreadyImported,
  LandmarkLibraryEntry
} from './library'
import { writeZip, readZip } from './zip'

interface Config {
  token?: string
}

// app 準備後に解決する（モジュール最上位で app.getPath を呼ばない）
function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

// 出力の既定フォルダ = プロジェクト直下の data/
// 開発時は process.cwd() がプロジェクトルート。パッケージ後は exe の隣の data/。
function dataDir(): string {
  const base = app.isPackaged ? join(app.getPath('exe'), '..') : process.cwd()
  return join(base, 'data')
}

async function ensureDataDir(): Promise<string> {
  const dir = dataDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// data/settings.json … アプリの環境設定（地図スタイル・言語など）
interface Settings {
  mapStyle?: string
  lang?: 'ja' | 'en'
  snapPow2?: boolean
  renderMode?: 'default' | 'heightmap' | 'satellite'
  showLandmarks?: boolean
  showLandmarkElevation?: boolean
  showRoutes?: boolean
  showHelp?: boolean
  showTileGrid?: boolean
  autoFit?: boolean
  scaleAnnotations?: boolean
  seaLevelBase?: boolean
  fixedLabelSize?: boolean
  rightPaneWidth?: number
  cameraFov?: number
  transition?: 'none' | 'slide' | 'wipe' | 'morph'
}
function settingsPath(dir: string): string {
  return join(dir, 'settings.json')
}
async function loadSettings(): Promise<Settings> {
  try {
    const dir = await ensureDataDir()
    return JSON.parse(await fs.readFile(settingsPath(dir), 'utf-8'))
  } catch {
    return {}
  }
}
async function saveSettings(patch: Settings): Promise<void> {
  const dir = await ensureDataDir()
  const cur = await loadSettings()
  await fs.writeFile(settingsPath(dir), JSON.stringify({ ...cur, ...patch }, null, 2), 'utf-8')
}

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf-8'))
  } catch {
    return {}
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2), 'utf-8')
}

function createWindow(): void {
  // Electron 既定のメニュー（File/Edit/View…）を非表示にする
  Menu.setApplicationMenu(null)

  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    useContentSize: true, // タイトルバーを含めず、描画領域を 1600x900 にする
    title: 'Mapbox Heightmap Importer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** bbox の中心と日時からアイテム名を生成する */
function autoName(bbox: BBox, zoom: number): string {
  const lat = (bbox.north + bbox.south) / 2
  const lon = (bbox.east + bbox.west) / 2
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const ts = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return `${lat.toFixed(3)}, ${lon.toFixed(3)} z${zoom} (${ts})`
}

/** bbox の地表サイズ（メートル）を概算する（haversine） */
function groundSizeMeters(bbox: BBox): { widthMeters: number; heightMeters: number } {
  const R = 6371000 // 地球半径(m)
  const toRad = (d: number) => (d * Math.PI) / 180
  const midLat = (bbox.north + bbox.south) / 2
  // 東西方向（中央緯度に沿った距離）
  const widthMeters = R * Math.cos(toRad(midLat)) * toRad(bbox.east - bbox.west)
  // 南北方向
  const heightMeters = R * toRad(bbox.north - bbox.south)
  return { widthMeters: Math.abs(widthMeters), heightMeters: Math.abs(heightMeters) }
}

/** MeshData を IPC 転送用ペイロードに変換（地表メートルも付与） */
function meshToPayload(mesh: ReturnType<typeof buildMeshData>, bbox: BBox) {
  const { widthMeters, heightMeters } = groundSizeMeters(bbox)
  return {
    cols: mesh.cols,
    rows: mesh.rows,
    aspect: mesh.aspect,
    minEle: mesh.minEle,
    maxEle: mesh.maxEle,
    widthMeters,
    heightMeters,
    // ランドマークの lng/lat → メッシュ座標変換に使う
    bbox,
    // Float32Array は ArrayBuffer として転送（構造化クローン対応）
    heights: mesh.heights.buffer.slice(0)
  }
}

interface TerrainArgs {
  bbox: BBox
  zoom: number
  sourceId: string
  rangeMin?: number
  rangeMax?: number
}

/** 地形タイルをダウンロードして合成・正規化・プレビュー・メッシュを作る（生成/更新で共通） */
async function generateTerrain(
  event: Electron.IpcMainInvokeEvent,
  args: TerrainArgs
): Promise<{
  values16: Uint16Array
  previewPng: Buffer
  mesh: ReturnType<typeof buildMeshData>
  width: number
  height: number
  minEle: number
  maxEle: number
  tileCount: number
}> {
  const cfg = await loadConfig()
  if (!cfg.token) throw new Error('Mapbox アクセストークンが未設定です。')

  const source = TILE_SOURCES[args.sourceId] ?? TILE_SOURCES['terrain-dem']
  if (args.zoom > source.maxZoom) {
    throw new Error(`${source.label} はズーム ${source.maxZoom} まで対応しています。ズームを下げてください。`)
  }
  const region = computeRegion(args.bbox, args.zoom)
  const tileCount = (region.tileX1 - region.tileX0 + 1) * (region.tileY1 - region.tileY0 + 1)
  if (tileCount > 400) {
    throw new Error(`タイル数が多すぎます (${tileCount})。範囲を狭めるかズームを下げてください。`)
  }

  const tiles = await downloadTiles(source, region, args.zoom, cfg.token, 6, (done, total) => {
    event.sender.send('heightmap:progress', { done, total })
  })

  const hf = buildHeightField(tiles, region)
  const values16 = normalizeTo16bit(hf, args.rangeMin, args.rangeMax)
  const previewPng = buildPreviewPng(hf.width, hf.height, values16)
  const mesh = buildMeshData(hf, 256)
  return {
    values16,
    previewPng,
    mesh,
    width: hf.width,
    height: hf.height,
    minEle: hf.minEle,
    maxEle: hf.maxEle,
    tileCount
  }
}

/** TerrainArgs と生成結果から HeightmapMeta を組み立てる */
function makeHeightmapMeta(
  args: TerrainArgs,
  r: { width: number; height: number; minEle: number; maxEle: number }
): HeightmapMeta {
  return {
    bbox: args.bbox,
    zoom: args.zoom,
    sourceId: args.sourceId,
    width: r.width,
    height: r.height,
    minEle: r.minEle,
    maxEle: r.maxEle,
    updatedAt: Date.now()
  }
}

app.whenReady().then(() => {
  // --- 設定 (トークン) ---
  ipcMain.handle('config:get', async () => loadConfig())
  ipcMain.handle('config:setToken', async (_e, token: string) => {
    const cfg = await loadConfig()
    cfg.token = token
    await saveConfig(cfg)
    return true
  })

  // --- 環境設定（data/settings.json） ---
  ipcMain.handle('settings:get', async () => loadSettings())
  ipcMain.handle('settings:set', async (_e, patch: Settings) => {
    await saveSettings(patch)
    return true
  })

  // --- 新規ワークスペースを作成（地形を生成して保存） ---
  ipcMain.handle('workspace:create', async (event, args: TerrainArgs) => {
    const r = await generateTerrain(event, args)
    const dir = await ensureDataDir()
    const ws: Workspace = {
      id: `ws_${Date.now().toString(36)}`,
      name: autoName(args.bbox, args.zoom),
      createdAt: Date.now(),
      heightmap: { ...makeHeightmapMeta(args, r), hasSatellite: false },
      landmarks: [],
      routes: []
    }
    await createWorkspace(dir, ws, r.values16, r.previewPng)
    return {
      workspace: ws,
      tileCount: r.tileCount,
      previewDataUrl: `data:image/png;base64,${r.previewPng.toString('base64')}`,
      mesh: meshToPayload(r.mesh, args.bbox)
    }
  })

  // --- 既存ワークスペースの地形を更新（上書き。landmarks は保持） ---
  ipcMain.handle('workspace:updateHeightmap', async (event, id: string, args: TerrainArgs) => {
    const r = await generateTerrain(event, args)
    const dir = await ensureDataDir()
    const ws = await updateHeightmap(dir, id, makeHeightmapMeta(args, r), r.values16, r.previewPng)
    if (!ws) throw new Error('ワークスペースが見つかりません。')
    return {
      workspace: ws,
      tileCount: r.tileCount,
      previewDataUrl: `data:image/png;base64,${r.previewPng.toString('base64')}`,
      mesh: meshToPayload(r.mesh, args.bbox)
    }
  })

  // --- 衛星タイル取得（WebP のままレンダラーへ。Chromium が合成する） ---
  ipcMain.handle('satellite:fetch', async (event, args: { bbox: BBox; zoom: number }) => {
    const cfg = await loadConfig()
    if (!cfg.token) throw new Error('Mapbox アクセストークンが未設定です。')
    const region = computeRegion(args.bbox, args.zoom)
    const satTiles = await downloadTiles(
      TILE_SOURCES['satellite'],
      region,
      args.zoom,
      cfg.token,
      6,
      (done, total) => event.sender.send('heightmap:progress', { done, total, phase: 'satellite' })
    )
    return {
      outWidth: region.outWidth,
      outHeight: region.outHeight,
      left: region.left,
      top: region.top,
      tileSize: TILE_SIZE,
      // 拡張子に関わらず Mapbox は WebP を返すので、そのまま webp として渡す
      tiles: satTiles.map((t) => ({
        x: t.x,
        y: t.y,
        dataUrl: `data:image/webp;base64,${t.buffer.toString('base64')}`
      }))
    }
  })

  // --- 合成済み衛星 PNG を保存（レンダラーが Canvas で作成して送ってくる） ---
  ipcMain.handle('satellite:save', async (_e, id: string, pngDataUrl: string) => {
    const dir = await ensureDataDir()
    const b64 = pngDataUrl.split(',')[1] ?? ''
    await saveSatellite(dir, id, Buffer.from(b64, 'base64'))
    return true
  })

  // --- ワークスペース: 一覧 ---
  ipcMain.handle('workspace:list', async () => {
    const dir = await ensureDataDir()
    return listWorkspaces(dir)
  })

  // --- ワークスペース: サムネの dataURL（衛星優先、なければプレビュー） ---
  ipcMain.handle('workspace:thumb', async (_e, id: string) => {
    const dir = await ensureDataDir()
    const sat = await readSatelliteDataUrl(dir, id)
    if (sat) return sat
    try {
      return await readPreviewDataUrl(dir, id)
    } catch {
      return null
    }
  })

  // --- ワークスペース: 1件の表示用データ（メタ + プレビュー + 3Dメッシュ） ---
  ipcMain.handle('workspace:get', async (_e, id: string) => {
    const dir = await ensureDataDir()
    const ws = await getWorkspace(dir, id)
    if (!ws) throw new Error('ワークスペースが見つかりません。')
    const h = ws.heightmap
    const values16 = await readValues16(dir, id)
    const previewDataUrl = await readPreviewDataUrl(dir, id)
    const satelliteDataUrl = await readSatelliteDataUrl(dir, id)
    const mesh = meshFromValues16(values16, h.width, h.height, h.minEle, h.maxEle)
    return { workspace: ws, previewDataUrl, satelliteDataUrl, mesh: meshToPayload(mesh, h.bbox) }
  })

  // --- ワークスペース: 名前変更 ---
  ipcMain.handle('workspace:rename', async (_e, id: string, name: string) => {
    const dir = await ensureDataDir()
    return renameWorkspace(dir, id, name)
  })

  // --- ワークスペース: 削除 ---
  ipcMain.handle('workspace:delete', async (_e, id: string) => {
    const dir = await ensureDataDir()
    return deleteWorkspace(dir, id)
  })

  // --- ワークスペース: 並べ替え（id 配列の順に保存） ---
  ipcMain.handle('workspace:reorder', async (_e, ids: string[]) => {
    const dir = await ensureDataDir()
    return reorderWorkspaces(dir, ids)
  })

  // --- ランドマーク: 保存 ---
  ipcMain.handle('workspace:saveLandmarks', async (_e, id: string, landmarks: Landmark[]) => {
    const dir = await ensureDataDir()
    return saveLandmarks(dir, id, landmarks)
  })

  // --- ランドマークライブラリ: bbox内の未取り込み候補 ---
  ipcMain.handle('landmarkLibrary:candidates', async (_e, id: string) => {
    const dir = await ensureDataDir()
    return landmarkLibraryCandidates(dir, id)
  })

  // --- ランドマークライブラリ: bbox内候補を選択ロケーションへまとめて取り込み ---
  ipcMain.handle('landmarkLibrary:importIntoWorkspace', async (_e, id: string) => {
    const dir = await ensureDataDir()
    const ws = await getWorkspace(dir, id)
    if (!ws) throw new Error('ロケーションが見つかりません。')
    const entries = (await readLandmarkLibrary(dir)).filter(
      (entry) =>
        entry.lng >= ws.heightmap.bbox.west &&
        entry.lng <= ws.heightmap.bbox.east &&
        entry.lat >= ws.heightmap.bbox.south &&
        entry.lat <= ws.heightmap.bbox.north &&
        !landmarkAlreadyImported(entry, ws.landmarks)
    )
    if (!entries.length) return []

    const h = ws.heightmap
    const values16 = await readValues16(dir, id)
    const imported: Landmark[] = entries.map((entry: LandmarkLibraryEntry) => ({
      id: `lm_lib_${entry.id}`,
      libraryId: entry.id,
      name: entry.name,
      lng: entry.lng,
      lat: entry.lat,
      elevation: sampleElevation(values16, h.width, h.height, h.bbox, h.zoom, h.minEle, h.maxEle, entry.lng, entry.lat)
    }))
    ws.landmarks.push(...imported)
    await saveLandmarks(dir, id, ws.landmarks)
    return imported
  })

  // --- ルート: 保存 ---
  ipcMain.handle('workspace:saveRoutes', async (_e, id: string, routes: Route[]) => {
    const dir = await ensureDataDir()
    return saveRoutes(dir, id, routes)
  })

  // --- OSM: bbox 内のライン（道路/歩道/登山道/鉄道）を取得 ---
  ipcMain.handle('osm:fetch', async (_e, bbox: BBox, cats: RouteCategory[], clip: boolean) => {
    return fetchOsmFeatures(bbox, cats, clip)
  })

  // --- OSM: 保存済みルートの種別を再判定（osmId からタグを引き直して分類し直す） ---
  ipcMain.handle('osm:reclassify', async (_e, id: string) => {
    const dir = await ensureDataDir()
    const ws = await getWorkspace(dir, id)
    if (!ws) return null
    const ids = [...new Set(ws.routes.map((r) => r.osmId).filter((v): v is number => typeof v === 'number'))]
    if (ids.length === 0) return { routes: ws.routes, changed: 0 }
    const tagMap = await fetchOsmTagsByIds(ids)
    let changed = 0
    for (const r of ws.routes) {
      if (r.osmId === undefined) continue
      const tags = tagMap.get(r.osmId)
      if (!tags) continue
      const cat = classify(tags)
      if (cat && cat !== r.category) {
        r.category = cat
        changed++
      }
    }
    await saveRoutes(dir, id, ws.routes)
    return { routes: ws.routes, changed }
  })

  // --- 標高サンプリング（緯度経度 → メートル） ---
  ipcMain.handle('workspace:sampleElevation', async (_e, id: string, lng: number, lat: number) => {
    const dir = await ensureDataDir()
    const ws = await getWorkspace(dir, id)
    if (!ws) return null
    const h = ws.heightmap
    const values16 = await readValues16(dir, id)
    return sampleElevation(values16, h.width, h.height, h.bbox, h.zoom, h.minEle, h.maxEle, lng, lat)
  })

  // --- ワークスペース: ハイトマップを PNG16 / R16 で書き出す ---
  ipcMain.handle('workspace:export', async (_e, id: string, format: 'png16' | 'raw16') => {
    const dir = await ensureDataDir()
    const ws = await getWorkspace(dir, id)
    if (!ws) throw new Error('ワークスペースが見つかりません。')
    const h = ws.heightmap

    const values16 = await readValues16(dir, id)
    const ext = format === 'png16' ? 'png' : 'r16'
    const fileName = `${ws.name}_${h.width}x${h.height}.${ext}`.replace(/[\\/:*?"<>|]/g, '_')
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'ハイトマップを書き出し',
      defaultPath: join(dir, fileName),
      filters:
        format === 'png16'
          ? [{ name: '16bit PNG', extensions: ['png'] }]
          : [{ name: 'RAW 16bit (R16)', extensions: ['r16', 'raw'] }]
    })
    if (canceled || !filePath) return { saved: false }

    if (format === 'png16') {
      await exportPng16(filePath, h.width, h.height, values16)
    } else {
      await exportRaw16(filePath, values16)
    }
    return { saved: true, filePath }
  })

  // --- ワークスペースを ZIP でバックアップ書き出し（再取り込み可能な丸ごと） ---
  ipcMain.handle('workspace:exportZip', async (_e, id: string) => {
    const dir = await ensureDataDir()
    const ws = await getWorkspace(dir, id)
    if (!ws) throw new Error('ワークスペースが見つかりません。')
    const fileName = `${ws.name}.zip`.replace(/[\\/:*?"<>|]/g, '_')
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'ロケーションを ZIP で書き出し',
      defaultPath: join(dir, fileName),
      filters: [{ name: 'ZIP アーカイブ', extensions: ['zip'] }]
    })
    if (canceled || !filePath) return { saved: false }
    await writeZip(filePath, await readWorkspaceEntries(dir, id))
    return { saved: true, filePath }
  })

  // --- ZIP からワークスペースを取り込み（新規ロケーションとして復元） ---
  ipcMain.handle('workspace:importZip', async () => {
    const dir = await ensureDataDir()
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'ロケーション ZIP を取り込み',
      properties: ['openFile'],
      filters: [{ name: 'ZIP アーカイブ', extensions: ['zip'] }]
    })
    if (canceled || !filePaths?.length) return { imported: false }
    const ws = await importWorkspaceEntries(dir, await readZip(filePaths[0]))
    return { imported: true, workspace: ws }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
