// 生成したハイトマップを Three.js で立体プレビューするビューワ。
// 平面ジオメトリの各頂点 Z を標高で押し出す（displacement 相当）。
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { MeshPayload, Landmark } from '../preload/index'

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
  private resizeObs: ResizeObserver
  // 左下の軸ギズモ（別シーンを小さなビューポートに描画）
  private gizmoScene = new THREE.Scene()
  private gizmoCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10)
  /** 衛星テクスチャ（読み込み済み）と表示 ON/OFF */
  private satelliteTex: THREE.Texture | null = null
  private useSatellite = true
  // ランドマーク（地点）描画
  private geo: GeoContext | null = null
  private landmarks: Landmark[] = []
  private landmarkGroup: THREE.Group | null = null
  // 地点ごとの描画オブジェクト（ドラッグ移動時に位置を更新する）
  private landmarkObjs = new Map<string, { marker: THREE.Mesh; line: THREE.Line; label: THREE.Sprite }>()
  private markerMeshes: THREE.Mesh[] = [] // レイキャスト用（クリック判定）
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
    this.controls.target.set(0, 0, 0)
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
        if (e.button !== 0 || this.placeMode) return
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
      // ホバー時のカーソル（配置モードは crosshair のまま）
      if (!this.placeMode) {
        dom.style.cursor = this.markerHitId(e) ? 'grab' : ''
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

  /** ランドマーク一覧を設定して描画する */
  setLandmarks(landmarks: Landmark[]) {
    this.landmarks = landmarks
    this.renderLandmarks()
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
    const stem = 0.4 // リーダー線の長さ（ワールド単位。シーンの最大辺=2基準）
    const markerGeo = new THREE.SphereGeometry(0.013, 12, 12)
    for (const lm of this.landmarks) {
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
      const label = makeLabelSprite(`${lm.name}\n${Math.round(lm.elevation)}m`, 0xffffff, 0.055)
      label.position.set(x, topY + 0.06, z)
      label.renderOrder = 11
      group.add(label)

      this.landmarkObjs.set(lm.id, { marker, line, label })
    }
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

  /** 衛星テクスチャの表示 ON/OFF（テクスチャ未設定時は頂点色のまま） */
  setUseSatellite(on: boolean) {
    this.useSatellite = on
    // 見た目のみの更新なのでカメラ位置は維持する
    if (this.lastPayload) this.setData(this.lastPayload, false)
  }

  hasSatellite(): boolean {
    return this.satelliteTex !== null
  }

  private lastPayload: MeshPayload | null = null

  /**
   * 生成結果のメッシュデータを表示する。
   * fitCamera=false のときはカメラ位置・注視点を維持する（衛星表示の切替など、
   * 見た目だけを更新する再構築で視点がリセットされるのを防ぐ）。
   */
  setData(payload: MeshPayload, fitCamera = true) {
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
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const ele = heights[i] ?? minEle
      // 実標高(メートル)。base を 0 に合わせて押し出す（実寸）
      pos.setY(i, ele - minEle)
      const t = (ele - minEle) / span
      const col = ramp(t)
      colors[i * 3] = col[0]
      colors[i * 3 + 1] = col[1]
      colors[i * 3 + 2] = col[2]
    }
    pos.needsUpdate = true
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()

    // テクスチャ（衛星画像）は北西原点。PlaneGeometry を rotateX(-90°) で寝かせると
    // 既定 UV のままで南北が一致するため、V 反転は行わない（反転すると南北が逆になる）。

    const useTex = this.useSatellite && this.satelliteTex
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: !useTex, // テクスチャ使用時は頂点色を無効化
      map: useTex ? this.satelliteTex : null,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: false
    })
    this.mesh = new THREE.Mesh(geo, mat)

    // 表示用に全体を一様スケール（最大辺が 2 になるように）。一様なので実寸比率は保たれる。
    const maxDim = Math.max(widthMeters, heightMeters) || 1
    const k = 2 / maxDim
    this.mesh.scale.setScalar(k)
    this.scene.add(this.mesh)

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
      const sp = makeLabelSprite(text)
      sp.position.copy(pos)
      this.scene.add(sp)
      this.axisLabels.push(sp)
    }

    // --- カメラのフィッティング（新規データ時のみ。見た目更新では視点を維持） ---
    if (!fitCamera) {
      this.controls.update()
      return
    }
    // 地形のバウンディングボックス（スケール後）。X=東西, Z=南北, Y=高さ。
    const halfX = (widthMeters * k) / 2
    const halfZ = (heightMeters * k) / 2
    const sizeY = (maxEle - minEle) * k
    const centerY = sizeY / 2

    // 注視点はボックス中心（底を中心に回らないように高さ方向中心へ）
    this.controls.target.set(0, centerY, 0)

    // ボックスを内包する球の半径で距離を決める → 全体が必ず収まる
    const radius = Math.hypot(halfX, halfZ, sizeY / 2)
    const fov = (this.camera.fov * Math.PI) / 180
    const fitDist = (radius / Math.sin(fov / 2)) * 1.15 // 余白15%

    // 斜め上から見下ろす方向（水平から約30°）。
    const elev = (30 * Math.PI) / 180
    this.camera.position.set(
      0,
      centerY + fitDist * Math.sin(elev),
      fitDist * Math.cos(elev)
    )
    // 近遠クリップも距離に合わせて調整
    this.camera.near = Math.max(0.001, fitDist / 100)
    this.camera.far = fitDist * 10
    this.camera.updateProjectionMatrix()
    this.controls.update()
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

  private animate = () => {
    this.raf = requestAnimationFrame(this.animate)
    this.controls.update()

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
 */
function makeLabelSprite(text: string, color = 0x9fc2e8, worldH = 0.06): THREE.Sprite {
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
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
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
