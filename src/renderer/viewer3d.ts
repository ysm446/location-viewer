// 生成したハイトマップを Three.js で立体プレビューするビューワ。
// 平面ジオメトリの各頂点 Z を標高で押し出す（displacement 相当）。
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { MeshPayload, Landmark } from '../preload/index'

// 全地形で共通の表示スケール（メートル→ワールド単位）。地形ごとに正規化せず
// 固定倍率で表示するので、ワークスペースを切り替えると実サイズの差がそのまま見える。
// 1ワールド単位 = この実距離(m)。約10km四方の地形が最大辺 2 ワールド単位に収まる目安。
const METERS_PER_WORLD_UNIT = 5000
const WORLD_SCALE = 1 / METERS_PER_WORLD_UNIT

/** lng/lat → メッシュのローカル座標変換に必要な情報 */
interface GeoContext {
  bbox: { west: number; south: number; east: number; north: number }
  minEle: number
  widthMeters: number
  heightMeters: number
  k: number // 表示用の一様スケール
  // 表示メッシュの高さグリッド（地点をメッシュ表面へ接地させるのに使う）
  cols: number
  rows: number
  heights: Float32Array // 標高(メートル), row-major（r=北→南, c=西→東）
}

export class TerrainViewer {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private mesh: THREE.Mesh | null = null
  private grid: THREE.GridHelper | null = null
  // グリッド中心軸の端に置く距離ラベル（中心から端までの km）
  private axisLabels: THREE.Sprite[] = []
  private container: HTMLElement
  private raf = 0
  // スムーズズーム: ホイールで目標距離(注視点からの半径)を設定し、毎フレーム補間で寄せる。
  // null のときはズーム停止中。
  private zoomTarget: number | null = null
  private zoomTmp = new THREE.Vector3()
  // ワークスペース切替時に、全体が収まる距離へカメラを自動でフィット（寄せ/引き両方）。
  private autoFit = false
  // 注釈（地点マーカー・リーダー線・ラベル・軸ラベル）を地形スケールに合わせて拡縮するか。
  private scaleAnnotations = false
  // 注釈サイズの倍率。基準は旧正規化の「最大辺=2」。scaleAnnotations が ON のとき
  // 地形の実ワールドサイズに比例させ、OFF なら常に 1（絶対サイズ固定）。
  private annotScale = 1
  private resizeObs: ResizeObserver
  // 左下の軸ギズモ（別シーンを小さなビューポートに描画）
  private gizmoScene = new THREE.Scene()
  private gizmoCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10)
  /** 衛星テクスチャ（読み込み済み）と描画モード */
  private satelliteTex: THREE.Texture | null = null
  /** default=地形配色 / heightmap=標高グレースケール / satellite=衛星テクスチャ */
  private renderMode: 'default' | 'heightmap' | 'satellite' = 'default'
  // ランドマーク（地点）描画
  private geo: GeoContext | null = null
  private landmarks: Landmark[] = []
  private landmarkGroup: THREE.Group | null = null
  private landmarksVisible = true
  // 地点編集（詳細）モードのときだけ true。false の間はピンをドラッグ移動できない（誤操作防止）。
  private landmarksEditable = false
  // 地点ごとの描画オブジェクト（ドラッグ移動時に位置を更新する）
  private landmarkObjs = new Map<string, { marker: THREE.Mesh; line: THREE.Line; label: THREE.Sprite }>()
  private markerMeshes: THREE.Mesh[] = [] // レイキャスト用（クリック判定）
  private labelStem = new Map<string, number>() // 地点ごとのリーダー線の現在長（スムーズ移動用）
  // 3Dクリックで地点を配置するモード
  private raycaster = new THREE.Raycaster()
  private placeMode = false
  private onPlace: ((lng: number, lat: number) => void) | null = null
  // 地点のドラッグ移動
  private draggingId: string | null = null
  private onMoveLandmark: ((id: string, lng: number, lat: number) => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setClearColor(0x111417)
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100)
    this.camera.position.set(0, 1.2, 1.6)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    // ホイールズームは OrbitControls の即時適用ではなく、自前のスムーズズームで行う。
    this.controls.enableZoom = false
    this.controls.target.set(0, 0, 0)
    this.renderer.domElement.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        if (!this.controls.enabled) return
        const cur = this.camera.position.distanceTo(this.controls.target)
        const base = this.zoomTarget ?? cur
        // OrbitControls と同じ刻み（zoomSpeed=1 で 1ノッチ約5%）。
        const step = Math.pow(0.95, this.controls.zoomSpeed * Math.abs(e.deltaY * 0.01))
        const next = e.deltaY < 0 ? base * step : base / step
        // 注視点に貫通しない最小距離だけ確保（上限は設けない）。
        this.zoomTarget = Math.max(0.01, next)
      },
      { passive: false }
    )
    // マウスボタン割り当て: 左=回転 / 中=パン / 右=パン
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN
    }
    // 中ボタンドラッグでブラウザの自動スクロールが出ないように抑止
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 1) e.preventDefault()
    })

    const dom = this.renderer.domElement
    let downX = 0
    let downY = 0
    let moved = false

    // 地点マーカーを掴んだら OrbitControls より先に捕捉してドラッグ開始（capture フェーズ）。
    dom.addEventListener(
      'pointerdown',
      (e) => {
        // 編集モード外・配置モード中・非表示時はドラッグ開始しない（誤操作防止）
        if (e.button !== 0 || this.placeMode || !this.landmarksVisible || !this.landmarksEditable)
          return
        const id = this.markerHitId(e)
        if (!id) return
        // OrbitControls（回転）へ渡さない
        e.stopPropagation()
        e.preventDefault()
        this.draggingId = id
        this.controls.enabled = false
        dom.style.cursor = 'grabbing'
        dom.setPointerCapture(e.pointerId)
      },
      true
    )

    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        downX = e.clientX
        downY = e.clientY
        moved = false
      }
    })
    dom.addEventListener('pointermove', (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true
      // ドラッグ中：地形上の位置に追従させる
      if (this.draggingId) {
        const p = this.terrainHit(e)
        if (p) this.moveLandmarkObjects(this.draggingId, p)
        return
      }
      // ホバー時のカーソル（配置モードは crosshair のまま）。編集モード時のみ grab を出す。
      if (!this.placeMode) {
        dom.style.cursor = this.landmarksEditable && this.markerHitId(e) ? 'grab' : ''
      }
    })
    dom.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return
      // 地点ドラッグの確定
      if (this.draggingId) {
        const id = this.draggingId
        this.draggingId = null
        this.controls.enabled = true
        dom.style.cursor = this.markerHitId(e) ? 'grab' : ''
        const p = this.terrainHit(e)
        const ll = p && this.pointToLngLat(p)
        if (ll) this.onMoveLandmark?.(id, ll.lng, ll.lat)
        return
      }
      // 配置モード：ドラッグでない左クリックで地点を打つ
      if (this.placeMode && !moved) {
        const p = this.terrainHit(e)
        const ll = p && this.pointToLngLat(p)
        if (ll) this.onPlace?.(ll.lng, ll.lat)
      }
    })

    // ライティング
    const dir = new THREE.DirectionalLight(0xffffff, 2.2)
    dir.position.set(1, 2, 1)
    this.scene.add(dir)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5))

    this.buildGizmo()

    this.resizeObs = new ResizeObserver(() => this.resize())
    this.resizeObs.observe(container)
    this.resize()
    this.animate()
  }

  /** 左下に表示する小さな軸ギズモを組み立てる（東=X赤 / 上=Y緑(矢印のみ) / 北=Z青） */
  private buildGizmo() {
    const len = 0.8
    const mk = (dir: THREE.Vector3, color: number, label?: string) => {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), len, color, 0.25, 0.15)
      this.gizmoScene.add(arrow)
      if (label) {
        const sp = makeTextSprite(label, color)
        sp.position.copy(dir.clone().multiplyScalar(len + 0.25))
        sp.scale.set(0.5, 0.5, 0.5)
        this.gizmoScene.add(sp)
      }
    }
    // 北を -Z にしているので、ギズモの「N」も -Z に置く
    mk(new THREE.Vector3(1, 0, 0), 0xff5555, 'E')
    mk(new THREE.Vector3(0, 1, 0), 0x55ff55) // 上方向は矢印のみ（ラベルなし）
    mk(new THREE.Vector3(0, 0, -1), 0x5599ff, 'N')
    this.gizmoCamera.position.set(0, 0, 3)
  }

  /** カメラの自動回転（縦軸まわり）の ON/OFF。約2°/秒。 */
  setAutoRotate(on: boolean) {
    this.controls.autoRotate = on
    this.controls.autoRotateSpeed = 0.333 // 6×speed[deg/s] ≒ 2°/秒（60fps想定）
  }

  /** ランドマーク一覧を設定して描画する */
  setLandmarks(landmarks: Landmark[]) {
    this.landmarks = landmarks
    this.renderLandmarks()
  }

  /** ランドマークの表示/非表示を切り替える */
  setLandmarksVisible(on: boolean) {
    this.landmarksVisible = on
    if (this.landmarkGroup) this.landmarkGroup.visible = on
  }

  /** 地点編集（詳細）モードの ON/OFF。OFF の間はピンのドラッグ移動を禁止する。 */
  setLandmarksEditable(on: boolean) {
    this.landmarksEditable = on
    // 編集解除時に進行中のドラッグがあれば打ち切り、操作系を通常へ戻す。
    if (!on && this.draggingId) {
      this.draggingId = null
      this.controls.enabled = true
      this.renderer.domElement.style.cursor = ''
    }
  }

  /** 地点をドラッグ移動して確定したときのコールバックを登録する */
  setLandmarkMoveHandler(cb: (id: string, lng: number, lat: number) => void) {
    this.onMoveLandmark = cb
  }

  /** マウス位置直下にある地点マーカーの id を返す（無ければ null） */
  private markerHitId(e: PointerEvent): string | null {
    if (!this.markerMeshes.length) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObjects(this.markerMeshes)[0]
    return hit ? (hit.object.userData.landmarkId as string) : null
  }

  /** マウス位置から地形メッシュへレイキャストしたワールド座標を返す */
  private terrainHit(e: PointerEvent): THREE.Vector3 | null {
    if (!this.mesh) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    return this.raycaster.intersectObject(this.mesh)[0]?.point ?? null
  }

  /** ワールド座標 → 緯度経度（メッシュのローカル→bbox の逆変換） */
  private pointToLngLat(p: THREE.Vector3): { lng: number; lat: number } | null {
    const g = this.geo
    if (!g) return null
    const u = p.x / (g.widthMeters * g.k) + 0.5
    const v = p.z / (g.heightMeters * g.k) + 0.5
    return {
      lng: g.bbox.west + u * (g.bbox.east - g.bbox.west),
      lat: g.bbox.north - v * (g.bbox.north - g.bbox.south)
    }
  }

  /** 表示メッシュ表面のワールドY座標を (u,v) で返す（高さグリッドをバイリニア補間） */
  private surfaceWorldY(u: number, v: number): number {
    const g = this.geo
    if (!g) return 0
    const fc = Math.max(0, Math.min(g.cols - 1, u * (g.cols - 1)))
    const fr = Math.max(0, Math.min(g.rows - 1, v * (g.rows - 1)))
    const c0 = Math.floor(fc)
    const r0 = Math.floor(fr)
    const c1 = Math.min(g.cols - 1, c0 + 1)
    const r1 = Math.min(g.rows - 1, r0 + 1)
    const tx = fc - c0
    const ty = fr - r0
    const h = g.heights
    const e00 = h[r0 * g.cols + c0]
    const e10 = h[r0 * g.cols + c1]
    const e01 = h[r1 * g.cols + c0]
    const e11 = h[r1 * g.cols + c1]
    const ele = (e00 * (1 - tx) + e10 * tx) * (1 - ty) + (e01 * (1 - tx) + e11 * tx) * ty
    return (ele - g.minEle) * g.k
  }

  /** ドラッグ中：地点のマーカー・線・ラベルを地形上の base 位置へ移動する */
  private moveLandmarkObjects(id: string, base: THREE.Vector3) {
    const o = this.landmarkObjs.get(id)
    if (!o) return
    const top = base.y + 0.4
    o.marker.position.set(base.x, base.y, base.z)
    const pos = o.line.geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(0, base.x, base.y, base.z)
    pos.setXYZ(1, base.x, top, base.z)
    pos.needsUpdate = true
    o.label.position.set(base.x, top + 0.06, base.z)
  }

  /** 3Dクリックで地点を配置するモードの ON/OFF。cb に lng/lat を返す */
  setPlaceMode(on: boolean, cb?: (lng: number, lat: number) => void) {
    this.placeMode = on
    this.onPlace = on ? cb ?? null : null
    this.renderer.domElement.style.cursor = on ? 'crosshair' : ''
    // 配置中は誤回転を避けるため左ドラッグ回転を一時停止
    this.controls.enableRotate = !on
  }

  /** 現在の geo と landmarks からマーカー（リーダー線＋ラベル）を作り直す */
  private renderLandmarks() {
    if (this.landmarkGroup) {
      this.scene.remove(this.landmarkGroup)
      this.landmarkGroup.traverse((o) => {
        const any = o as THREE.Mesh & THREE.Sprite
        any.geometry?.dispose?.()
        const m = any.material as THREE.Material & { map?: THREE.Texture }
        if (m) {
          m.map?.dispose?.()
          m.dispose?.()
        }
      })
      this.landmarkGroup = null
    }
    this.landmarkObjs.clear()
    this.markerMeshes = []
    const g = this.geo
    if (!g || this.landmarks.length === 0) return

    const group = new THREE.Group()
    const s = this.annotScale // 注釈倍率（地形スケール連動 or 固定）
    const stem = 0.4 * s // リーダー線の長さ（ワールド単位。基準は最大辺=2）
    const markerGeo = new THREE.SphereGeometry(0.013 * s, 12, 12)
    for (const lm of this.landmarks) {
      if (lm.visible === false) continue // 個別に非表示の地点はスキップ
      const u = (lm.lng - g.bbox.west) / (g.bbox.east - g.bbox.west || 1)
      const v = (g.bbox.north - lm.lat) / (g.bbox.north - g.bbox.south || 1)
      const x = (u - 0.5) * g.widthMeters * g.k
      const z = (v - 0.5) * g.heightMeters * g.k
      // 根本は「保存標高」ではなく表示メッシュ表面に合わせる（DEM平滑化や標高手入力でも浮かない）
      const surfaceY = this.surfaceWorldY(u, v)
      const topY = surfaceY + stem

      // 地表の点＝ドラッグ用マーカー（クリック判定の対象。常に見えるよう深度テスト無効）
      const marker = new THREE.Mesh(
        markerGeo,
        new THREE.MeshBasicMaterial({ color: 0xffd24d, depthTest: false, transparent: true })
      )
      marker.position.set(x, surfaceY, z)
      marker.renderOrder = 12
      marker.userData.landmarkId = lm.id
      group.add(marker)
      this.markerMeshes.push(marker)

      // リーダー線（地形に隠れず常に見えるよう深度テスト無効）
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, surfaceY, z),
        new THREE.Vector3(x, topY, z)
      ])
      const line = new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({ color: 0xcccccc, depthTest: false, transparent: true })
      )
      line.renderOrder = 10
      group.add(line)

      // ラベル（名前＋標高）
      const label = makeLabelSprite(`${lm.name}\n${Math.round(lm.elevation)}m`, 0xffffff, 0.042 * s)
      label.position.set(x, topY + 0.06 * s, z)
      label.renderOrder = 11
      group.add(label)

      this.landmarkObjs.set(lm.id, { marker, line, label })
    }
    group.visible = this.landmarksVisible
    this.scene.add(group)
    this.landmarkGroup = group
  }

  /** 衛星テクスチャを設定（dataURL）。null でテクスチャなしに戻す。 */
  setSatelliteTexture(dataUrl: string | null) {
    // 既存テクスチャを破棄
    if (this.satelliteTex) {
      this.satelliteTex.dispose()
      this.satelliteTex = null
    }
    if (dataUrl) {
      const tex = new THREE.TextureLoader().load(dataUrl, () => {
        // 読み込み完了後に再構築（マテリアルに反映）。見た目のみの更新なのでカメラは維持。
        if (this.lastPayload) this.setData(this.lastPayload, false)
      })
      tex.colorSpace = THREE.SRGBColorSpace
      this.satelliteTex = tex
    } else if (this.lastPayload) {
      this.setData(this.lastPayload, false)
    }
  }

  /** 描画モードを設定（default / heightmap / satellite）。見た目のみの更新でカメラは維持 */
  setRenderMode(mode: 'default' | 'heightmap' | 'satellite') {
    this.renderMode = mode
    if (this.lastPayload) this.setData(this.lastPayload, false)
  }

  hasSatellite(): boolean {
    return this.satelliteTex !== null
  }

  private lastPayload: MeshPayload | null = null
  // 一度でもカメラをフィットしたか。地形は常に同じワールド倍率（最大辺→2）に
  // 正規化されるため、初回のみフィットし、以降のワークスペース切替では視点を維持する。
  private hasFittedCamera = false

  /**
   * 生成結果のメッシュデータを表示する。
   * fitCamera=false のときはカメラ位置・注視点を維持する（衛星表示の切替など、
   * 見た目だけを更新する再構築で視点がリセットされるのを防ぐ）。
   * fitCamera=true でも、既に一度フィット済みなら視点は維持する
   * （ワークスペース切替でカメラがリセットされないように）。
   */
  setData(payload: MeshPayload, fitCamera = true) {
    // 初回のみフィットし、以降は視点を維持する
    const doFit = fitCamera && !this.hasFittedCamera
    this.lastPayload = payload
    const { cols, rows, minEle, maxEle, widthMeters, heightMeters } = payload
    const heights = new Float32Array(payload.heights)

    // 既存メッシュ・グリッドを破棄
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.Material).dispose()
      this.mesh = null
    }
    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.geometry.dispose()
      ;(this.grid.material as THREE.Material).dispose()
      this.grid = null
    }
    for (const sp of this.axisLabels) {
      this.scene.remove(sp)
      sp.material.map?.dispose()
      sp.material.dispose()
    }
    this.axisLabels = []

    // ジオメトリは「地表メートル」で作る（X=東西, Z=南北, Y=高さ[m]）。
    // 高さも同じメートル単位なので、全軸を同じ倍率でスケールすれば実寸比率になる。
    const geo = new THREE.PlaneGeometry(widthMeters, heightMeters, cols - 1, rows - 1)
    geo.rotateX(-Math.PI / 2)

    const span = maxEle - minEle || 1
    const pos = geo.attributes.position as THREE.BufferAttribute
    // 衛星モードはテクスチャ使用（テクスチャ未読込なら地形配色にフォールバック）
    const useTex = this.renderMode === 'satellite' && !!this.satelliteTex
    const grayscale = this.renderMode === 'heightmap'
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const ele = heights[i] ?? minEle
      // 実標高(メートル)。base を 0 に合わせて押し出す（実寸）
      pos.setY(i, ele - minEle)
      const t = (ele - minEle) / span
      const col = grayscale ? [t, t, t] : ramp(t)
      colors[i * 3] = col[0]
      colors[i * 3 + 1] = col[1]
      colors[i * 3 + 2] = col[2]
    }
    pos.needsUpdate = true
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()

    // テクスチャ（衛星画像）は北西原点。PlaneGeometry を rotateX(-90°) で寝かせると
    // 既定 UV のままで南北が一致するため、V 反転は行わない（反転すると南北が逆になる）。

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: !useTex, // テクスチャ使用時は頂点色を無効化
      map: useTex ? this.satelliteTex : null,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: false
    })
    this.mesh = new THREE.Mesh(geo, mat)

    // 表示用に全体を一様スケール（全地形で共通の固定倍率）。一様なので実寸比率は保たれ、
    // 地形ごとに正規化しないのでワークスペース切替で実サイズの差がそのまま比較できる。
    const maxDim = Math.max(widthMeters, heightMeters) || 1
    const k = WORLD_SCALE
    this.mesh.scale.setScalar(k)
    this.scene.add(this.mesh)

    // 注釈サイズの倍率を更新。ON のときは地形の実ワールドサイズ（最大辺 maxDim*k）を
    // 基準値 2 で割った比に。OFF なら 1（絶対サイズ固定）。renderLandmarks より前に確定させる。
    this.annotScale = this.scaleAnnotations ? (maxDim * k) / 2 : 1

    // ランドマークの座標変換コンテキストを更新し、再描画する
    this.geo = {
      bbox: payload.bbox,
      minEle,
      widthMeters,
      heightMeters,
      k,
      cols,
      rows,
      heights
    }
    this.renderLandmarks()

    // グリッド（地表の基準面 y=0 に配置）。1マスをきりの良い実距離にする。
    const gridStep = niceStep(maxDim / 10) // 約10分割になる実距離(m)
    const gridSpan = Math.ceil(maxDim / gridStep) * gridStep
    const divisions = Math.round(gridSpan / gridStep)
    this.grid = new THREE.GridHelper(gridSpan * k, divisions, 0x5a7a9a, 0x3a4a5a)
    // GridHelper は XZ 平面・原点中心。地形も原点中心なので位置はそのままでよい。
    this.scene.add(this.grid)

    // 中心軸（東西=X / 南北=Z）の端に「中心からの距離(km)」を小さく表示する。
    // 北を -Z に取っているので、N は -Z 側。
    const halfWorld = (gridSpan * k) / 2
    const halfKm = gridSpan / 2 / 1000
    const kmText = `${halfKm >= 10 ? halfKm.toFixed(0) : halfKm >= 1 ? halfKm.toFixed(1) : halfKm.toFixed(2)} km`
    const ends: [string, THREE.Vector3][] = [
      [`E ${kmText}`, new THREE.Vector3(halfWorld, 0, 0)],
      [`W ${kmText}`, new THREE.Vector3(-halfWorld, 0, 0)],
      [`N ${kmText}`, new THREE.Vector3(0, 0, -halfWorld)],
      [`S ${kmText}`, new THREE.Vector3(0, 0, halfWorld)]
    ]
    for (const [text, pos] of ends) {
      // 深度テストなし＝常にフル描画（見切れ防止）。worldH は注釈倍率を反映。
      const sp = makeLabelSprite(text, 0x9fc2e8, 0.06 * this.annotScale)
      sp.position.copy(pos)
      this.scene.add(sp)
      this.axisLabels.push(sp)
    }

    // --- カメラのフィッティング ---
    // バウンディングボックス（スケール後）から「全体が収まる距離」を求める。
    // X=東西, Z=南北, Y=高さ。ボックスを内包する球の半径で距離を決める。
    const halfX = (widthMeters * k) / 2
    const halfZ = (heightMeters * k) / 2
    const sizeY = (maxEle - minEle) * k
    const centerY = sizeY / 2
    const radius = Math.hypot(halfX, halfZ, sizeY / 2)
    const fov = (this.camera.fov * Math.PI) / 180
    const fitDist = (radius / Math.sin(fov / 2)) * 1.15 // 余白15%

    if (doFit) {
      // 初回データ時は必ず全体にフィット（位置・注視点・クリップを置き直す）。
      this.hasFittedCamera = true
      this.zoomTarget = null // フィットでカメラを置き直すので進行中のズームは破棄
      this.controls.target.set(0, centerY, 0) // 注視点はボックス中心（高さ方向中心）
      const elev = (30 * Math.PI) / 180 // 斜め上から見下ろす（水平から約30°）
      this.camera.position.set(0, centerY + fitDist * Math.sin(elev), fitDist * Math.cos(elev))
      this.camera.near = Math.max(0.001, fitDist / 100)
      this.camera.far = fitDist * 10
      this.camera.updateProjectionMatrix()
      this.controls.update()
      return
    }

    // 2回目以降は視点を維持。ただし自動フィットが有効なら、全体が収まる距離へ
    // スムーズに寄せる/引く（ズームイン・アウト両方）。
    if (this.autoFit) {
      const dist = this.camera.position.distanceTo(this.controls.target)
      this.zoomTarget = fitDist
      // 寄せ・引きどちらでも切れないようクリップ面を確保（near は縮小のみ、far は拡大のみ）。
      this.camera.near = Math.min(this.camera.near, Math.max(0.001, fitDist / 100))
      this.camera.far = Math.max(this.camera.far, fitDist * 10, dist * 1.2)
      this.camera.updateProjectionMatrix()
    }
    this.controls.update()
  }

  /** ワークスペース切替時に全体が収まる距離へカメラを自動でフィットするか。 */
  setAutoFit(v: boolean) {
    this.autoFit = v
  }

  /** 注釈（地点マーカー・線・ラベル・軸ラベル）を地形スケールに合わせて拡縮するか。 */
  setScaleAnnotations(v: boolean) {
    this.scaleAnnotations = v
    if (this.lastPayload) this.setData(this.lastPayload, false) // 見た目のみ更新（視点維持）
  }

  private resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    // updateStyle=true（既定）でキャンバスの CSS サイズもコンテナに合わせる。
    // false だと devicePixelRatio 分だけ拡大表示され、内容が左下に寄る。
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /**
   * ランドマークのラベル同士がスクリーン上で重なるとき、リーダー線を伸ばして
   * ラベルを上へずらし、重なりを避ける（隠さない）。マーカーは地表に固定のまま。
   * 手前（カメラに近い）を基準位置に、奥側ほど上へ逃がす。
   */
  private declutterLabels() {
    const group = this.landmarkGroup
    if (!group || !group.visible || this.landmarkObjs.size === 0) return
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const fovR = (this.camera.fov * Math.PI) / 180
    const cam = this.camera.position
    const v = new THREE.Vector3()
    const s = this.annotScale // 注釈倍率（renderLandmarks と一致させる）
    const baseStem = 0.4 * s // 既定のリーダー線長（ワールド）
    const gap = 0.05 * s // 線の先端からラベル中心までの隙間
    const step = 0.04 * s // 上へ逃がす1ステップ（ワールド）
    const maxStem = 1.6 * s
    const pad = 2

    // マーカー（地表）からの距離が近い順に基準配置 → 奥は上へ逃がす
    const entries = [...this.landmarkObjs.entries()].map(([id, o]) => ({
      id,
      o,
      base: o.marker.position,
      dist: cam.distanceTo(o.marker.position)
    }))
    entries.sort((a, b) => a.dist - b.dist)

    const placed: [number, number, number, number][] = []
    const overlaps = (a: number[], b: number[]) =>
      a[0] < b[0] + b[2] + pad && a[0] + a[2] + pad > b[0] && a[1] < b[1] + b[3] + pad && a[1] + a[3] + pad > b[1]

    for (const { id, o, base } of entries) {
      const labelDist = cam.distanceTo(o.label.position)
      const pxPerWorld = h / (2 * Math.tan(fovR / 2) * Math.max(labelDist, 1e-3))
      const sw = o.label.scale.x * pxPerWorld
      const sh = o.label.scale.y * pxPerWorld

      // 重ならない目標の高さ（target stem）を求める
      let target = baseStem
      let rect: [number, number, number, number] = [0, 0, sw, sh]
      let onScreen = false
      for (;;) {
        v.set(base.x, base.y + target + gap, base.z).project(this.camera)
        onScreen = v.z < 1 && v.x >= -1.3 && v.x <= 1.3 && v.y >= -1.3 && v.y <= 1.3
        const sx = (v.x * 0.5 + 0.5) * w
        const sy = (-v.y * 0.5 + 0.5) * h
        rect = [sx - sw / 2, sy - sh / 2, sw, sh]
        if (!onScreen || target >= maxStem || !placed.some((r) => overlaps(rect, r))) break
        target += step
      }
      if (onScreen) placed.push(rect)

      // 現在長を目標へスムーズに近づける（初回は即座に合わせる）
      const cur = this.labelStem.has(id)
        ? this.labelStem.get(id)! + (target - this.labelStem.get(id)!) * 0.15
        : target
      this.labelStem.set(id, cur)

      // 反映：線の先端とラベルを現在長に合わせる
      const topY = base.y + cur
      const pos = o.line.geometry.attributes.position as THREE.BufferAttribute
      pos.setXYZ(0, base.x, base.y, base.z)
      pos.setXYZ(1, base.x, topY, base.z)
      pos.needsUpdate = true
      o.label.position.set(base.x, topY + gap, base.z)
      o.label.visible = onScreen
    }
  }

  /**
   * グリッド端の距離ラベルが地形の裏に回り込んだら、ラベルごと丸ごと隠す。
   * 深度テストだと文字が途中で見切れるため、アンカー点のオクルージョンを
   * レイキャストで判定して all-or-nothing で表示/非表示する。
   */
  private updateAxisLabelOcclusion() {
    if (!this.mesh || this.axisLabels.length === 0) return
    const cam = this.camera.position
    const dir = new THREE.Vector3()
    for (const sp of this.axisLabels) {
      const distToLabel = cam.distanceTo(sp.position)
      dir.copy(sp.position).sub(cam).normalize()
      this.raycaster.set(cam, dir)
      const hit = this.raycaster.intersectObject(this.mesh)[0]
      sp.visible = !(hit && hit.distance < distToLabel - 0.02)
    }
  }

  /** ホイールで設定した目標距離へカメラを毎フレーム少しずつ寄せる（スムーズズーム）。 */
  private updateSmoothZoom() {
    if (this.zoomTarget === null) return
    const offset = this.zoomTmp.subVectors(this.camera.position, this.controls.target)
    const cur = offset.length()
    if (cur < 1e-6) {
      this.zoomTarget = null
      return
    }
    let next = THREE.MathUtils.lerp(cur, this.zoomTarget, 0.2)
    // 目標にほぼ到達したらスナップして停止。
    if (Math.abs(next - this.zoomTarget) < this.zoomTarget * 0.002) {
      next = this.zoomTarget
      this.zoomTarget = null
    }
    offset.multiplyScalar(next / cur)
    this.camera.position.copy(this.controls.target).add(offset)
  }

  private animate = () => {
    this.raf = requestAnimationFrame(this.animate)
    this.controls.update()
    this.updateSmoothZoom()
    this.declutterLabels()
    this.updateAxisLabelOcclusion()

    // メインシーン
    this.renderer.setViewport(0, 0, this.container.clientWidth, this.container.clientHeight)
    this.renderer.setScissorTest(false)
    this.renderer.render(this.scene, this.camera)

    // 左下に軸ギズモを重ねて描画（メインカメラの向きに同期）
    const size = 110
    const margin = 8
    // 色クリアを止めて背景を透明に（地形の上に重ねる）。深度だけクリア。
    this.renderer.autoClear = false
    this.renderer.setScissorTest(true)
    this.renderer.setScissor(margin, margin, size, size)
    this.renderer.setViewport(margin, margin, size, size)
    this.renderer.clearDepth()
    // メインカメラの回転だけを反映し、一定距離から見る
    const dirToCam = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize()
    this.gizmoCamera.position.copy(dirToCam.multiplyScalar(3))
    this.gizmoCamera.lookAt(0, 0, 0)
    this.renderer.render(this.gizmoScene, this.gizmoCamera)
    this.renderer.setScissorTest(false)
    this.renderer.autoClear = true // 次フレームのメイン描画用に戻す
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resizeObs.disconnect()
    this.satelliteTex?.dispose()
    for (const sp of this.axisLabels) {
      sp.material.map?.dispose()
      sp.material.dispose()
    }
    this.landmarks = []
    this.renderLandmarks() // グループとテクスチャを破棄
    this.renderer.dispose()
  }
}

