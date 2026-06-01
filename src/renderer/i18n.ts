// 簡易 i18n。data-i18n 属性のテキスト / data-i18n-attr の属性を辞書で差し替える。
// 翻訳が難しい固有名詞は英語のまま使う。

export type Lang = 'ja' | 'en'

type Dict = Record<string, string>

const ja: Dict = {
  'tab.map': '🗺 位置選択',
  'tab.2d': '2D ハイトマップ',
  'tab.3d': '3D ビュー',
  'map.draw': '🖊 矩形を描く',
  'map.draw.title': 'ドラッグで矩形を描いて範囲選択',
  'map.3d': '🗻 3D',
  'map.3d.title': '地図を傾けて立体表示（要トークン）',
  'map.style.title': '地図の種類',
  'map.snap': '2のべき乗',
  'map.snap.title': '出力ピクセルが2のべき乗(512,1024,2048…)になるよう矩形をスナップ',
  'style.satellite': '衛星写真',
  'style.satellite-streets': '衛星＋地名',
  'style.streets': '地図（地名）',
  'style.outdoors': '地形図',
  'bbox.none': '範囲未選択',
  'preview.empty': 'まだ生成・選択されていません',
  'view3d.satellite': '衛星画像',
  'view3d.render': '描画',
  'render.default': 'デフォルト',
  'render.heightmap': 'ハイトマップ',
  'render.satellite': '衛星画像',
  'view3d.autorotate': '自動回転（縦軸・約2°/秒）',
  'view3d.hint': 'ドラッグ=回転 / ホイール=ズーム / 中・右ドラッグ=パン',
  'view3d.size': 'サイズ',
  'view3d.height': '高さ（標高差）',
  'view3d.elevation': '標高',
  'view3d.pixels': '解像度',
  'side.token': 'Mapbox アクセストークン',
  'btn.save': '保存',
  'side.source': '標高ソース',
  'source.dem': 'Mapbox Terrain-DEM v1 (推奨)',
  'source.rgb': 'Mapbox Terrain-RGB v1 (旧)',
  'side.zoom': 'ズームレベル (解像度):',
  'btn.generate': '新規ロケーション作成',
  'terrain.update': '選択中の地形を更新',
  'terrain.updateConfirm':
    '選択中ロケーションの地形を、現在の範囲・ズーム・ソースで再生成します。よろしいですか？（地点は保持されます）',
  'side.library': 'ロケーション',
  'rtab.library': 'ロケーション',
  'rtab.settings': '環境設定',
  'settings.view3d': '3D ビュー',
  'settings.autoFit': 'ロケーション切替時に自動でフィット（全体が収まるように）',
  'settings.scaleAnnotations': '地点マーカー・線・ラベルを地形スケールに合わせて拡縮',
  'settings.fov': 'カメラの画角',
  'settings.fovReset': '初期値に戻す',
  'settings.transition': '切替トランジション',
  'transition.none': 'なし',
  'transition.slide': '横スライド',
  'transition.wipe': 'ワイプ',
  'transition.morph': 'ハイト・モーフ',
  'selected.none': '選択なし',
  'btn.exportPng': 'PNG16 書き出し',
  'btn.exportRaw': 'R16 書き出し',
  'side.language': '言語 / Language',
  'lib.delete': '削除',
  'lib.rename': '名前を変更',
  'lib.reorder': 'ドラッグで並べ替え',
  'lib.enter': '中に入る',
  'lib.deleteConfirm': 'を削除しますか？（data/ から削除されます）',
  'landmark.title': 'ランドマーク',
  'landmark.add': '📍 地点を追加',
  'landmark.hint': '3Dビューで地形をクリックして地点を追加',
  'landmark.defaultName': '地点',
  'landmark.elev': '標高',
  'landmark.count': '地点',
  'landmark.show': '地点を表示',
  'ws.back': '← ロケーション一覧',
  'token.saved': 'トークンを保存しました。',
  'token.empty': 'トークンが空です。',
  'token.loaded': '保存済みトークンを読み込みました。',
  'gen.preparing': '準備中…',
  'gen.downloading': 'ダウンロード中…',
  'gen.tiles': 'タイル',
  'gen.savedToData': '完了 → data/ に保存',
  'gen.fetchingSatellite': '衛星画像を取得中…',
  'gen.doneWithSatellite': '完了（衛星画像つき）→ data/ に保存',
  'gen.doneNoSatellite': '完了（標高のみ）。衛星画像の取得に失敗: ',
  'gen.failed': '生成に失敗しました: ',
  'alert.selectRange': '先に範囲を選択してください。',
  'alert.saveToken': 'Mapbox トークンを保存してください。',
  'estimate.initial': '推定: -',
  'estimate.needRange': '推定: 範囲を選択してください',
  'estimate.output': '推定出力:',
  'estimate.tileOver': '⚠タイル上限超過',
  'load.loading': '読み込み中…',
  'load.failed': '読み込みに失敗しました: ',
  'export.saved': '書き出し: ',
  'count.items': '件'
}

