import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { BBox, TILE_SIZE, TILE_SOURCES, computeRegion, downloadTiles } from './tiles'
import {
  buildHeightField,
  buildMeshData,
  meshFromValues16,
  normalizeTo16bit,
  buildPreviewPng,
  exportPng16,
  exportRaw16
} from './heightmap'
import {
  LibraryEntry,
  readIndex,
  addEntry,
  deleteEntry,
  readValues16,
  readPreviewDataUrl,
  readSatelliteDataUrl,
  saveSatellite,
  findEntry
} from './library'

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

// data/settings.json … アプリの環境設定（地図スタイルなど）
interface Settings {
  mapStyle?: string
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
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
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
    // Float32Array は ArrayBuffer として転送（構造化クローン対応）
    heights: mesh.heights.buffer.slice(0)
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

  // --- ハイトマップ生成（= data/ ライブラリへインポート） ---
  ipcMain.handle(
    'heightmap:generate',
    async (
      event,
      args: { bbox: BBox; zoom: number; sourceId: string; rangeMin?: number; rangeMax?: number }
    ) => {
      const cfg = await loadConfig()
      if (!cfg.token) throw new Error('Mapbox アクセストークンが未設定です。')

      const source = TILE_SOURCES[args.sourceId] ?? TILE_SOURCES['terrain-dem']
      const region = computeRegion(args.bbox, args.zoom)
      const tileCount =
        (region.tileX1 - region.tileX0 + 1) * (region.tileY1 - region.tileY0 + 1)

      if (tileCount > 400) {
        throw new Error(
          `タイル数が多すぎます (${tileCount})。範囲を狭めるかズームを下げてください。`
        )
      }

      const tiles = await downloadTiles(source, region, args.zoom, cfg.token, 6, (done, total) => {
        event.sender.send('heightmap:progress', { done, total })
      })

      const hf = buildHeightField(tiles, region)
      const values16 = normalizeTo16bit(hf, args.rangeMin, args.rangeMax)
      const previewPng = buildPreviewPng(hf.width, hf.height, values16)
      const mesh = buildMeshData(hf, 256)

      // data/ へ自動保存（衛星は別IPCでレンダラーが合成・保存する）
      const dir = await ensureDataDir()
      const entry: LibraryEntry = {
        id: `hm_${Date.now().toString(36)}`,
        name: autoName(args.bbox, args.zoom),
        createdAt: Date.now(),
        bbox: args.bbox,
        zoom: args.zoom,
        sourceId: args.sourceId,
        width: hf.width,
        height: hf.height,
        minEle: hf.minEle,
        maxEle: hf.maxEle
      }
      await addEntry(dir, entry, values16, previewPng)

      return {
        entry,
        tileCount,
        previewDataUrl: `data:image/png;base64,${previewPng.toString('base64')}`,
        mesh: meshToPayload(mesh, args.bbox)
      }
    }
  )

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

  // --- ライブラリ: 一覧 ---
  ipcMain.handle('library:list', async () => {
    const dir = await ensureDataDir()
    return readIndex(dir)
  })

  // --- ライブラリ: 1件の表示用データ（プレビュー + 3Dメッシュ） ---
  ipcMain.handle('library:get', async (_e, id: string) => {
    const dir = await ensureDataDir()
    const entries = await readIndex(dir)
    const entry = findEntry(entries, id)
    if (!entry) throw new Error('アイテムが見つかりません。')

    const values16 = await readValues16(dir, id)
    const previewDataUrl = await readPreviewDataUrl(dir, id)
    const satelliteDataUrl = await readSatelliteDataUrl(dir, id)
    const mesh = meshFromValues16(values16, entry.width, entry.height, entry.minEle, entry.maxEle)
    return { entry, previewDataUrl, satelliteDataUrl, mesh: meshToPayload(mesh, entry.bbox) }
  })

  // --- ライブラリ: 削除 ---
  ipcMain.handle('library:delete', async (_e, id: string) => {
    const dir = await ensureDataDir()
    return deleteEntry(dir, id)
  })

  // --- ライブラリ: 指定アイテムを PNG16 / R16 で書き出す ---
  ipcMain.handle('library:export', async (_e, id: string, format: 'png16' | 'raw16') => {
    const dir = await ensureDataDir()
    const entries = await readIndex(dir)
    const entry = findEntry(entries, id)
    if (!entry) throw new Error('アイテムが見つかりません。')

    const values16 = await readValues16(dir, id)
    const ext = format === 'png16' ? 'png' : 'r16'
    const fileName = `${entry.id}_${entry.width}x${entry.height}.${ext}`
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
      await exportPng16(filePath, entry.width, entry.height, values16)
    } else {
      await exportRaw16(filePath, values16)
    }
    return { saved: true, filePath }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
