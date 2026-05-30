// 生成したハイトマップを Three.js で立体プレビューするビューワ。
// 平面ジオメトリの各頂点 Z を標高で押し出す（displacement 相当）。
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { MeshPayload } from '../preload/index'

export class TerrainViewer {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private mesh: THREE.Mesh | null = null
  private grid: THREE.GridHelper | null = null
  private container: HTMLElement
  private raf = 0
  private resizeObs: ResizeObserver
  // 左下の軸ギズモ（別シーンを小さなビューポートに描画）
  private gizmoScene = new THREE.Scene()
  private gizmoCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10)
  /** 高さ強調倍率（1.0 = 実寸） */
  private exaggeration = 1.0
  /** 衛星テクスチャ（読み込み済み）と表示 ON/OFF */
  private satelliteTex: THREE.Texture | null = null
  private useSatellite = true

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

  setExaggeration(v: number) {
    this.exaggeration = v
    // 既存メッシュがあれば作り直すのが簡単（頂点数は少ないので軽い）
    if (this.lastPayload) this.setData(this.lastPayload)
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
        // 読み込み完了後に再構築（マテリアルに反映）
        if (this.lastPayload) this.setData(this.lastPayload)
      })
      tex.colorSpace = THREE.SRGBColorSpace
      this.satelliteTex = tex
    } else if (this.lastPayload) {
      this.setData(this.lastPayload)
    }
  }

  /** 衛星テクスチャの表示 ON/OFF（テクスチャ未設定時は頂点色のまま） */
  setUseSatellite(on: boolean) {
    this.useSatellite = on
    if (this.lastPayload) this.setData(this.lastPayload)
  }

  hasSatellite(): boolean {
    return this.satelliteTex !== null
  }

  private lastPayload: MeshPayload | null = null

  /** 生成結果のメッシュデータを表示する */
  setData(payload: MeshPayload) {
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

    // ジオメトリは「地表メートル」で作る（X=東西, Z=南北, Y=高さ[m]）。
    // 高さも同じメートル単位なので、全軸を同じ倍率でスケールすれば実寸比率になる。
    const geo = new THREE.PlaneGeometry(widthMeters, heightMeters, cols - 1, rows - 1)
    geo.rotateX(-Math.PI / 2)

    const span = maxEle - minEle || 1
    const pos = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const ele = heights[i] ?? minEle
      // 実標高(メートル)。base を 0 に合わせ、exaggeration は高さのみに掛ける（1.0=実寸）
      pos.setY(i, (ele - minEle) * this.exaggeration)
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

    // グリッド（地表の基準面 y=0 に配置）。1マスをきりの良い実距離にする。
    const gridStep = niceStep(maxDim / 10) // 約10分割になる実距離(m)
    const gridSpan = Math.ceil(maxDim / gridStep) * gridStep
    const divisions = Math.round(gridSpan / gridStep)
    this.grid = new THREE.GridHelper(gridSpan * k, divisions, 0x5a7a9a, 0x3a4a5a)
    // GridHelper は XZ 平面・原点中心。地形も原点中心なので位置はそのままでよい。
    this.scene.add(this.grid)

    // --- カメラのフィッティング ---
    // 地形のバウンディングボックス（スケール後）。X=東西, Z=南北, Y=高さ。
    const halfX = (widthMeters * k) / 2
    const halfZ = (heightMeters * k) / 2
    const sizeY = (maxEle - minEle) * this.exaggeration * k
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
    this.renderer.clearDepth()
    this.renderer.setScissorTest(true)
    this.renderer.setScissor(margin, margin, size, size)
    this.renderer.setViewport(margin, margin, size, size)
    // メインカメラの回転だけを反映し、一定距離から見る
    const dirToCam = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize()
    this.gizmoCamera.position.copy(dirToCam.multiplyScalar(3))
    this.gizmoCamera.lookAt(0, 0, 0)
    this.renderer.render(this.gizmoScene, this.gizmoCamera)
    this.renderer.setScissorTest(false)
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resizeObs.disconnect()
    this.satelliteTex?.dispose()
    this.renderer.dispose()
  }
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
