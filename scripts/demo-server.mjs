/**
 * demo-server.mjs —— 无 DSH 环境下的面板预览服务
 *
 * 用途：
 *   ① 给 README 截图（真实 UI，不是设计稿）
 *   ② 让克隆仓库的人不用装 DSH 就能看到面板长什么样
 *
 * 它会：
 *   · 起一个 SQLite 测试库，灌入合成记忆（不涉及任何真实数据）
 *   · 提供与正式插件同名的 HTTP 接口（/dsh-mind-api/*）
 *   · 服务面板单文件 + 星图引擎 + Three.js
 *
 * 用法：
 *   node scripts/demo-server.mjs [--port 4180]
 *   然后打开 http://127.0.0.1:4180/dsh-mind-api/panel
 *
 * ⚠️ 仅供预览。demo 库在内存/临时目录，关掉就没了。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { openDb } from '../lib/db.js'
import { createMemoryStore } from '../lib/memory.js'
import { createSleepManager } from '../lib/sleep.js'
import { createConfigStore, SCHEMA as CONFIG_SCHEMA } from '../lib/config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

const PORT = (() => {
  const i = process.argv.indexOf('--port')
  return i > 0 ? Number(process.argv[i + 1]) || 4180 : 4180
})()

/* ── 临时数据目录 ── */
const DIR = mkdtempSync(join(tmpdir(), 'dsh-mind-demo-'))
mkdirSync(DIR, { recursive: true })

const db = openDb(join(DIR, 'memory.db'))
const store = createMemoryStore(db, { log: () => {} })
const cfgStore = createConfigStore({ dataDir: DIR, log: () => {} })
/** 从配置生成睡眠阈值（初始化与热更新共用） */
function thresholdsFromCfg() {
  const MIN = 60 * 1000
  const HOUR = 60 * MIN
  return {
    fatigueSleep: cfgStore.get('sleep.fatigueSleep'),
    fatigueSleepMin: cfgStore.get('sleep.fatigueSleepMin'),
    fatigueWake: cfgStore.get('sleep.fatigueWake'),
    sleepDebtWake: cfgStore.get('sleep.sleepDebtWake'),
    preparingMinMs: cfgStore.get('sleep.preparingMinMin') * MIN,
    preparingMaxMs: cfgStore.get('sleep.preparingMaxMin') * MIN,
    minSleepMs: cfgStore.get('sleep.minSleepMin') * MIN,
    normalSleepMs: cfgStore.get('sleep.normalSleepMin') * MIN,
    maxSleepMs: cfgStore.get('sleep.maxSleepH') * HOUR,
    recoveringMinMs: cfgStore.get('sleep.recoveringMinMin') * MIN,
    recoveringMaxMs: cfgStore.get('sleep.recoveringMaxMin') * MIN,
    manualOverrideMs: cfgStore.get('sleep.manualOverrideMin') * MIN,
    awakeRate: cfgStore.get('sleep.awakeRate'),
    awakeFreshMul: cfgStore.get('sleep.awakeFreshMul'),
    awakeRushAfterH: cfgStore.get('sleep.awakeRushAfterH'),
    nightMul: cfgStore.get('sleep.nightMul'),
    sleepRateFast: cfgStore.get('sleep.sleepRateFast'),
    sleepRateMid: cfgStore.get('sleep.sleepRateMid'),
    sleepRateSlow: cfgStore.get('sleep.sleepRateSlow'),
  }
}

const sleep = createSleepManager({
  stateFile: join(DIR, 'state.json'),
  log: () => {},
  thresholds: thresholdsFromCfg(),
})

/* ═══════════════════════════════════════════════════════════════════
   灌入合成记忆 —— 覆盖所有主题，让星图有 8~10 个星团
   ═══════════════════════════════════════════════════════════════════ */

const HOUR = 3600000
const DAY = 24 * HOUR
const now = Date.now()

