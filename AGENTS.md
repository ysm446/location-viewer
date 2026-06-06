# AGENTS.md

## ⚠️ 作業ごとに docs/ を更新する（最重要ルール）

**まとまった作業（機能追加・修正・方針変更など）が終わるたびに、必ず `docs/` 内の
該当ファイルを更新すること。** 更新を忘れない。

- [docs/goals.md](docs/goals.md) … 目的・要件・確定方針。**要件や方針が変わったときだけ**更新。
- [docs/plan.md](docs/plan.md) … これからやること（ロードマップ）。着手・完了で項目を移動する。
- [docs/progress.md](docs/progress.md) … 現在の状態・完了/未完了チェックリスト。**毎回**「最終更新」日付を更新。
- [docs/changelog.md](docs/changelog.md) … 変更履歴。**毎回**、その日の作業内容を新しい順（上）に追記。

日付は実際の当日の日付（YYYY-MM-DD）を使う。相対表現（「今日」等）は使わない。

## Place Name Coordinate Policy

When adding or correcting landmark coordinates, use the most reliable source available and record the reasoning in the final response.

Priority order:

1. Use official or authoritative coordinates when available.
   - Prefer government, park, observatory, map authority, or well-known mountain/route databases.
   - Wikipedia can be useful, but verify that the page refers to the same place, not a same-name location elsewhere.
2. Cross-check same-name places carefully.
   - Many Japanese landmarks share names such as `Goshikinuma`, `Takayama`, or `Horaiyama`.
   - Confirm the surrounding geography, nearby landmarks, municipality, and elevation before trusting coordinates.
3. Compare coordinates against local DEM and satellite imagery.
   - Sample the stored heightmap at the candidate coordinate.
   - If the registered elevation and sampled DEM differ greatly, treat the coordinate as suspicious unless the feature explains the mismatch.
   - For lakes, wetlands, ponds, broad facilities, and other area features, choose a representative point appropriate for labels, usually the visible center of the feature.
4. Use visual/imagery-based placement only when direct coordinate sources are missing, ambiguous, or likely wrong.
   - Use satellite imagery plus DEM elevation as a consistency check.
   - For water bodies, prefer the center of the visible water surface over a shore, trail viewpoint, or nearby named area unless the user asks otherwise.
5. Be explicit about confidence.
   - Say whether a coordinate came from an external source, DEM/satellite confirmation, or manual visual adjustment.
   - Mention ambiguous cases instead of silently treating them as certain.

Notes for this project:

- Generated location data under `data/` is ignored by Git, so coordinate fixes there will not appear in `git diff` or commits.
- The app uses Web Mercator tile coordinates; when validating a point against `heightmap.u16`, use the same projection math as `src/main/heightmap.ts`.
- For labels in the 3D view, the practical goal is a clear and natural label anchor, not always a legal cadastral point.
