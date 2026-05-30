import { contextBridge, ipcRenderer } from 'electron'
import type { BBox } from '../main/tiles'
import type { Workspace, HeightmapMeta, Landmark } from '../main/library'

export type { Workspace, HeightmapMeta, Landmark }

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
  /** 出力範囲の緯度経度（ランドマークの座標変換に使う） */
  bbox: BBox
  heights: ArrayBuffer
}

/** 地形を生成/更新した結果（新規作成・更新で共通） */
export interface TerrainResult {
  workspace: Workspace
  tileCount: number
  previewDataUrl: string
  mesh: MeshPayload
}

/** ワークスペース1件の表示用データ */
export interface WorkspaceData {
  workspace: Workspace
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
  lang?: 'ja' | 'en'
  snapPow2?: boolean
}

const api = {
  getConfig: (): Promise<{ token?: string }> => ipcRenderer.invoke('config:get'),
  setToken: (token: string): Promise<boolean> => ipcRenderer.invoke('config:setToken', token),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: AppSettings): Promise<boolean> =>
    ipcRenderer.invoke('settings:set', patch),
  // ワークスペース（地形を生成して新規作成 / 既存の地形を更新）
  createWorkspace: (args: GenerateArgs): Promise<TerrainResult> =>
    ipcRenderer.invoke('workspace:create', args),
  updateHeightmap: (id: string, args: GenerateArgs): Promise<TerrainResult> =>
    ipcRenderer.invoke('workspace:updateHeightmap', id, args),
  listWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke('workspace:list'),
  getWorkspace: (id: string): Promise<WorkspaceData> => ipcRenderer.invoke('workspace:get', id),
  deleteWorkspace: (id: string): Promise<boolean> => ipcRenderer.invoke('workspace:delete', id),
  renameWorkspace: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('workspace:rename', id, name),
  reorderWorkspaces: (ids: string[]): Promise<boolean> =>
    ipcRenderer.invoke('workspace:reorder', ids),
  // ランドマーク
  saveLandmarks: (id: string, landmarks: Landmark[]): Promise<boolean> =>
    ipcRenderer.invoke('workspace:saveLandmarks', id, landmarks),
  sampleElevation: (id: string, lng: number, lat: number): Promise<number | null> =>
    ipcRenderer.invoke('workspace:sampleElevation', id, lng, lat),
  getThumb: (id: string): Promise<string | null> => ipcRenderer.invoke('workspace:thumb', id),
  exportItem: (
    id: string,
    format: 'png16' | 'raw16'
  ): Promise<{ saved: boolean; filePath?: string }> =>
    ipcRenderer.invoke('workspace:export', id, format),
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