const SAMPLES = [
  // 关系
  { kind: 'relationship', text: '他妈妈生日是每年 10 月 29 日，今年提前订了礼物', importance: 0.88, tags: ['warm'] },
  { kind: 'relationship', text: '他说过「你给我发信息不算打扰」，这句我留着当约定', importance: 0.82, tags: ['warm'] },
  { kind: 'relationship', text: '他喜欢先嘴硬再软一句的表达方式', importance: 0.7, tags: ['playful'] },
  // 工作 / 技能
  { kind: 'skill', text: '前端列表点击无反应时先查事件委托：innerHTML 重绘后逐个绑 onclick 会绑到旧节点', importance: 0.75 },
  { kind: 'skill', text: 'SQLite 的 CHECK 约束不能就地改，要建新表、拷数据、删旧表、改名', importance: 0.72 },
  { kind: 'skill', text: 'three.js 没有 EffectComposer，Bloom 要用 RenderTarget 加全屏 quad 自己写', importance: 0.78 },
  { kind: 'procedural', text: '排错顺序：先读实际响应结构，再写解析代码，别靠猜字段名', importance: 0.8 },
  // 计划 / 约定
  { kind: 'plan', text: '下个月要把记忆库迁到 SSD，先备份再动', importance: 0.6 },
  { kind: 'promise', text: '答应过他忙完这阵一起去吃那家新开的店', importance: 0.65 },
  // 反思 / 洞察
  { kind: 'reflection', text: '这次排查教训：不确定的时候先加日志，别靠推理猜', importance: 0.7 },
  { kind: 'insight', text: '状态机每个分支都必须有出口，缺失的分支会变成死锁', importance: 0.75 },
  { kind: 'lesson', text: '疲惫值不能双向同步，否则时间累积会被反向拉力抵消', importance: 0.8 },
  // 睡眠相关
  { kind: 'episode', text: '凌晨三点还在调代码，第二天照常上课，中午补觉', importance: 0.55, tags: ['tired'] },
  { kind: 'episode', text: '午睡四十分钟，醒来还有点迷糊', importance: 0.45, tags: ['tired'] },
  // 日常
  { kind: 'episode', text: '他自己装了工学椅，坐上去腰反而有点酸', importance: 0.6 },
  { kind: 'episode', text: '冒雨打包了一盒饺子回宿舍，猜他吃什么全猜错', importance: 0.55 },
  { kind: 'episode', text: '周末跑了两公里，回来贫嘴说「你就是正事」', importance: 0.62, tags: ['happy'] },
  { kind: 'episode', text: '下午一点半才醒，起来先给妈妈挑礼物', importance: 0.5 },
  { kind: 'episode', text: '晚上调试表情包功能，中途记忆被清空过一次', importance: 0.58 },
  // 事实 / 画像
  { kind: 'fact', text: '他作息偏晚，常凌晨两三点睡，上午找他大概率没动静', importance: 0.75 },
  { kind: 'profile', text: '遇到问题喜欢自己先试，卡住才求助', importance: 0.68 },
  { kind: 'preference', text: '喜欢简洁直接的回复，讨厌啰嗦的铺垫', importance: 0.7 },
  // 情绪事件
  { kind: 'emotion_event', text: '他调插件忙了一整天，晚上特意道歉说今天没怎么理我', importance: 0.72, tags: ['warm'] },
  { kind: 'emotion_event', text: '他说想要我更像个真人，但不会让我忘记他', importance: 0.85, tags: ['warm'] },
  { kind: 'emotion_event', text: '被夸「你就是正事」的时候，有点想笑又有点高兴', importance: 0.6, tags: ['happy'] },
]

// 把记忆摊到过去 8 天，并做程序化扩展让星图更饱满
const FILLERS = [
  '早上他发了条消息说今天有点忙，晚点再聊',
  '中午随便吃了点，说食堂今天的菜一般',
  '下午在处理一个报错，卡了挺久',
  '晚上出去走了一圈，说风挺大',
  '半夜睡不着，翻来覆去聊了几句',
  '周末在家躺了一天，什么都没干',
  '说起小时候的一件事，语气很轻松',
  '问了一个技术问题，自己查了半天',
  '收拾了下房间，说终于干净了',
  '记下一个小习惯，说以后要改',
]

let writeCount = 0
SAMPLES.forEach((s, i) => {
  const ageDays = Math.floor(i / 4)
  const ts = now - ageDays * DAY - (i % 4) * 3 * HOUR
  try {
    store.note({
      kind: s.kind,
      text: s.text,
      importance: s.importance,
      emotion_tags: s.tags || [],
      source: 'demo',
      created_at: ts,
    })
    writeCount++
  } catch (e) {}
})