/**
 * テキストを描いた小さなラベル板（Sprite）を作る。"\n" で複数行に対応。
 * 文字幅・行数に合わせて canvas をサイズ調整し、ワールド上では小さめに表示する。
 * color は 0xRRGGBB、worldH は1行あたりのワールド高さ。
 * depthTest=true にすると地形に隠れる（オクルージョンする）。
 */
function makeLabelSprite(
  text: string,
  color = 0x9fc2e8,
  worldH = 0.06,
  depthTest = false
): THREE.Sprite {
  const fontPx = 48
  const pad = 10
  const lineH = fontPx * 1.15
  const lines = text.split('\n')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `${fontPx}px Segoe UI, sans-serif`
  ctx.font = font
  const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + pad * 2
  const h = Math.ceil(lineH * lines.length) + pad * 2
  canvas.width = w
  canvas.height = h
  // canvas をリサイズすると context がクリアされるので font を再設定する
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 6
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
  lines.forEach((l, i) => {
    const cy = pad + lineH * (i + 0.5)
    ctx.strokeText(l, w / 2, cy) // 縁取り（黒）で視認性を確保
    ctx.fillText(l, w / 2, cy)
  })

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest, transparent: true })
  const sp = new THREE.Sprite(mat)
  // 文字のアスペクト比を保って横幅を決める（worldH は1行ぶんの高さ基準）
  const totalH = worldH * lines.length
  sp.scale.set(totalH * (w / h), totalH, 1)
  return sp
}