const en: Dict = {
  'tab.map': '🗺 Location',
  'tab.2d': '2D Heightmap',
  'tab.3d': '3D View',
  'map.draw': '🖊 Draw box',
  'map.draw.title': 'Drag to draw a selection rectangle',
  'map.3d': '🗻 3D',
  'map.3d.title': 'Tilt the map for 3D terrain (token required)',
  'map.style.title': 'Map type',
  'map.snap': 'Pow2',
  'map.snap.title': 'Snap the box so output pixels become a power of 2 (512,1024,2048…)',
  'style.satellite': 'Satellite',
  'style.satellite-streets': 'Satellite + labels',
  'style.streets': 'Map (labels)',
  'style.outdoors': 'Outdoors',
  'bbox.none': 'No area selected',
  'preview.empty': 'Nothing generated or selected yet',
  'view3d.satellite': 'Satellite',
  'view3d.render': 'Render',
  'render.default': 'Default',
  'render.heightmap': 'Heightmap',
  'render.satellite': 'Satellite',
  'view3d.autorotate': 'Auto-rotate (vertical, ~2°/s)',
  'view3d.hint': 'Drag = rotate / Wheel = zoom / Middle・Right drag = pan',
  'view3d.size': 'Size',
  'view3d.height': 'Height (relief)',
  'view3d.elevation': 'Elevation',
  'view3d.pixels': 'Resolution',
  'side.token': 'Mapbox access token',
  'btn.save': 'Save',
  'side.source': 'Elevation source',
  'source.dem': 'Mapbox Terrain-DEM v1 (recommended)',
  'source.rgb': 'Mapbox Terrain-RGB v1 (legacy)',
  'side.zoom': 'Zoom level (resolution):',
  'btn.generate': 'New location',
  'terrain.update': 'Update terrain of selection',
  'terrain.updateConfirm':
    "Regenerate the selected location's terrain with the current range/zoom/source? (Landmarks are kept.)",
  'side.library': 'Locations',
  'rtab.library': 'Locations',
  'rtab.settings': 'Settings',
  'settings.view3d': '3D view',
  'settings.autoFit': 'Auto-fit on location switch (fit the whole terrain)',
  'settings.scaleAnnotations': 'Scale point markers, lines and labels with terrain',
  'settings.fov': 'Camera field of view',
  'settings.fovReset': 'Reset to default',
  'settings.transition': 'Switch transition',
  'transition.none': 'None',
  'transition.slide': 'Slide',
  'transition.wipe': 'Wipe',
  'transition.morph': 'Height morph',
  'selected.none': 'No selection',
  'btn.exportPng': 'Export PNG16',
  'btn.exportRaw': 'Export R16',
  'side.language': 'Language / 言語',
  'lib.delete': 'Delete',
  'lib.rename': 'Rename',
  'lib.reorder': 'Drag to reorder',
  'lib.enter': 'Open',
  'lib.deleteConfirm': ' — delete this item? (removed from data/)',
  'landmark.title': 'Landmarks',
  'landmark.add': '📍 Add point',
  'landmark.hint': 'Click the terrain in the 3D view to add a point',
  'landmark.defaultName': 'Point',
  'landmark.elev': 'Elev',
  'landmark.count': ' pts',
  'landmark.show': 'Show points',
  'ws.back': '← Locations',
  'token.saved': 'Token saved.',
  'token.empty': 'Token is empty.',
  'token.loaded': 'Loaded saved token.',
  'gen.preparing': 'Preparing…',
  'gen.downloading': 'Downloading…',
  'gen.tiles': 'tiles',
  'gen.savedToData': 'Done → saved to data/',
  'gen.fetchingSatellite': 'Fetching satellite imagery…',
  'gen.doneWithSatellite': 'Done (with satellite) → saved to data/',
  'gen.doneNoSatellite': 'Done (elevation only). Satellite fetch failed: ',
  'gen.failed': 'Generation failed: ',
  'alert.selectRange': 'Please select an area first.',
  'alert.saveToken': 'Please save your Mapbox token.',
  'estimate.initial': 'Estimate: -',
  'estimate.needRange': 'Estimate: select an area',
  'estimate.output': 'Output:',
  'estimate.tileOver': '⚠ tile limit exceeded',
  'load.loading': 'Loading…',
  'load.failed': 'Failed to load: ',
  'export.saved': 'Saved: ',
  'count.items': ' items'
}

const dicts: Record<Lang, Dict> = { ja, en }
let current: Lang = 'ja'

export function setLang(lang: Lang) {
  current = lang
  document.documentElement.lang = lang
  applyDom()
}

export function getLang(): Lang {
  return current
}

/** キーから訳語を取得（無ければキーをそのまま返す） */
export function t(key: string): string {
  return dicts[current][key] ?? dicts.ja[key] ?? key
}

/** data-i18n / data-i18n-attr-* を持つ要素にまとめて適用する */
export function applyDom(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')!
    el.textContent = t(key)
  })
  // data-i18n-title / data-i18n-placeholder
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')!))
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')!))
  })
}