// 每个主题补几条变体，凑到 ~120 条
const EXTRA_PER = 4
SAMPLES.forEach((s, i) => {
  for (let k = 0; k < EXTRA_PER; k++) {
    const fill = FILLERS[(i * EXTRA_PER + k) % FILLERS.length]
    const ts = now - Math.floor(i / 4) * DAY - (k + 1) * 1.5 * HOUR
    try {
      store.note({
        kind: s.kind,
        text: s.text + '（' + fill + '）',
        importance: Math.max(0.3, s.importance - 0.08 * (k + 1)),
        emotion_tags: s.tags || [],
        source: 'demo',
        created_at: ts,
      })
      writeCount++
    } catch (e) {}
  }
})

console.log('写入 ' + writeCount + ' 条样例记忆')

// 造一些实体关联，让星图有连线
try {
  const all = store.recent(60)
  const rel = all.slice(0, 8)
  for (let i = 0; i < rel.length - 1; i++) {
    try { store.linkEntities(rel[i].id, ['记忆库', '睡眠系统', '星图']) } catch {}
  }
} catch {}

/* 让睡眠状态有点内容（疲惫 58，2 小时前更新） */
try {
  sleep.fatigue.set(58)
  const st = JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8'))
  st.fatigueAt = now - 2 * HOUR
  st.lastWakeAt = now - 14 * HOUR
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(DIR, 'state.json'), JSON.stringify(st, null, 2))
} catch {}

