/* ═══════════════════════════════════════════════════════════════════
   记忆宇宙 · 星图渲染引擎 v2
   ───────────────────────────────────────────────────────────────────
   · 中央核心：代表AI本人的高亮光体（球 + 双层光晕 + 呼吸环）
   · 语义星团：按主题/情绪聚成若干团，绕核心球面分布
   · 粒子：THREE.Points + ShaderMaterial（逐粒子 size/color/alpha/phase/depth）
   · 呼吸：每颗粒子独立相位，幅度小、周期慢 —— 不闪不抖
   · 连线：极细低透明度，只做暗示，不做网络拓扑
   · Bloom：three 无 EffectComposer，用 WebGLRenderTarget + 全屏 quad 手写
   · 降级：high / medium / low 三档，自动按设备与帧率切换
   ═══════════════════════════════════════════════════════════════════ */

import * as THREE from './vendor/three.module.min.js'

const DEFAULT_THEME = { hue: 210, sat: 30, lum: 58, label: '其他' }

export function createUniverse(container, opts = {}) {
  const onPick = opts.onPick || function () {}
  const onPickCluster = opts.onPickCluster || function () {}
  const onHover = opts.onHover || function () {}
  const onPickEmpty = opts.onPickEmpty || function () {}
  const onReady = opts.onReady || function () {}

  let THEME = opts.theme || {}

  function themeOf(key) {
    return THEME[key] || DEFAULT_THEME
  }

  /* ───────────── 渲染器 / 场景 / 相机 ───────────── */

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.setClearColor(0x05070d, 1)
  renderer.domElement.id = 'sky-canvas'
  renderer.domElement.setAttribute('data-sky', '1')   // 唯一标记，便于排查重复 canvas
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 9000)

  /* ───────────── 画质 ───────────── */

  const quality = { level: 'high', ratio: 1, bloom: true, labelLimit: 28 }

  function detectQuality() {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const mem = navigator.deviceMemory || 8
    const cores = navigator.hardwareConcurrency || 8
    const dpr = window.devicePixelRatio || 1
    if (reduced || mem <= 2 || cores <= 2) {
      quality.level = 'low'; quality.ratio = 0.34; quality.bloom = false; quality.labelLimit = 12
    } else if (mem <= 4 || cores <= 4 || dpr > 2.5) {
      quality.level = 'medium'; quality.ratio = 0.62; quality.bloom = true; quality.labelLimit = 18
    }
  }
  detectQuality()

  /* ───────────── 相机轨道 ───────────── */

  const cam = {
    theta: 0.62, phi: 1.05, radius: 900,
    minR: 320, maxR: 2400,
    target: new THREE.Vector3(0, 0, 0),
    anim: null,
  }

  function applyCamera() {
    const sp = Math.sin(cam.phi)
    camera.position.set(
      cam.target.x + cam.radius * sp * Math.sin(cam.theta),
      cam.target.y + cam.radius * Math.cos(cam.phi),
      cam.target.z + cam.radius * sp * Math.cos(cam.theta),
    )
    camera.lookAt(cam.target)
  }

  /* ───────────── 场景对象 ───────────── */

  const world = new THREE.Group()
  scene.add(world)

  let pointsMesh = null
  let coreGroup = null
  let linkMesh = null
  let dustMesh = null
  let bloom = null
  let texGlow = null

  const state = {
    nodes: [], edges: [], byId: new Map(), clusters: new Map(),
    selected: null, hovered: null, searchHits: new Set(), visible: true, dirty: true,
  }

  const cfg = { autoRotate: true, rotateSpeed: 0.00008, labels: true, halo: true }

  let userDragging = false
  let resumeTimer = null

  /* ═════════════════ 纹理 ═════════════════ */

  function makeGlowTexture() {
    const S = 128
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = c.getContext('2d')
    const r = S / 2
    const grd = g.createRadialGradient(r, r, 0, r, r, r)
    grd.addColorStop(0.00, 'rgba(255,255,255,0.88)')
    grd.addColorStop(0.28, 'rgba(255,255,255,0.34)')
    grd.addColorStop(0.58, 'rgba(255,255,255,0.10)')
    grd.addColorStop(1.00, 'rgba(255,255,255,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, S, S)
    const t = new THREE.CanvasTexture(c)
    t.needsUpdate = true
    return t
  }

  /* ═════════════════ 着色器 ═════════════════ */

  const PARTICLE_VERT = [
    'attribute float aSize;',
    'attribute vec3 aColor;',
    'attribute float aAlpha;',
    'attribute float aPhase;',
    'attribute float aDepth;',
    'uniform float uTime;',
    'uniform float uPixelRatio;',
    'uniform float uScale;',
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'void main() {',
    '  float breathe = sin(uTime * 0.52 + aPhase) * 0.5 + 0.5;',
    '  float pulse = 0.87 + 0.26 * breathe;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  float depthFade = 0.42 + 0.58 * aDepth;',
    '  gl_PointSize = aSize * uScale * uPixelRatio * pulse * depthFade;',
    '  vColor = aColor;',
    '  vAlpha = aAlpha * pulse * depthFade;',
    '}',
  ].join('\n')

  const PARTICLE_FRAG = [
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'void main() {',
    '  vec2 uv = gl_PointCoord - vec2(0.5);',
    '  float d = length(uv) * 2.0;',
    '  float core = smoothstep(0.36, 0.0, d);',
    '  float halo = smoothstep(1.0, 0.16, d);',
    '  float a = core * 0.84 + halo * halo * 0.52;',
    '  a *= vAlpha;',
    '  if (a < 0.005) discard;',
    '  gl_FragColor = vec4(vColor * (0.94 + core * 0.40), a);',
    '}',
  ].join('\n')

  const QUAD_VERT = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position, 1.0); }',
  ].join('\n')

  const BRIGHT_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform float uThreshold;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec4 c = texture2D(tDiffuse, vUv);',
    '  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));',
    '  float w = smoothstep(uThreshold, uThreshold + 0.28, lum);',
    '  gl_FragColor = vec4(c.rgb * w, 1.0);',
    '}',
  ].join('\n')

  const BLUR_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uDir;',
    'uniform vec2 uTexel;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec2 st = uDir * uTexel;',
    '  vec4 s = vec4(0.0);',
    '  s += texture2D(tDiffuse, vUv + st * -4.0) * 0.0162;',
    '  s += texture2D(tDiffuse, vUv + st * -3.0) * 0.0540;',
    '  s += texture2D(tDiffuse, vUv + st * -2.0) * 0.1216;',
    '  s += texture2D(tDiffuse, vUv + st * -1.0) * 0.1932;',
    '  s += texture2D(tDiffuse, vUv) * 0.2300;',
    '  s += texture2D(tDiffuse, vUv + st * 1.0) * 0.1932;',
    '  s += texture2D(tDiffuse, vUv + st * 2.0) * 0.1216;',
    '  s += texture2D(tDiffuse, vUv + st * 3.0) * 0.0540;',
    '  s += texture2D(tDiffuse, vUv + st * 4.0) * 0.0162;',
    '  gl_FragColor = s;',
    '}',
  ].join('\n')

  const COMPOSITE_FRAG = [
    'uniform sampler2D tScene;',
    'uniform sampler2D tBloom;',
    'uniform float uStrength;',
    'uniform float uVignette;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 sc = texture2D(tScene, vUv).rgb;',
    '  vec3 bl = texture2D(tBloom, vUv).rgb;',
    '  vec3 col = sc + bl * uStrength;',
    '  vec2 p = vUv - vec2(0.5);',
    '  float vig = 1.0 - uVignette * dot(p, p) * 1.85;',
    '  col *= clamp(vig, 0.58, 1.0);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n')

  /* ═════════════════ 布局 ═════════════════ */

  let EXTENT = 470

  function layoutClusters(keys) {
    const out = new Map()
    const orbit = [...keys].filter(function (k) { return k !== 'core' }).sort()
    const m = orbit.length
    const ringR = EXTENT * 0.80
    const golden = Math.PI * (3 - Math.sqrt(5))

    orbit.forEach(function (key, i) {
      const y = m === 1 ? 0 : (1 - (i / (m - 1)) * 2)
      const rad = Math.sqrt(Math.max(0, 1 - y * y))
      const theta = golden * i
      out.set(key, {
        key: key,
        center: new THREE.Vector3(
          Math.cos(theta) * rad * ringR,
          y * ringR * 0.56,
          Math.sin(theta) * rad * ringR,
        ),
        radius: EXTENT * (m <= 4 ? 0.26 : (m <= 8 ? 0.20 : (m <= 12 ? 0.155 : 0.125))),
      })
    })

    out.set('core', { key: 'core', center: new THREE.Vector3(0, 0, 0), radius: EXTENT * 0.16 })
    return out
  }

  function scatter(radius, rnd) {
    const a = rnd() * Math.PI * 2
    const b = Math.acos(2 * rnd() - 1)
    const t = Math.pow(rnd(), 1.5)
    const r = radius * (0.04 + 0.96 * t)
    return {
      x: Math.sin(b) * Math.cos(a) * r,
      y: Math.sin(b) * Math.sin(a) * r * 0.82,
      z: Math.cos(b) * r,
      r: r,
    }
  }

  /* ═════════════════ setData ═════════════════ */

  function setData(rawNodes, rawEdges) {
    const nodes = (rawNodes || []).map(function (n) { return Object.assign({}, n) })
    const edges = rawEdges || []
    const byId = new Map(nodes.map(function (n) { return [n.id, n] }))

    const keys = new Set()
    for (const n of nodes) {
      if (n.isEntity) continue
      keys.add(String(n.region || 'daily'))
    }
    keys.add('core')

    const layout = layoutClusters(keys)

    let seed = 20261030
    const rnd = function () {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    const clusters = new Map()
    layout.forEach(function (v, k) {
      const th = themeOf(k)
      clusters.set(k, {
        key: k, label: th.label,
        color: new THREE.Color().setHSL(th.hue / 360, th.sat / 100, th.lum / 100),
        center: v.center, radius: v.radius,
        count: 0, nodes: [], sumImp: 0,
        tsMin: Infinity, tsMax: -Infinity,
      })
    })

    const entities = []

    for (const n of nodes) {
      if (n.isEntity) { entities.push(n); n.px = 0; n.py = 0; n.pz = 0; continue }
      const key = layout.has(String(n.region)) ? String(n.region) : 'daily'
      const cl = clusters.get(key)
      const off = scatter(cl.radius, rnd)
      n.px = cl.center.x + off.x
      n.py = cl.center.y + off.y
      n.pz = cl.center.z + off.z
      n.cluster = key
      n.phase = rnd() * 6.2831
      n.clusterColor = cl.color
      cl.count++
      cl.nodes.push(n)
      cl.sumImp += (n.importance != null ? n.importance : 0.4)
      if (n.ts) {
        if (n.ts < cl.tsMin) cl.tsMin = n.ts
        if (n.ts > cl.tsMax) cl.tsMax = n.ts
      }
    }

    for (const en of entities) {
      const linked = edges.filter(function (e) { return e.src === en.id || e.dst === en.id })
      if (!linked.length) continue
      let sx = 0, sy = 0, sz = 0, c = 0
      for (const e of linked) {
        const other = byId.get(e.src === en.id ? e.dst : e.src)
        if (other && !other.isEntity) { sx += other.px; sy += other.py; sz += other.pz; c++ }
      }
      if (c) {
        en.px = sx / c + (rnd() - 0.5) * 26
        en.py = sy / c + (rnd() - 0.5) * 26
        en.pz = sz / c + (rnd() - 0.5) * 26
      }
    }

    state.nodes = nodes
    state.edges = edges
    state.byId = byId
    state.clusters = clusters

    buildParticles()
    buildCore()
    buildLinks()
    buildDust()

    fitAll()
    state.dirty = true
    onReady({ nodes: nodes.length, clusters: clusters.size })
  }

  /* ═════════════════ 粒子 ═════════════════ */

  function buildParticles() {
    if (pointsMesh) {
      world.remove(pointsMesh)
      pointsMesh.geometry.dispose()
      pointsMesh.material.dispose()
      pointsMesh = null
    }

    const memNodes = state.nodes.filter(function (n) { return !n.isEntity })
    if (!memNodes.length) return

    let used = memNodes
    if (quality.ratio < 1) {
      const sorted = memNodes.slice().sort(function (a, b) {
        return (b.importance || 0.4) - (a.importance || 0.4)
      })
      const keepN = Math.max(40, Math.round(memNodes.length * quality.ratio))
      const keep = new Set(sorted.slice(0, keepN).map(function (n) { return n.id }))
      used = memNodes.filter(function (n) { return keep.has(n.id) })
    }

    const N = used.length
    const position = new Float32Array(N * 3)
    const aSize = new Float32Array(N)
    const aColor = new Float32Array(N * 3)
    const aAlpha = new Float32Array(N)
    const aPhase = new Float32Array(N)
    const aDepth = new Float32Array(N)

    const deg = new Map()
    for (const e of state.edges) {
      deg.set(e.src, (deg.get(e.src) || 0) + 1)
      deg.set(e.dst, (deg.get(e.dst) || 0) + 1)
    }

    const white = new THREE.Color(0xffffff)

    used.forEach(function (n, i) {
      position[i * 3] = n.px
      position[i * 3 + 1] = n.py
      position[i * 3 + 2] = n.pz

      const imp = n.importance != null ? n.importance : 0.4
      const d = deg.get(n.id) || 0

      aSize[i] = 4.2 + imp * 8.0 + Math.min(2.6, Math.sqrt(d) * 1.2)

      const col = n.clusterColor || new THREE.Color(0x7a8098)
      const warm = new THREE.Color().copy(col).lerp(white, imp * 0.40)
      aColor[i * 3] = warm.r
      aColor[i * 3 + 1] = warm.g
      aColor[i * 3 + 2] = warm.b

      aAlpha[i] = n.noise ? 0.18 : (0.68 + imp * 0.38)
      aPhase[i] = n.phase || 0

      const dist = Math.sqrt(n.px * n.px + n.py * n.py + n.pz * n.pz)
      aDepth[i] = 1.0 - Math.min(1, dist / (EXTENT * 1.5)) * 0.40
    })

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1))
    geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1))
    geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1))
    geo.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1))
    geo.computeBoundingSphere()

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uScale: { value: 1 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    pointsMesh = new THREE.Points(geo, mat)
    pointsMesh.frustumCulled = false
    pointsMesh.userData.used = used
    world.add(pointsMesh)
    updateScale()
  }

  function updateScale() {
    const H = renderer.domElement.clientHeight || 1
    const fovRad = (camera.fov * Math.PI) / 180
    const pxPerWorld = H / (2 * Math.tan(fovRad / 2) * cam.radius)
    const s = Math.max(0.3, Math.min(3.4, pxPerWorld * 760))
    if (pointsMesh) pointsMesh.material.uniforms.uScale.value = s
    if (dustMesh) dustMesh.material.uniforms.uScale.value = s * 0.5
  }

  /* ═════════════════ 中央核心 ═════════════════ */

  function buildCore() {
    if (coreGroup) {
      world.remove(coreGroup)
      coreGroup.traverse(function (o) {
        if (o.geometry) o.geometry.dispose()
        if (o.material && o.material.dispose) o.material.dispose()
      })
      coreGroup = null
    }
    if (!texGlow) texGlow = makeGlowTexture()

    const g = new THREE.Group()

    // 半径按 EXTENT 缩放，保证屏幕上有存在感
    const CORE_R = EXTENT * 0.038
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(CORE_R, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff2d0, transparent: true, opacity: 0.95 }),
    )
    g.add(ball)

    const halo1 = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texGlow, color: 0xffe7b0, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    halo1.scale.set(EXTENT * 0.20, EXTENT * 0.20, 1)
    g.add(halo1)

    const halo2 = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texGlow, color: 0xfff3d4, transparent: true, opacity: 0.20,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    halo2.scale.set(EXTENT * 0.52, EXTENT * 0.52, 1)
    g.add(halo2)

    const ring1 = new THREE.Mesh(
      new THREE.RingGeometry(EXTENT * 0.070, EXTENT * 0.078, 84),
      new THREE.MeshBasicMaterial({
        color: 0xffe7b0, transparent: true, opacity: 0.20,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    )
    g.add(ring1)

    const ring2 = new THREE.Mesh(
      new THREE.RingGeometry(EXTENT * 0.118, EXTENT * 0.124, 84),
      new THREE.MeshBasicMaterial({
        color: 0xfff3d4, transparent: true, opacity: 0.09,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    )
    g.add(ring2)

    coreGroup = g
    coreGroup.userData = { ball: ball, halo1: halo1, halo2: halo2, ring1: ring1, ring2: ring2 }
    coreGroup.traverse(function (o) { o.renderOrder = 3 })
    world.add(coreGroup)
  }

  /* ═════════════════ 连线 ═════════════════ */

  function buildLinks() {
    if (linkMesh) {
      world.remove(linkMesh)
      linkMesh.geometry.dispose()
      linkMesh.material.dispose()
      linkMesh = null
    }
    const edges = state.edges || []
    if (!edges.length) return

    const maxLinks = quality.level === 'high' ? 90 : (quality.level === 'medium' ? 45 : 20)
    const use = edges.slice().sort(function (a, b) {
      return (b.weight || 0) - (a.weight || 0)
    }).slice(0, maxLinks)

    const pos = []
    for (const e of use) {
      const a = state.byId.get(e.src)
      const b = state.byId.get(e.dst)
      if (!a || !b || a.isEntity || b.isEntity) continue
      pos.push(a.px, a.py, a.pz, b.px, b.py, b.pz)
    }
    if (!pos.length) return

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const mat = new THREE.LineBasicMaterial({
      color: 0x8ea6e8, transparent: true, opacity: 0.075,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    linkMesh = new THREE.LineSegments(geo, mat)
    linkMesh.frustumCulled = false
    world.add(linkMesh)
  }

  /* ═════════════════ 远景星尘 ═════════════════ */

  function buildDust() {
    if (dustMesh) {
      world.remove(dustMesh)
      dustMesh.geometry.dispose()
      dustMesh.material.dispose()
      dustMesh = null
    }
    const N = (typeof dustCountCfg === 'number' && dustCountCfg > 0)
      ? dustCountCfg
      : (quality.level === 'high' ? 2000 : (quality.level === 'medium' ? 800 : 300))
    const pos = new Float32Array(N * 3)
    const sizes = new Float32Array(N)
    const cols = new Float32Array(N * 3)
    const alphas = new Float32Array(N)
    const phases = new Float32Array(N)
    const depths = new Float32Array(N)

    let s = 77777
    const rnd = function () {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }

    for (let i = 0; i < N; i++) {
      const R = EXTENT * (1.7 + rnd() * 3.2)
      const a = rnd() * Math.PI * 2
      const b = Math.acos(2 * rnd() - 1)
      pos[i * 3] = Math.sin(b) * Math.cos(a) * R
      pos[i * 3 + 1] = Math.sin(b) * Math.sin(a) * R * 0.72
      pos[i * 3 + 2] = Math.cos(b) * R
      sizes[i] = 1.1 + rnd() * 1.9
      const t = rnd()
      cols[i * 3] = 0.58 + t * 0.20
      cols[i * 3 + 1] = 0.62 + t * 0.20
      cols[i * 3 + 2] = 0.76 + t * 0.16
      alphas[i] = 0.10 + rnd() * 0.20
      phases[i] = rnd() * 6.2831
      depths[i] = 0.28 + rnd() * 0.24
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    geo.setAttribute('aColor', new THREE.BufferAttribute(cols, 3))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1))
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1))

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uScale: { value: 1 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    dustMesh = new THREE.Points(geo, mat)
    dustMesh.frustumCulled = false
    world.add(dustMesh)
  }

  /* ═════════════════ Bloom ═════════════════ */

  function initBloom() {
    if (!quality.bloom || bloom) return
    const W = Math.max(1, renderer.domElement.clientWidth)
    const H = Math.max(1, renderer.domElement.clientHeight)
    const dpr = Math.min(renderer.getPixelRatio(), 1.6)

    const sceneRT = new THREE.WebGLRenderTarget(
      Math.round(W * dpr), Math.round(H * dpr),
      { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter },
    )
    const bw = Math.max(1, Math.round(W * dpr * 0.5))
    const bh = Math.max(1, Math.round(H * dpr * 0.5))
    const rtA = new THREE.WebGLRenderTarget(bw, bh,
      { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
    const rtB = new THREE.WebGLRenderTarget(bw, bh,
      { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })

    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const quadGeo = new THREE.PlaneGeometry(2, 2)

    const brightMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.16 } },
      vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG,
      depthTest: false, depthWrite: false,
    })
    const blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2(1 / bw, 1 / bh) },
      },
      vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG,
      depthTest: false, depthWrite: false,
    })
    const compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tBloom: { value: null },
        uStrength: { value: 0.95 }, uVignette: { value: 0.22 },
      },
      vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG,
      depthTest: false, depthWrite: false,
    })

    const quad = new THREE.Mesh(quadGeo, compMat)
    const quadScene = new THREE.Scene()
    quadScene.add(quad)

    bloom = {
      sceneRT: sceneRT, rtA: rtA, rtB: rtB,
      quadScene: quadScene, quadCam: quadCam, quad: quad,
      brightMat: brightMat, blurMat: blurMat, compMat: compMat,
      bw: bw, bh: bh,
    }
  }

  function resizeBloom() {
    if (!bloom) return
    const W = Math.max(1, renderer.domElement.clientWidth)
    const H = Math.max(1, renderer.domElement.clientHeight)
    const dpr = Math.min(renderer.getPixelRatio(), 1.6)
    bloom.sceneRT.setSize(Math.round(W * dpr), Math.round(H * dpr))
    const bw = Math.max(1, Math.round(W * dpr * 0.5))
    const bh = Math.max(1, Math.round(H * dpr * 0.5))
    bloom.rtA.setSize(bw, bh)
    bloom.rtB.setSize(bw, bh)
    bloom.blurMat.uniforms.uTexel.value.set(1 / bw, 1 / bh)
  }

  function renderBloom() {
    const b = bloom
    renderer.setRenderTarget(b.sceneRT)
    renderer.clear()
    renderer.render(scene, camera)

    b.quad.material = b.brightMat
    b.brightMat.uniforms.tDiffuse.value = b.sceneRT.texture
    renderer.setRenderTarget(b.rtA)
    renderer.clear()
    renderer.render(b.quadScene, b.quadCam)

    b.quad.material = b.blurMat
    b.blurMat.uniforms.tDiffuse.value = b.rtA.texture
    b.blurMat.uniforms.uDir.value.set(1, 0)
    renderer.setRenderTarget(b.rtB)
    renderer.clear()
    renderer.render(b.quadScene, b.quadCam)

    b.blurMat.uniforms.tDiffuse.value = b.rtB.texture
    b.blurMat.uniforms.uDir.value.set(0, 1)
    renderer.setRenderTarget(b.rtA)
    renderer.clear()
    renderer.render(b.quadScene, b.quadCam)

    b.quad.material = b.compMat
    b.compMat.uniforms.tScene.value = b.sceneRT.texture
    b.compMat.uniforms.tBloom.value = b.rtA.texture
    renderer.setRenderTarget(null)
    renderer.clear()
    renderer.render(b.quadScene, b.quadCam)
  }

  /* ═════════════════ 循环 ═════════════════ */

  let raf = null
  let lastTime = performance.now()
  let frameAvg = 16
  let warmFrames = 0
  let slowStreak = 0

  function loop(now) {
    raf = requestAnimationFrame(loop)
    if (!state.visible) { lastTime = now; return }

    const dt = Math.min(64, now - lastTime)
    lastTime = now
    frameAvg = frameAvg * 0.92 + dt * 0.08

    warmFrames++
    if (warmFrames > 110 && quality.level === 'high') {
      if (frameAvg > 33) slowStreak++
      else slowStreak = 0
      if (slowStreak > 42) {
        quality.level = 'medium'
        quality.ratio = 0.62
        quality.labelLimit = 18
        buildParticles()
        slowStreak = 0
      }
    }

    const time = now / 1000

    if (cam.anim) {
      const a = cam.anim
      a.t += dt
      const k = Math.min(1, a.t / a.dur)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      cam.theta = a.fromTheta + (a.toTheta - a.fromTheta) * e
      cam.phi = a.fromPhi + (a.toPhi - a.fromPhi) * e
      cam.radius = a.fromR + (a.toR - a.fromR) * e
      cam.target.lerpVectors(a.fromTarget, a.toTarget, e)
      applyCamera()
      if (k >= 1) cam.anim = null
      state.dirty = true
    }

    if (cfg.autoRotate && !userDragging && !cam.anim) {
      cam.theta += cfg.rotateSpeed * dt
      applyCamera()
      state.dirty = true
    }

    if (pointsMesh) pointsMesh.material.uniforms.uTime.value = time
    if (dustMesh) dustMesh.material.uniforms.uTime.value = time

    if (coreGroup) {
      const u = coreGroup.userData
      // 光晕按相机距离反向缩放 → 屏幕上大小恒定（不会因拉近而铺满屏幕）
      const scaleK = cam.radius / 900
      u.halo1.scale.set(EXTENT * 0.20 * scaleK, EXTENT * 0.20 * scaleK, 1)
      u.halo2.scale.set(EXTENT * 0.52 * scaleK, EXTENT * 0.52 * scaleK, 1)
      u.ball.scale.setScalar(Math.max(0.45, Math.min(1.6, scaleK)))
      const br = Math.sin(time * 0.86) * 0.5 + 0.5
      u.halo1.material.opacity = 0.64 + br * 0.18
      u.halo2.material.opacity = 0.16 + br * 0.09
      u.ring1.material.opacity = 0.13 + br * 0.10
      u.ring1.scale.setScalar(1 + br * 0.09)
      u.ring2.material.opacity = 0.05 + br * 0.05
      u.ring2.scale.setScalar(1 + br * 0.13)
      coreGroup.rotation.y = time * 0.055
    }

    updateScale()

    if (quality.bloom) {
      if (!bloom) initBloom()
      if (bloom) renderBloom()
      else renderer.render(scene, camera)
    } else {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
    }
    state.dirty = false
  }

  /* ═════════════════ 尺寸 ═════════════════ */

  function resize() {
    const W = container.clientWidth || 1
    const H = container.clientHeight || 1
    const dpr = Math.min(window.devicePixelRatio || 1, quality.level === 'low' ? 1 : 2)
    renderer.setPixelRatio(dpr)
    renderer.setSize(W, H, false)
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    if (pointsMesh) pointsMesh.material.uniforms.uPixelRatio.value = dpr
    if (dustMesh) dustMesh.material.uniforms.uPixelRatio.value = dpr
    resizeBloom()
    updateScale()
    state.dirty = true
  }

  /* ═════════════════ 视角 ═════════════════ */

  function fitAll() {
    if (!state.nodes.length) { cam.target.set(0, 0, 0); cam.radius = 900; applyCamera(); return }
    let x0 = Infinity, y0 = Infinity, z0 = Infinity
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (const n of state.nodes) {
      if (n.px < x0) x0 = n.px; if (n.px > x1) x1 = n.px
      if (n.py < y0) y0 = n.py; if (n.py > y1) y1 = n.py
      if (n.pz < z0) z0 = n.pz; if (n.pz > z1) z1 = n.pz
    }
    // ⚠️ 以核心（原点）为取景中心：星团绕它分布，这样构图才平衡
    const cx = 0, cy = 0, cz = 0
    // span 取"离原点最远的节点的 2 倍"，保证所有星团都在视野内
    let maxR = 40
    for (const n of state.nodes) {
      const r = Math.sqrt(n.px * n.px + n.py * n.py + n.pz * n.pz)
      if (r > maxR) maxR = r
    }
    const span = Math.max(maxR * 1.85, 120)

    cam.target.set(cx, cy, cz)

    const W = container.clientWidth || 1
    const H = container.clientHeight || 1
    const safeW = Math.max(120, W - (W > 900 ? 250 : 0))
    const fovRad = (camera.fov * Math.PI) / 180
    // 垂直方向能装下的距离
    const fitH = (span / 2) / Math.tan(fovRad / 2)
    // 水平方向能装下的距离（竖屏时这一项是瓶颈，必须更大）
    const fitW = (span / 2) / (Math.tan(fovRad / 2) * (safeW / H))
    // 竖屏额外放大余量，避免星团贴边被裁
    const isPortrait = H > W * 1.2
    const margin = isPortrait ? 1.55 : 1.22
    cam.radius = Math.max(cam.minR, Math.min(cam.maxR, Math.max(fitH, fitW) * margin))
    cam.theta = 0.62
    cam.phi = 1.05
    applyCamera()
    state.dirty = true
  }

  function easeTo(t, dur) {
    cam.anim = {
      t: 0, dur: dur || 560,
      fromTheta: cam.theta, toTheta: t.theta != null ? t.theta : cam.theta,
      fromPhi: cam.phi, toPhi: t.phi != null ? t.phi : cam.phi,
      fromR: cam.radius, toR: t.radius != null ? t.radius : cam.radius,
      fromTarget: cam.target.clone(),
      toTarget: t.target ? t.target.clone() : cam.target.clone(),
    }
  }

  function focusOn(n) {
    if (!n) return
    easeTo({
      target: new THREE.Vector3(n.px, n.py, n.pz),
      radius: 165 + (n.importance || 0.4) * 85,
    }, 520)
  }

  function focusCluster(key) {
    const cl = state.clusters.get(key)
    if (!cl) return
    const len = cl.center.length() || 1
    const theta = Math.atan2(cl.center.x, cl.center.z)
    const phi = Math.acos(Math.min(0.94, Math.max(0.16, cl.center.y / len)))
    easeTo({
      theta: theta, phi: phi,
      radius: Math.max(300, cl.radius * 3.4),
      target: cl.center,
    }, 620)
  }

  /* ═════════════════ 命中测试 ═════════════════ */

  const projV = new THREE.Vector3()

  function pickNode(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect()
    let best = null, bestD = Infinity
    const maxPx = 34
    for (const n of state.nodes) {
      if (n.isEntity) continue
      projV.set(n.px, n.py, n.pz).project(camera)
      if (projV.z > 1 || projV.z < -1) continue
      const sx = (projV.x + 1) * 0.5 * rect.width
      const sy = (-projV.y + 1) * 0.5 * rect.height
      const dx = sx - (clientX - rect.left)
      const dy = sy - (clientY - rect.top)
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < maxPx && d < bestD) { bestD = d; best = n }
    }
    return best
  }

  function pickCluster(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect()
    const H = rect.height
    const pxPerWorld = H / (2 * Math.tan((camera.fov * Math.PI) / 360) * cam.radius)
    let best = null, bestD = Infinity
    for (const cl of state.clusters.values()) {
      if (cl.key === 'core') continue
      projV.copy(cl.center).project(camera)
      if (projV.z > 1 || projV.z < -1) continue
      const sx = (projV.x + 1) * 0.5 * rect.width
      const sy = (-projV.y + 1) * 0.5 * rect.height
      const d = Math.sqrt(Math.pow(sx - (clientX - rect.left), 2) + Math.pow(sy - (clientY - rect.top), 2))
      const pxR = cl.radius * pxPerWorld
      if (d < Math.max(30, pxR) && d < bestD) { bestD = d; best = cl }
    }
    return best
  }

  /* ═════════════════ 交互 ═════════════════ */

  const dom = renderer.domElement
  let ptr = null
  let moved = false

  dom.addEventListener('pointerdown', function (ev) {
    const T = window.__TRACE || (window.__TRACE = [])
    T.push('down:btn=' + ev.button + ' id=' + ev.pointerId)
    if (ev.button !== 0) return
    ptr = { x: ev.clientX, y: ev.clientY, id: ev.pointerId }
    moved = false
    userDragging = true
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
    cam.anim = null
    dom.classList.add('dragging')
    try { dom.setPointerCapture(ev.pointerId) } catch (e) {}
  })

  dom.addEventListener('pointermove', function (ev) {
    if (ptr && ptr.id === ev.pointerId) {
      const dx = ev.clientX - ptr.x
      const dy = ev.clientY - ptr.y
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true
      cam.theta -= dx * 0.0050
      cam.phi = Math.max(0.20, Math.min(Math.PI - 0.20, cam.phi - dy * 0.0042))
      applyCamera()
      ptr.x = ev.clientX
      ptr.y = ev.clientY
      state.dirty = true
      return
    }
    const hit = pickNode(ev.clientX, ev.clientY)
    if (hit !== state.hovered) {
      state.hovered = hit
      onHover(hit, ev.clientX, ev.clientY)
    } else if (hit) {
      onHover(hit, ev.clientX, ev.clientY)
    }
  })

  function endPointer(ev) {
    const T = window.__TRACE || (window.__TRACE = [])
    T.push('endPointer:hasPtr=' + !!ptr + ' moved=' + moved)
    if (!ptr) return
    const wasDrag = moved
    ptr = null
    dom.classList.remove('dragging')
    try { dom.releasePointerCapture(ev.pointerId) } catch (e) {}

    if (!wasDrag) {
      const n = pickNode(ev.clientX, ev.clientY)
      T.push('pick:' + (n ? n.id : 'null'))
      if (n) {
        state.selected = n
        try { onPick(n); T.push('onPick:ok') }
        catch (e) { T.push('onPick:ERR ' + e.message) }
      } else {
        const cl = pickCluster(ev.clientX, ev.clientY)
        if (cl) {
          focusCluster(cl.key)
          onPickCluster(cl)
        } else {
          state.selected = null
          onPickEmpty()
        }
      }
    }

    resumeTimer = setTimeout(function () { userDragging = false }, 2600)
  }

  dom.addEventListener('pointerup', endPointer)
  dom.addEventListener('pointercancel', endPointer)
  dom.addEventListener('pointerleave', function () {
    if (state.hovered) { state.hovered = null; onHover(null) }
  })

  dom.addEventListener('wheel', function (ev) {
    ev.preventDefault()
    cam.radius = Math.max(cam.minR, Math.min(cam.maxR, cam.radius * Math.exp(ev.deltaY * 0.0010)))
    applyCamera()
    state.dirty = true
  }, { passive: false })

  let pinchStart = 0
  dom.addEventListener('touchstart', function (ev) {
    if (ev.touches.length === 2) {
      const a = ev.touches[0], b = ev.touches[1]
      pinchStart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    }
  }, { passive: true })

  dom.addEventListener('touchmove', function (ev) {
    if (ev.touches.length === 2 && pinchStart > 0) {
      ev.preventDefault()
      const a = ev.touches[0], b = ev.touches[1]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      cam.radius = Math.max(cam.minR, Math.min(cam.maxR, cam.radius * (pinchStart / Math.max(1, d))))
      pinchStart = d
      applyCamera()
      state.dirty = true
    }
  }, { passive: false })

  /* ═════════════════ 对外 API ═════════════════ */

  const api = {
    setData: setData,
    fitAll: fitAll,
    relayout: function () { setData(state.nodes, state.edges) },
    focusOn: focusOn,
    focusCluster: focusCluster,
    setSelected: function (n) { state.selected = n || null; state.dirty = true },
    setSearchHits: function (ids) { state.searchHits = new Set(ids || []); state.dirty = true },
    setTheme: function (t) { THEME = t || {}; setData(state.nodes, state.edges) },
    setOption: function (k, v) {
      if (k in cfg) cfg[k] = v
      state.dirty = true
    },
    setVisible: function (v) {
      state.visible = !!v
      if (v) { lastTime = performance.now(); state.dirty = true }
    },
    stopSim: function () {},
    setAutoRotate: function (on) { cfg.autoRotate = !!on },
    setRotateSpeed: function (v) { cfg.rotateSpeed = Math.max(0.00002, Math.min(0.001, v)) },
    resize: resize,
    project: function (id) {
      const n = state.byId.get(id)
      if (!n) return null
      const rect = dom.getBoundingClientRect()
      projV.set(n.px, n.py, n.pz).project(camera)
      if (projV.z > 1 || projV.z < -1) return null
      return {
        x: (projV.x + 1) * 0.5 * rect.width,
        y: (-projV.y + 1) * 0.5 * rect.height,
        z: projV.z,
      }
    },
    projectCluster: function (key) {
      const cl = state.clusters.get(key)
      if (!cl) return null
      const rect = dom.getBoundingClientRect()
      const H = rect.height
      projV.copy(cl.center).project(camera)
      if (projV.z > 1 || projV.z < -1) return null
      const pxPerWorld = H / (2 * Math.tan((camera.fov * Math.PI) / 360) * cam.radius)
      return {
        x: (projV.x + 1) * 0.5 * rect.width,
        y: (-projV.y + 1) * 0.5 * rect.height,
        z: projV.z,
        pxRadius: cl.radius * pxPerWorld,
        count: cl.count,
      }
    },
    getClusters: function () {
      const out = []
      state.clusters.forEach(function (c) {
        out.push({
          key: c.key, label: c.label,
          color: '#' + c.color.getHexString(),
          count: c.count, radius: c.radius,
          tsMin: c.tsMin === Infinity ? null : c.tsMin,
          tsMax: c.tsMax === -Infinity ? null : c.tsMax,
          avgImportance: c.count ? c.sumImp / c.count : 0,
        })
      })
      return out
    },
    zoomBy: function (k) {
      cam.radius = Math.max(cam.minR, Math.min(cam.maxR, cam.radius * k))
      applyCamera(); state.dirty = true
    },
    /** 应用外部设置（面板设置页用） */
    applySettings: function (s) {
      if (!s) return
      if (typeof s.extent === 'number' && s.extent > 0) {
        EXTENT = s.extent
      }
      if (typeof s.rotateSpeed === 'number') cfg.rotateSpeed = s.rotateSpeed
      if (typeof s.bloom === 'boolean') {
        quality.bloom = s.bloom
        if (!s.bloom) bloom = null
      }
      if (typeof s.maxLabelCount === 'number') quality.labelLimit = s.maxLabelCount
      if (typeof s.neighborLinks === 'number') linkMeshMax = s.neighborLinks
      if (typeof s.dustCount === 'number') dustCountCfg = s.dustCount
      if (typeof s.quality === 'string' && s.quality !== 'auto') {
        quality.level = s.quality
        quality.ratio = s.quality === 'high' ? 1 : (s.quality === 'medium' ? 0.62 : 0.34)
        quality.bloom = s.quality !== 'low'
      }
      state.dirty = true
    },

    setQuality: function (level) {
      quality.level = level
      quality.ratio = level === 'high' ? 1 : (level === 'medium' ? 0.62 : 0.34)
      quality.bloom = level !== 'low'
      quality.labelLimit = level === 'high' ? 28 : (level === 'medium' ? 18 : 12)
      buildParticles()
      state.dirty = true
    },
    getQuality: function () { return quality.level },
    /** 调试：给定客户端坐标，返回命中的节点 id / 星团 key */
    pickAt: function (clientX, clientY) {
      const n = pickNode(clientX, clientY)
      const c = pickCluster(clientX, clientY)
      return { node: n ? n.id : null, cluster: c ? c.key : null }
    },
    /** 调试：扫描屏幕上离给定点最近的节点（像素距离） */
    nearestNode: function (clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect()
      let best = null, bestD = Infinity
      for (const n of state.nodes) {
        if (n.isEntity) continue
        projV.set(n.px, n.py, n.pz).project(camera)
        if (projV.z > 1 || projV.z < -1) continue
        const sx = (projV.x + 1) * 0.5 * rect.width
        const sy = (-projV.y + 1) * 0.5 * rect.height
        const d = Math.sqrt(Math.pow(sx - (clientX - rect.left), 2) + Math.pow(sy - (clientY - rect.top), 2))
        if (d < bestD) { bestD = d; best = n }
      }
      return best ? { id: best.id, dist: Number(bestD.toFixed(1)) } : null
    },
    _debug: function () {
      return {
        nodes: state.nodes.length,
        edges: state.edges.length,
        clusters: state.clusters.size,
        selected: state.selected ? state.selected.id : null,
        quality: quality.level,
        radius: Number(cam.radius.toFixed(0)),
        camDist: Number(camera.position.length().toFixed(0)),
        bloom: !!bloom,
        particles: pointsMesh ? pointsMesh.geometry.attributes.position.count : 0,
        frames: warmFrames,
        frameAvg: Number(frameAvg.toFixed(1)),
      }
    },
  }

  resize()
  applyCamera()
  loop(performance.now())

  const ro = new ResizeObserver(function () { resize() })
  ro.observe(container)

  return api
}
