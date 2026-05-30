# ゴール / 要件

## 目的
Mapbox の Terrain タイルからハイトマップを生成・プレビューできる、ローカル完結の
スタンドアロン・デスクトップエディタを作る。参考: [technical-notes.com の Houdini 記事](https://technical-notes.com/houdini/2023/07/23/mapbox-heightmap/)
（Terrain-RGB → 標高デコード）を、ツール内で完結する形で実装する。

## 確定した方針
- **環境**: Electron + TypeScript（electron-vite）。Python は使わない（JS/TS で完結）。
- **地図/位置決め**: MapLibre GL JS（2D 地図で範囲選択）。内部は WebGL だがライブラリ任せ。
- **3D プレビュー**: Three.js（displacement で立体地形）。自前シェーダは書かない。
- **保存先**: プロジェクト直下の `data/` フォルダ（git 管理外）。
- **トークン保存**: OS の userData（`config.json`、平文）。リポジトリには入れない。

## 必須要件
- 2D 地図で範囲を矩形選択し、ズームレベル（解像度）を指定できる。
- Terrain-DEM / Terrain-RGB タイルを並列ダウンロードして合成・クロップする。
- RGB→標高デコード式: `elevation = -10000 + (R*65536 + G*256 + B) * 0.1`
- 16bit 精度を保つ（8bit のテラス化を避ける）。
- プレビュー: 2D グレースケール / 3D 地形（広い画面で確認できること）。
- 生成データを内部（`data/`）に保存してライブラリ化し、再表示・削除できる。
- エクスポート: 16bit PNG / R16 raw（UE / World Machine 互換）。

## やらないこと / 非目標（現時点）
- 厳密な測地・投影変換（pyproj/GDAL 相当）は当面やらない。
- クラウド連携・アカウント機能は持たない（完全ローカル）。

## 想定ユーザー / 出力先
- ハイトマップを Houdini / Unreal / Blender などに取り込みたい個人ユーザー。
- Windows 環境での利用が主。