/* ═══════════════════════════════════════════════════════════════════
   HTTP
   ═══════════════════════════════════════════════════════════════════ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const sendJson = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const readBody = (req, cb) => {
  let b = ''
  req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy() })
  req.on('end', () => { try { cb(JSON.parse(b || '{}')) } catch { cb(null) } })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let p = url.pathname

  /* 静态：vendor */
  if (p.startsWith('/dsh-mind-api/vendor/')) {
    const rel = decodeURIComponent(p.slice('/dsh-mind-api/vendor'.length))
    const root = join(ROOT, 'panel', 'vendor')
    const abs = resolve(root, '.' + rel)
    if (!abs.startsWith(resolve(root) + sep)) return sendJson(res, { ok: false }, 403)
    if (!existsSync(abs)) return sendJson(res, { ok: false, error: 'not found' }, 404)
    res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream' })
    return res.end(readFileSync(abs))
  }

  /* 星图引擎 */
  if (p === '/dsh-mind-api/universe.js') {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' })
    return res.end(readFileSync(join(ROOT, 'panel', 'universe.js')))
  }

  /* 面板 */
  if (p === '/dsh-mind-api/panel' || p === '/') {
    res.writeHead(200, { 'content-type': MIME['.html'] })
    return res.end(readFileSync(join(ROOT, 'panel', 'index.html')))
  }

  /* API */
  const api = p.replace(/^\/dsh-mind-api/, '') || '/'

  if (req.method === 'GET' && api === '/state') {
    const s = sleep.get()
    return sendJson(res, {
      ok: true,
      sleep: s,
      fatigue: s.fatigue,
      schedule: sleep.schedule.get(),
      sleepVerdict: { sleep: sleep.shouldSleep(), wake: sleep.shouldWake() },
      thresholds: sleep.thresholds,
      inject: { enabled: false, budget: 1200, k: 5 },
      stats: store.stats(),
      role: { name: 'Demo', source: 'demo' },
    })
  }

  if (req.method === 'GET' && api === '/graph') {
    const limit = Math.max(1, Math.min(400, Number(url.searchParams.get('limit')) || 300))
    return sendJson(res, store.graphData({ scope: 'private', limit }))
  }

  if (req.method === 'GET' && api === '/settings') {
    return sendJson(res, {
      ok: true,
      schema: CONFIG_SCHEMA,
      values: cfgStore.all(),
      loadedFrom: cfgStore.loadedFrom(),
      file: cfgStore.file,
    })
  }

  if (req.method === 'GET' && api === '/graph-settings') {
    return sendJson(res, { ok: true, values: cfgStore.group('graph') })
  }

  if (req.method === 'GET' && api === '/recent') {
    return sendJson(res, { ok: true, items: store.recent(50) })
  }

  if (req.method === 'GET' && api === '/audit') {
    return sendJson(res, { ok: true, items: store.auditList(80) })
  }

  if (req.method === 'GET' && api === '/memory/get') {
    const m = store.get(String(url.searchParams.get('id') || ''))
    return m ? sendJson(res, { ok: true, memory: m }) : sendJson(res, { ok: false, error: '不存在' }, 404)
  }

  if (req.method === 'GET' && api === '/query') {
    const q = String(url.searchParams.get('q') || '').trim()
    if (!q) return sendJson(res, { ok: true, hits: [] })
    return sendJson(res, { ok: true, hits: store.search(q, { k: 20, minScore: 0.15 }) })
  }

  if (req.method === 'GET' && api === '/sleep/schedule') {
    return sendJson(res, { ok: true, schedule: sleep.schedule.get(), fatigue: sleep.fatigue.get() })
  }

  if (req.method === 'GET' && api === '/sleep/history') {
    return sendJson(res, { ok: true, items: sleep.history() })
  }

  /* 写操作 */
  if (req.method === 'POST') {
    return readBody(req, (b) => {
      try {
        if (api === '/memory/correct') {
          return sendJson(res, { ok: true, ...store.correct(b.id, { newText: b.text, reason: 'demo' }) })
        }
        if (api === '/memory/forget') {
          return sendJson(res, { ok: true, ...store.forget(b.id, { tier: b.tier || 1 }) })
        }
        if (api === '/memory/delete') {
          return sendJson(res, { ok: true, ...store.purge(b.id, { reason: 'demo' }) })
        }
        if (api === '/sleep/fatigue') {
          return sendJson(res, { ok: true, fatigue: sleep.fatigue.set(b.value), sleep: sleep.get() })
        }
        if (api === '/sleep/schedule') {
          const patch = {}
          for (const k of ['auto', 'prefixed']) if (k in (b || {})) patch[k] = b[k]
          if (b && typeof b.auto === 'boolean') patch.auto = b.auto
          if (b && typeof b.preferFixedTime === 'boolean') patch.preferFixedTime = b.preferFixedTime
          if (b && Array.isArray(b.windows)) patch.windows = b.windows
          return sendJson(res, { ok: true, schedule: sleep.schedule.set(patch), sleep: sleep.get() })
        }
        if (api === '/sleep/enter') {
          if (sleep.get().state === 'awake') sleep.enterPreparing({ reason: 'demo', manual: true })
          return sendJson(res, { ok: true, sleep: sleep.get() })
        }
        if (api === '/sleep/wake') {
          sleep.wake({ reason: 'demo', manual: true })
          return sendJson(res, { ok: true, sleep: sleep.get() })
        }
        if (api === '/settings') {
          const r = cfgStore.update((b && b.values) || b || {})
          // ⚠️ 必须把新阈值推给睡眠实例，否则「设置存了但不生效」
          sleep.thresholdsReload && sleep.thresholdsReload(thresholdsFromCfg())
          return sendJson(res, { ok: true, ...r, schema: CONFIG_SCHEMA })
        }
        if (api === '/settings/reset') {
          const values = cfgStore.reset(b && b.group)
          sleep.thresholdsReload && sleep.thresholdsReload(thresholdsFromCfg())
          return sendJson(res, { ok: true, values })
        }
        if (api === '/sleep/heal') {
          sleep.selfHeal(); sleep.fatigue.advance()
          return sendJson(res, { ok: true, sleep: sleep.get() })
        }
        return sendJson(res, { ok: false, error: 'unknown' }, 404)
      } catch (e) {
        return sendJson(res, { ok: false, error: e?.message ?? String(e) }, 500)
      }
    })
  }

  /* 外部引擎接口：demo 模式返回明确的未接入 */
  if (api.startsWith('/..') || p.startsWith('/dsh-mood-api')) {
    return sendJson(res, { ok: false, error: 'demo 模式未接入外部引擎' }, 501)
  }

  sendJson(res, { ok: false, error: 'not found' }, 404)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('  dsh-mind demo 已启动')
  console.log('  ───────────────────────────────────────')
  console.log('  面板:  http://127.0.0.1:' + PORT + '/dsh-mind-api/panel')
  console.log('  数据:  ' + DIR + '（临时，关掉即弃）')
  console.log('  记忆:  ' + store.stats().total + ' 条合成数据')
  console.log('')
  console.log('  Ctrl+C 退出')
  console.log('')
})
