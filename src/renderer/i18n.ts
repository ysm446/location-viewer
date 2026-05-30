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
  'map.useView': '表示範囲を選択',
  'map.style.title': '地図の種類',
  'style.satellite': '衛星写真',
  'style.satellite-streets': '衛星＋地名',
  'style.streets': '地図（地名）',
  'style.outdoors': '地形図',
  'bbox.none': '範囲未選択',
  'preview.empty': 'まだ生成・選択されていません',
  'view3d.exaggeration': '高さ強調 (1.0=実寸)',
  'view3d.satellite': '衛星画像',
  'view3d.hint': 'ドラッグ=回転 / ホイール=ズーム / 中・右ドラッグ=パン',
  'side.token': 'Mapbox アクセストークン',
  'btn.save': '保存',
  'side.source': '標高ソース',
  'source.dem': 'Mapbox Terrain-DEM v1 (推奨)',
  'source.rgb': 'Mapbox Terrain-RGB v1 (旧)',
  'side.zoom': 'ズームレベル (解像度):',
  'btn.generate': 'ハイトマップ生成（data/ に保存）',
  'side.library': 'ライブラリ（data/）',
  'selected.none': '選択なし',
  'btn.exportPng': 'PNG16 書き出し',
  'btn.exportRaw': 'R16 書き出し',
  'side.language': '言語 / Language',
  'lib.delete': '削除',
  'lib.deleteConfirm': 'を削除しますか？（data/ から削除されます）',
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
  'map.useView': 'Use current view',
  'map.style.title': 'Map type',
  'style.satellite': 'Satellite',
  'style.satellite-streets': 'Satellite + labels',
  'style.streets': 'Map (labels)',
  'style.outdoors': 'Outdoors',
  'bbox.none': 'No area selected',
  'preview.empty': 'Nothing generated or selected yet',
  'view3d.exaggeration': 'Height scale (1.0 = real)',
  'view3d.satellite': 'Satellite',
  'view3d.hint': 'Drag = rotate / Wheel = zoom / Middle・Right drag = pan',
  'side.token': 'Mapbox access token',
  'btn.save': 'Save',
  'side.source': 'Elevation source',
  'source.dem': 'Mapbox Terrain-DEM v1 (recommended)',
  'source.rgb': 'Mapbox Terrain-RGB v1 (legacy)',
  'side.zoom': 'Zoom level (resolution):',
  'btn.generate': 'Generate heightmap (save to data/)',
  'side.library': 'Library (data/)',
  'selected.none': 'No selection',
  'btn.exportPng': 'Export PNG16',
  'btn.exportRaw': 'Export R16',
  'side.language': 'Language / 言語',
  'lib.delete': 'Delete',
  'lib.deleteConfirm': ' — delete this item? (removed from data/)',
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
