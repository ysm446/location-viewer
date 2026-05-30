import { contextBridge, ipcRenderer } from 'electron'
import type { BBox } from '../main/tiles'
import type { LibraryEntry } from '../main/library'

export type { LibraryEntry }

export interface GenerateArgs {
  bbox: BBox
  zoom: number
  sourceId: string
  rangeMin?: number
  rangeMax?: number
}

export interface MeshPayload {
  cols: number
  rows: number
  aspect: number
  minEle: number
  maxEle: number
  /** 地表の実サイズ（メートル）。3D を実寸表示するために使う */
  widthMeters: number
  heightMeters: number
  heights: ArrayBuffer
}

export interface GenerateResult {
  entry: LibraryEntry
  tileCount: number
  previewDataUrl: string
  mesh: MeshPayload
}

export interface LibraryItem {
  entry: LibraryEntry
  previewDataUrl: string
  satelliteDataUrl: string | null
  mesh: MeshPayload
}

export interface SatelliteTile {
  x: number
  y: number
  dataUrl: string
}
export interface SatelliteTilesPayload {
  outWidth: number
  outHeight: number
  left: number
  top: number
  tileSize: number
  tiles: SatelliteTile[]
}

export interface AppSettings {
  mapStyle?: string
}

const api = {
  getConfig: (): Promise<{ token?: string }> => ipcRenderer.invoke('config:get'),
  setToken: (token: string): Promise<boolean> => ipcRenderer.invoke('config:setToken', token),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: AppSettings): Promise<boolean> =>
    ipcRenderer.invoke('settings:set', patch),
  generate: (args: GenerateArgs): Promise<GenerateResult> =>
    ipcRenderer.invoke('heightmap:generate', args),
  // ライブラリ
  listLibrary: (): Promise<LibraryEntry[]> => ipcRenderer.invoke('library:list'),
  getLibraryItem: (id: string): Promise<LibraryItem> => ipcRenderer.invoke('library:get', id),
  deleteLibraryItem: (id: string): Promise<boolean> => ipcRenderer.invoke('library:delete', id),
  exportItem: (
    id: string,
    format: 'png16' | 'raw16'
  ): Promise<{ saved: boolean; filePath?: string }> =>
    ipcRenderer.invoke('library:export', id, format),
  // 衛星画像
  fetchSatellite: (bbox: BBox, zoom: number): Promise<SatelliteTilesPayload> =>
    ipcRenderer.invoke('satellite:fetch', { bbox, zoom }),
  saveSatellite: (id: string, pngDataUrl: string): Promise<boolean> =>
    ipcRenderer.invoke('satellite:save', id, pngDataUrl),
  onProgress: (cb: (p: { done: number; total: number; phase?: string }) => void) => {
    ipcRenderer.on('heightmap:progress', (_e, p) => cb(p))
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