/** 値を 1/2/5×10^n の「きりの良い」距離に丸める（グリッド間隔用） */
function niceStep(x: number): number {
  if (x <= 0) return 1
  const exp = Math.floor(Math.log10(x))
  const base = Math.pow(10, exp)
  const f = x / base
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10
  return nice * base
}

/** 文字を描いた板（Sprite）を作る。color は 0xRRGGBB */
function makeTextSprite(text: string, color: number): THREE.Sprite {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  const hex = '#' + color.toString(16).padStart(6, '0')
  ctx.font = 'bold 80px Segoe UI, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // 縁取り（黒）で視認性を確保
  ctx.lineWidth = 8
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText(text, size / 2, size / 2)
  ctx.fillStyle = hex
  ctx.fillText(text, size / 2, size / 2)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
  return new THREE.Sprite(mat)
}

/** 標高比 t(0..1) を地形配色に変換 */
function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.0, [0.18, 0.36, 0.2]], // 低地: 緑
    [0.4, [0.45, 0.5, 0.28]], // 丘: 黄緑
    [0.7, [0.5, 0.4, 0.28]], // 山肌: 茶
    [0.9, [0.65, 0.63, 0.6]], // 岩: 灰
    [1.0, [0.95, 0.95, 0.97]] // 山頂: 雪
  ]
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]
    const [t1, c1] = stops[i + 1]
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1)
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]
    }
  }
  return stops[stops.length - 1][1]
}
