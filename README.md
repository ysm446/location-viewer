# Location Viewer

Mapbox の Terrain タイルからロケーションを作成し、地形・地点・ルートを2D/3Dで確認するスタンドアロンのデスクトップアプリ（Electron + TypeScript）。

[technical-notes.com の Houdini 記事](https://technical-notes.com/houdini/2023/07/23/mapbox-heightmap/) の手法（Terrain-RGB → 標高デコード）を、ツール内で完結するように実装したもの。

## 機能（MVP）

- 左の大きな領域を **3タブ**で切替（広い画面で確認）
  - **位置選択**: 2D 地図（MapLibre GL）で範囲を矩形選択
  - **2D ハイトマップ**: グレースケール表示
  - **3D ビュー**: Three.js / WebGL の立体地形（ドラッグ回転・ホイールズーム・高さ強調スライダー・標高別配色）
- ズームレベル（解像度）の指定
- Terrain-DEM / Terrain-RGB タイルの並列ダウンロード＆合成
- RGB → 標高デコード: `elevation = -10000 + (R*65536 + G*256 + B) * 0.1`
- **ライブラリ機能**: 生成（=インポート）すると自動で `data/` に保存し一覧化。クリックで再表示、削除も可能。
- エクスポート: 選択アイテムを **16bit PNG** / **R16 raw**（UE / World Machine 互換）で書き出し

## 必要なもの

- Node.js 18+（確認済み: v24）
- Mapbox アクセストークン（`pk.` で始まるもの）

## 使い方

```bash
npm install
npm run dev        # 開発起動（ホットリロード）
```

1. 右の入力欄に Mapbox アクセストークンを貼り付けて「保存」
   - トークン保存先: OS のユーザーデータ領域（`userData/config.json`）。リポジトリにはコミットされません。
2. 「位置選択」タブの地図で対象地域に移動し、「この表示範囲を選択」（または West/East/South/North を直接入力）
3. ズームレベルを選ぶ（z が大きいほど高解像度・タイル数増）
4. 「ハイトマップ生成（data/ に保存）」→ 自動で `data/` に保存され、ライブラリに追加。生成後は **3D ビュー**に切り替わる
5. ライブラリの項目をクリックすると 2D/3D に再表示。「削除」で `data/` から除去
6. 必要に応じて選択中アイテムを「PNG16 書き出し」/「R16 書き出し」で任意の場所へ

### data/ フォルダの保存物（git 管理外）

| ファイル | 内容 |
|---|---|
| `<id>/workspace.json` | ロケーションのメタ情報、ランドマーク、ルート |
| `<id>/heightmap.u16` | 全解像度の正規化16bit値（Uint16, LE）= 真実のデータ |
| `<id>/preview.png` | 2D タブ用の8bitプレビュー |
| `<id>/satellite.png` | 衛星画像テクスチャ（3D メッシュに貼る。取得できた場合のみ） |
| `landmark-library.json` | 共通ランドマークライブラリのローカル作業コピー |

PNG16 / R16 への書き出しは `<id>/heightmap.u16` から都度生成します。

共通ランドマークライブラリのマスターは `assets/landmarks/landmark-library.json` として git 管理します。起動時に `data/landmark-library.json` が無い場合は、このマスターからローカル作業コピーを作成します。

## ビルド（配布用）

```bash
npm run build      # out/ にバンドル
npm run dist       # electron-builder で Windows インストーラ(nsis)を生成
```

## プロジェクト構成

```
src/
├─ main/              # Electron メインプロセス
│  ├─ index.ts        #   IPC ハンドラ・ウィンドウ・設定保存
│  ├─ tiles.ts        #   緯度経度→タイル計算 / 並列ダウンロード
│  ├─ heightmap.ts    #   タイル合成・標高デコード・16bit書き出し・メッシュ生成
│  └─ library.ts      #   data/ への保存・一覧・削除・読み出し
├─ preload/index.ts   # contextBridge で安全に API を公開
└─ renderer/          # UI（地図 + 設定 + プレビュー + ライブラリ）
   ├─ index.html
   ├─ style.css
   ├─ main.ts         #   MapLibre 地図・範囲選択・生成・タブ制御・ライブラリ
   └─ viewer3d.ts     #   Three.js による3D地形ビューワ
assets/
└─ landmarks/
   └─ landmark-library.json # git 管理する共通ランドマークライブラリのマスター
```

## 今後の拡張候補

- 3D ビューワに**衛星テクスチャ**を貼る（同じ範囲の satellite タイルを取得してマッピング）
- Web Mercator の緯度歪み補正（高緯度での縦横比補正）
- TIFF / EXR 出力
- 標高レンジの手動指定（min/max を固定して複数タイルで段差を揃える）
- 衛星画像の同時ダウンロード＆エクスポート

## メモ

- `mapbox.mapbox-terrain-dem-v1` が現行の推奨ソース。`mapbox.terrain-rgb` は旧版だが式は共通。
- `@2x` で 512px タイルを使用（リクエスト数を削減）。
- 安全のため 1 回の生成は 400 タイルまでに制限している（`src/main/index.ts`）。
