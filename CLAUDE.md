# CLAUDE.md

このファイルは Claude Code（および将来の自分）がこのリポジトリで作業するための指針です。

## プロジェクト概要
Mapbox の Terrain タイルからハイトマップを生成・プレビューする、ローカル完結の
スタンドアロン・デスクトップアプリ（Electron + TypeScript）。
詳細な目的・要件は [docs/goals.md](docs/goals.md) を参照。

## ⚠️ 作業ごとに docs/ を更新する（最重要ルール）
**まとまった作業（機能追加・修正・方針変更など）が終わるたびに、必ず `docs/` 内の
該当ファイルを更新すること。** 更新を忘れない。

- [docs/goals.md](docs/goals.md) … 目的・要件・確定方針。**要件や方針が変わったときだけ**更新。
- [docs/plan.md](docs/plan.md) … これからやること（ロードマップ）。着手・完了で項目を移動する。
- [docs/progress.md](docs/progress.md) … 現在の状態・完了/未完了チェックリスト。**毎回**「最終更新」日付を更新。
- [docs/changelog.md](docs/changelog.md) … 変更履歴。**毎回**、その日の作業内容を新しい順（上）に追記。

日付は実際の当日の日付（YYYY-MM-DD）を使う。相対表現（「今日」等）は使わない。

## 技術スタック
- Electron + TypeScript、ビルドは electron-vite。
- 地図/位置決め: MapLibre GL JS（`src/renderer/main.ts`）。
- 3D プレビュー: Three.js（`src/renderer/viewer3d.ts`）。
- 画像処理: pngjs（メインプロセス側）。Python は使わない。

## ディレクトリ
```
src/
├─ main/        Electron メインプロセス
│  ├─ index.ts      IPC・ウィンドウ・設定/トークン保存
│  ├─ tiles.ts      緯度経度→タイル計算・並列ダウンロード
│  ├─ heightmap.ts  合成・標高デコード・16bit/raw 出力・メッシュ生成
│  └─ library.ts    data/ への保存・一覧・削除・読み出し
├─ preload/index.ts contextBridge で API 公開（出力は .cjs）
└─ renderer/    UI
   ├─ index.html / style.css
   ├─ main.ts        地図・範囲選択・生成・タブ・ライブラリ
   └─ viewer3d.ts    Three.js 3D 地形ビューワ
docs/           goals / plan / progress / changelog（作業ごとに更新）
data/           生成物の保存先（git 管理外）
```

## 開発コマンド
- `npm run dev` … 開発起動（`start.bat` でも可）。
- `npm run build` … `out/` にバンドル。
- `npx tsc --noEmit` … 型チェック。
- `npm run dist` … 配布用インストーラ（electron-builder）。

**変更後は最低限 `npx tsc --noEmit` と `npm run build` を通すこと。**

## 重要な約束ごと（ハマりどころ）
- **保存先は `data/`**。生成データ・エクスポートは `data/` を既定にする。`data/` は `.gitignore` 済み。
- **トークン**は userData の `config.json`（平文）。コミットしない。
- **preload は `.cjs`** で出力（sandbox 環境で読めるように）。
- メインプロセスで **`app.getPath` をモジュール最上位で呼ばない**（起動クラッシュの原因）。関数内で遅延呼び出し。
- **`.bat` は ASCII のみ**で書く（日本語版 Windows / CP932 での文字化け回避）。
- 標高デコード式: `elevation = -10000 + (R*65536 + G*256 + B) * 0.1`。
- 16bit 精度を維持する（8bit に落とすのはプレビュー用途のみ）。
- データの真実は `data/<id>.u16`（全解像度・正規化16bit・LE）。PNG16/R16 はここから都度生成。

## コミット方針
- コミット/プッシュは**ユーザーの指示があったときだけ**行う。
- コミット前に型チェック・ビルドを通す。docs/ の更新も忘れずに含める。
