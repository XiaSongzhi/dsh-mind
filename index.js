// ═══════════════════════════════════════════════════════════════════
// dsh-mind —— 统一记忆 / 睡眠 / 管理面板（DSH 插件）
// ───────────────────────────────────────────────────────────────────
//
// 这个插件只做三件事，边界清晰：
//
//   ① 结构化长期记忆（SQLite + FTS5 中文 bigram）
//      写入：mind_memory 工具 / 面板编辑 / 会话整理器
//      读取：mind_memory 检索 + 每轮提示词注入（可关）
//
//   ② 睡眠状态机（四态 + 疲惫值）
//      awake → preparing → sleeping → recovering → awake
//      疲惫值按**真实经过时间**补算，不依赖定时器作为时钟
//
//   ③ 独立管理面板（/dsh-mind-api/panel）
//      星图 / 心情 / 日记 / 经验卡 / 品味 / 记忆 / 睡眠 / 角色卡 / 消费 / 系统
//
// ── 与外部系统的关系 ──
//
// 本插件**不依赖**任何特定桥接或角色系统。可选集成通过环境变量配置：
//
//   DSH_MIND_DATA_DIR          记忆库目录（默认 $DSH_HOME/dsh-mind）
//   DSH_MIND_INJECT            是否每轮注入记忆（'1' 开启，默认关）
//   DSH_MIND_INJECT_BUDGET     注入预算字符数（默认 1200）
//   MEMORY_SESSION_CWD_FILTER  整理器允许的会话 cwd 片段（逗号分隔）
//
// 面板的「角色卡 / 消费」两页对接外部桥接服务，配置见 README。
// 未配置时这两页显示明确的"未连接"状态，不影响其他功能。
//
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDb } from './lib/db.js'
import { createMemoryStore, setMemoryOptions } from './lib/memory.js'
import { createSleepManager } from './lib/sleep.js'
import { createConsolidator } from './lib/consolidate.js'
import { importMoodArchive, dataDir as resolveDataDir } from './lib/pointer.js'
import { createNameResolver } from './lib/identity.js'
import { createConfigStore, SCHEMA as CONFIG_SCHEMA } from './lib/config.js'

export const name = 'dsh-mind'

const __dirname = (() => {
  try { return fileURLToPath(new URL('.', import.meta.url)) }
  catch { return process.cwd() }
})()

/* ── 配置：全部来自 lib/config.js 的 SCHEMA ──
   下面这些是"从 settings 读出来的便捷视图"，改配置走 cfgStore.update() */

/* ═══════════════════════════════════════════════════════════════════ */

export function apply(ctx, rawConfig) {
  const log = (...a) => { try { console.log('[dsh-mind]', ...a) } catch { /* ignore */ } }

  /* 数据目录先算出来，配置要落到那里 */
  const dataDirForCfg = resolveDataDir(rawConfig || {})

  /* 配置中心：所有可调参数集中管理，落盘到 settings.json */
  const cfgStore = createConfigStore({ dataDir: dataDirForCfg, log })
  cfgStore.seedFromEnv()

  /* 便捷视图：插件内部用的短名字，映射到 settings 的 key */
  function readCfg() {
    return {
      inject: cfgStore.get('inject.enabled'),
      injectBudgetChars: cfgStore.get('inject.budgetChars'),
      recallK: cfgStore.get('inject.recallK'),
      minScore: cfgStore.get('inject.minScore'),
      sleepEnabled: cfgStore.get('sleep.enabled'),
      sleepIdleMinutes: cfgStore.get('sleep.idleMinutes'),
      sleepGraceMinutes: cfgStore.get('sleep.preparingMinMin'),
      sleepTickSeconds: cfgStore.get('sleep.tickSeconds'),
    }
  }
  let cfg = readCfg()

  /* 外部集成配置 */
  const externalCfg = () => ({
    moodEnabled: cfgStore.get('external.moodEnabled'),
    bridgeEnabled: cfgStore.get('external.bridgeEnabled'),
    bridgeConfigPath: cfgStore.get('external.bridgeConfigPath'),
    bridgePort: cfgStore.get('external.bridgePort'),
    bridgeToken: cfgStore.get('external.bridgeToken'),
    bridgeDir: cfgStore.get('external.bridgeDir'),
  })

  /* 睡眠阈值视图（传给 sleep manager） */
  const sleepThresholds = () => ({
    fatigueSleep: cfgStore.get('sleep.fatigueSleep'),
    fatigueSleepMin: cfgStore.get('sleep.fatigueSleepMin'),
    fatigueWake: cfgStore.get('sleep.fatigueWake'),
    sleepDebtWake: cfgStore.get('sleep.sleepDebtWake'),
    preparingMinMs: cfgStore.get('sleep.preparingMinMin') * 60 * 1000,
    preparingMaxMs: cfgStore.get('sleep.preparingMaxMin') * 60 * 1000,
    minSleepMs: cfgStore.get('sleep.minSleepMin') * 60 * 1000,
    normalSleepMs: cfgStore.get('sleep.normalSleepMin') * 60 * 1000,
    maxSleepMs: cfgStore.get('sleep.maxSleepH') * 60 * 60 * 1000,
    recoveringMinMs: cfgStore.get('sleep.recoveringMinMin') * 60 * 1000,
    recoveringMaxMs: cfgStore.get('sleep.recoveringMaxMin') * 60 * 1000,
    manualOverrideMs: cfgStore.get('sleep.manualOverrideMin') * 60 * 1000,
    awakeRate: cfgStore.get('sleep.awakeRate'),
    awakeFreshMul: cfgStore.get('sleep.awakeFreshMul'),
    awakeRushAfterH: cfgStore.get('sleep.awakeRushAfterH'),
    nightMul: cfgStore.get('sleep.nightMul'),
    sleepRateFast: cfgStore.get('sleep.sleepRateFast'),
    sleepRateMid: cfgStore.get('sleep.sleepRateMid'),
    sleepRateSlow: cfgStore.get('sleep.sleepRateSlow'),
  })

  /* ═══ 核心：SQLite + 睡眠 ═══ */

  const dataDir = dataDirForCfg
  mkdirSync(dataDir, { recursive: true })

  /* 把 settings 里的记忆参数灌进运行时 */
  try {
    setMemoryOptions({
      dedupeKinds: cfgStore.get('memory.dedupeKinds'),
      maxTextLen: cfgStore.get('memory.maxTextLen'),
      mergeSimilar: cfgStore.get('memory.mergeSimilar'),
    })
  } catch (e) { log('记忆设置初始化失败：' + (e?.message ?? e)) }

  const db = openDb(join(dataDir, 'memory.db'))
  const store = createMemoryStore(db, { log })

  // 一次性导入 dsh-mood 的 jsonl 归档（幂等，已完成则跳过）
  try {
    const r = importMoodArchive(store, { db, dataDir })
    if (r.imported) log('已导入 dsh-mood 归档 ' + r.imported + ' 条')
  } catch (e) { log('归档导入跳过：', e?.message ?? e) }

  const sleep = createSleepManager({
    stateFile: join(dataDir, 'state.json'),
    log,
    thresholds: sleepThresholds(),
  })

  // 角色名自动探测（不写死）
  const nameResolver = createNameResolver({ log })
  let roleName = { name: 'Memoryverse', source: 'fallback' }
  try {
    const local = nameResolver.resolveLocal()
    if (local) roleName = local
  } catch { /* 探测失败用兜底 */ }

  // 若 state.json 里存过手动设置的名字，优先用那个
  try {
    const sf = join(dataDir, 'state.json')
    if (existsSync(sf)) {
      const j = JSON.parse(readFileSync(sf, 'utf8'))
      if (j.roleName && String(j.roleName).trim()) {
        roleName = { name: String(j.roleName).trim(), source: 'manual' }
      }
    }
  } catch {}

  // 后台异步补一次（桥接可用时能拿到更准的名字）
  (async () => {
    try {
      const r = await nameResolver.resolve({ bridgeConfig: readBridgeConfig() })
      if (r && r.name) {
        roleName = r
        log('角色名: ' + r.name + '（来源 ' + r.source + '）')
      }
    } catch {}
  })()

  /* ═══ 会话事件：活动心跳 + 入睡取消 ═══ */

  let lastActivityAt = Date.now()

  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', (_session, event) => {
        try {
          lastActivityAt = Date.now()
          const type = event?.type
          if (type === 'user/message') {
            const d = event?.data
            const txt = typeof d === 'string' ? d
              : typeof d?.text === 'string' ? d.text
              : typeof d?.content === 'string' ? d.content : ''
            queryHint = txt.slice(0, 400)
            // 准备入睡期间来消息 → 取消入睡（说明人还在）
            if (sleep.get().state === 'preparing') {
              sleep.cancel()
              log('用户有互动，取消入睡')
            }
          }
        } catch { /* 事件处理不许抛 */ }
      })
    }
  } catch { /* 宿主无事件总线 */ }

  let queryHint = ''

  /* ═══ 睡眠驱动 ═══
     关键设计：定时器只负责"多久检查一次"，
     疲惫值的推进永远由 sleep.tickFatigue() 按真实时间补算。 */

  const consolidator = createConsolidator({ db, store, sleep, getSessionCtl, log })

  function getSessionCtl() {
    try {
      const sc = ctx.get ? ctx.get('sessionController') : ctx.sessionController
      return sc || {}
    } catch { return {} }
  }

  const sleepTimer = setInterval(() => {
    try {
      // ① 按真实经过时间补算疲惫值
      try { sleep.tickFatigue() } catch {}

      // ② 单向同步给 mood 的「疲惫」维度
      try {
        const cur = sleep.get()
        syncFatigueToMood(cur.fatigue)
      } catch {}

      const s = sleep.get()

      // ② 四态推进
      if (s.state === 'awake') {
        if (cfg.sleepEnabled) {
          let v = null
          try { v = sleep.shouldSleep() } catch {}
          if (v && v.yes) {
            try {
              sleep.enterPreparing({ reason: v.why })
              log('进入准备入睡：' + v.why)
            } catch (e) { log('入睡失败：', e?.message ?? e) }
          } else if (Date.now() - lastActivityAt >= cfg.sleepIdleMinutes * 60000) {
            try {
              sleep.enterPreparing({ reason: '已空闲 ' + cfg.sleepIdleMinutes + ' 分钟' })
            } catch {}
          }
        }
      } else if (s.state === 'preparing') {
        let wv = null
        try { wv = sleep.shouldWake() } catch {}
        const elapsed = Date.now() - (s.since || Date.now())
        if ((wv && wv.trigger === 'to-sleep') ||
            elapsed >= cfg.sleepGraceMinutes * 60000) {
          try { sleep.enterSleeping({ reason: wv ? wv.why : '过渡完成' }) } catch {}
        }
      } else if (s.state === 'sleeping') {
        let wv = null
        try { wv = sleep.shouldWake() } catch {}
        if (wv && wv.yes) {
          try {
            sleep.enterRecovering({ reason: wv.why })
            log('进入将醒：' + wv.why)
          } catch (e) { log('进将醒失败：', e?.message ?? e) }
        }
        // ─── 记忆整理：只在夜间睡眠时做 ───
        // 白天小睡只恢复疲惫值，不整理记忆。
        let nightOk = { yes: false, window: null }
        try { nightOk = sleep.isNightSleep() } catch {}

        if (nightOk.yes) {
          Promise.resolve()
            .then(() => consolidator.tick(getSessionCtl()))
            .then((r) => {
              if (r && r.done === true) {
                try { sleep.setReport({ at: Date.now(), steps: 13 }) } catch {}
                log('夜间睡眠整理完成（不影响醒来时机）')
              }
            })
            .catch((e) => log('整理器异常（下拍重试）：', e?.message ?? e))
        } else if (!globalThis.__dshMindNapLogged) {
          globalThis.__dshMindNapLogged = true
          log('白天睡眠，不整理记忆（仅恢复疲惫值）')
        }
      } else if (s.state === 'recovering') {
        // 这一支必须存在 —— 否则 recovering 会永久卡住
        let wv = null
        try { wv = sleep.shouldWake() } catch {}

        if (wv && wv.yes) {
          try {
            globalThis.__dshMindNapLogged = false
            sleep.markJustWoke({ sleptMin: wv.sleptMin || 0 })
            sleep.wake({ reason: wv.why })
            log('回到清醒：' + wv.why)
          } catch (e) { log('唤醒失败：', e?.message ?? e) }

        } else if (wv && wv.inWindow && !s.manualOverride) {
          // 仍在作息窗口内 → 不该停在将醒，退回沉睡继续睡
          try {
            sleep.enterSleeping({ reason: '仍在作息窗口内，继续沉睡' })
            log('仍在窗口内，从将醒退回沉睡')
          } catch (e) { /* 状态机不允许则忽略，下拍再看 */ }
        }
      }
    } catch (e) { log('睡眠驱动异常：', e?.message ?? e) }
  }, Math.max(5, cfg.sleepTickSeconds) * 1000)
  sleepTimer.unref?.()

  ctx.effect?.(() => () => { try { clearInterval(sleepTimer) } catch {} })

  /* ═══ 工具注册 ═══ */

  const tools = (() => {
    try { return ctx.get ? ctx.get('tools') : ctx.tools } catch { return null }
  })()

  if (tools && typeof tools.register === 'function') {
    registerTools(tools, ctx)
  } else {
    log('工具注册器不可用，跳过工具注册')
  }

/**
 * 把睡眠系统的 fatigue 单向同步到 mood 引擎的「疲惫」维度。
 *
 * 为什么单向：fatigue 是唯一真相（state.json），mood 只是展示投影。
 * 只改 tired 一个维度，不动其他 32 维（那是 mood 自己演化的）。
 *
 * mood 配置文件位置：
 *   · 显式配置 > $DSH_HOME/dsh-mood.json
 * 结构（实测）：
 *   { values: { calm: 0, happy: 46.8, tired: 27.9, ... } }
 */
function syncFatigueToMood(fatigue) {
  try {
    if (typeof fatigue !== 'number' || !isFinite(fatigue)) return

    const home = process.env.DSH_HOME
      || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
    const file = process.env.DSH_MOOD_FILE || join(home, 'dsh-mood.json')
    if (!existsSync(file)) return

    const st = JSON.parse(readFileSync(file, 'utf8'))

    let cur = null
    let setter = null
    const vals = st.values

    if (vals && typeof vals === 'object' && !Array.isArray(vals)) {
      if (typeof vals.tired === 'number') {
        cur = vals.tired
        setter = function (v) { vals.tired = v }
      }
    } else if (Array.isArray(vals)) {
      const t = vals.find(function (x) { return x && x.id === 'tired' })
      if (t && typeof t.value === 'number') {
        cur = t.value
        setter = function (v) { t.value = v }
      }
    }

    if (setter == null || cur == null) return

    const target = Math.round(fatigue * 10) / 10
    // 0.8 的阈值：既能避免每拍狂写盘，又让显示跟得上实际值
    if (Math.abs(cur - target) < 0.8) return

    setter(target)
    st.updatedAt = Date.now()
    writeFileSync(file, JSON.stringify(st, null, 2))
    log('mood 疲惫已同步为 ' + target)
  } catch (e) {
    log('mood 同步失败：' + (e?.message ?? e))
  }
}

  function registerTools(tools, ctx) {
    const { defineTool } = globalThis.__DSH_TOOL_HELPERS || {}
    // 宿主提供 defineTool；没有就退化为裸对象（部分 DSH 版本可直接注册）
    const wrap = typeof defineTool === 'function' ? defineTool : (x) => x

    /* ── mind_memory ── */
    ctx.effect(() => tools.register(wrap({
      name: 'mind_memory',
      description:
        '长期记忆库（结构化，跨会话可查）。' +
        'action=search 关键词检索；action=note 写入一条；' +
        'action=recent 最近写入；action=stats 概况。' +
        '只写以后用得上的事，一条一句话。',
      parameters: {
        action: { type: 'string', enum: ['search', 'note', 'recent', 'stats'] },
        query: { type: 'string', description: 'search 的关键词' },
        text: { type: 'string', description: 'note 的记忆正文' },
        kind: { type: 'string', description: '记忆类型（episode/fact/reflection/skill/lesson）' },
        importance: { type: 'number', description: '0~1 重要程度' },
      },
      execute(a = {}) {
        switch (a.action) {
          case 'search': {
            const hits = store.search(a.query || '', { k: cfg.recallK, minScore: cfg.minScore })
            return { ok: true, hits, message: '检索到 ' + hits.length + ' 条相关记忆' }
          }
          case 'note': {
            const r = store.note({
              kind: a.kind, text: a.text,
              importance: a.importance ?? 0.5,
              source: 'agent-note', is_inference: true,
            })
            return {
              ok: true, id: r.id, duplicateOf: r.duplicateOf ?? null,
              message: r.duplicateOf ? '已合并到相似记忆' : '已写入长期记忆',
            }
          }
          case 'recent': {
            const items = store.recent(10)
            return { ok: true, items, message: '最近 ' + items.length + ' 条记忆' }
          }
          case 'stats':
            return { ok: true, ...store.stats(), message: '记忆库概况' }
          default:
            return { ok: false, error: '未知 action' }
        }
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
    })), 'dsh-mind: mind_memory')

    /* ── mind_sleep ── */
    ctx.effect(() => tools.register(wrap({
      name: 'mind_sleep',
      description:
        '你自己的睡眠。' +
        'action=state 查看状态；action=sleep 想去睡（带理由）；action=wake 想醒。' +
        '睡眠是像人一样的作息：累了就睡，睡够了就醒。' +
        '睡着时不会回复任何人，醒来后会有"刚睡醒"的迷糊感。',
      parameters: {
        action: { type: 'string', enum: ['state', 'sleep', 'wake'] },
        reason: { type: 'string', description: '为什么想睡/想醒（会记录）' },
        mood: { type: 'string', description: '睡前心情（可选）' },
      },
      execute(a = {}) {
        const action = a.action || 'state'
        const s = sleep.get()

        if (action === 'sleep') {
          try { sleep.intendSleep({ reason: a.reason || '', mood: a.mood || '' }) } catch {}
          let moved = null
          try {
            if (s.state === 'awake') moved = sleep.enterPreparing({ reason: a.reason || '自己想睡' })
          } catch {}
          return {
            ok: true, state: (moved && moved.state) || s.state,
            message: '好，我去睡了。' + (a.reason ? '（' + a.reason + '）' : ''),
          }
        }

        if (action === 'wake') {
          try { sleep.intendWake({ reason: a.reason || '' }) } catch {}
          let moved = null
          try {
            if (sleep.get().state === 'sleeping') {
              sleep.enterRecovering({ reason: '自己想醒' })
              moved = sleep.wake({ reason: a.reason || '自己想醒' })
            } else if (['preparing', 'recovering'].includes(sleep.get().state)) {
              moved = sleep.wake({ reason: a.reason || '自己想醒' })
            }
          } catch {}
          return {
            ok: true, state: (moved && moved.state) || s.state,
            message: '我醒了。' + (a.reason ? '（' + a.reason + '）' : ''),
          }
        }

        const justWoke = (() => { try { return sleep.isJustWoke() } catch { return null } })()
        const fat = (() => { try { return sleep.fatigue.get() } catch { return null } })()
        let message
        if (s.state === 'sleeping') {
          message = '正在睡着（疲惫 ' + fat + '），不会回复。想醒用 mind_sleep(action=wake)。'
        } else if (s.state === 'preparing') {
          message = '正要睡着（宽限期内有互动会自动取消）。'
        } else if (s.state === 'recovering') {
          message = '睡了一觉，正在醒（疲惫 ' + fat + '）。'
        } else if (justWoke) {
          message = '刚睡醒' + (justWoke.sleptMin ? '（睡了约 ' + justWoke.sleptMin + ' 分钟）' : '') +
            '，还有点迷糊。疲惫 ' + fat + '。'
        } else {
          message = '清醒中（疲惫 ' + fat + '）。' +
            (fat != null && fat >= 70 ? '（已经很累了，考虑去睡）' : '')
        }
        return {
          ok: true, state: s.state, since: s.since, reason: s.reason,
          fatigue: fat, justWoke: justWoke || null, message,
        }
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
    })), 'dsh-mind: mind_sleep')
  }

  /* ═══ 提示词注入（默认关） ═══ */

  if (cfg.inject) {
    ctx.effect(() => {
      const sp = (() => {
        try { return ctx.get ? ctx.get('systemPrompt') : ctx.systemPrompt } catch { return null }
      })()
      if (!sp || typeof sp.section !== 'function') return
      sp.section({
        id: 'dsh-mind:recall',
        order: 880,
        render: () => {
          const q = queryHint
          if (!q) return ''
          let hits = []
          try { hits = store.search(q, { k: 3, minScore: 0.35 }) } catch { return '' }
          if (!hits.length) return ''
          const lines = hits.map((h) => '- ' + String(h.text).slice(0, 120))
          let out = '【相关记忆】\n' + lines.join('\n')
          if (out.length > cfg.injectBudgetChars) out = out.slice(0, cfg.injectBudgetChars) + '…'
          return out
        },
      })
    }, 'dsh-mind: recall section')
  }

  /* ═══ 管理面板 ═══ */

  registerPanel()

  function registerPanel() {
    const tryRegister = (web) => {
      if (!web || typeof web.register !== 'function') return false
      ctx.effect(() => web.register({
        kind: 'prefix',
        path: '/dsh-mind-api',
        async handler(req, res) {
          try {
            await handleApi(req, res)
          } catch (e) {
            try {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
            } catch {}
          }
        },
      }), 'dsh-mind: panel')
      log('管理面板已挂载: /dsh-mind-api/panel')
      return true
    }

    const tryGet = () => {
      try {
        if (ctx.get) return ctx.get('webServer') || ctx.get('web')
        return ctx.webServer || ctx.web
      } catch { return null }
    }

    const web = tryGet()
    if (tryRegister(web)) return

    // 服务未就绪 → 排队等 inject 回调
    const pending = []
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (w) => {
          if (tryRegister(w)) {
            while (pending.length) { try { pending.shift()() } catch {} }
          }
        })
      }
    } catch {}
  }

  /* ═══ HTTP 处理 ═══ */

  function readBody(req, cb) {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 65536) req.destroy() })
    req.on('end', () => { try { cb(JSON.parse(buf || '{}')) } catch { cb(null) } })
  }

  /** 读桥接配置：环境变量优先，其次做法同 qq-bridge 自身的 config.json */
  function readBridgeConfig() {
    // 面板设置优先，环境变量兜底
    const ext = externalCfg()
    if (ext.bridgeEnabled === false) return null

    const path = ext.bridgeConfigPath || process.env.QQ_BRIDGE_CONFIG || ''
    let port = Number(ext.bridgePort) || Number(process.env.QQ_BRIDGE_PORT) || 3100
    let token = ext.bridgeToken || process.env.QQ_BRIDGE_TOKEN || ''

    if (path && existsSync(path)) {
      try {
        const j = JSON.parse(readFileSync(path, 'utf8'))
        port = j.consolePort || port
        token = j.consoleToken || token
      } catch {}
    }
    return (port && token) ? { port, token } : null
  }

  async function handleApi(req, res) {
    const url = new URL(String(req.url || ''), 'http://localhost')
    const p = url.pathname.replace(/^\/dsh-mind-api/, '') || '/'

    const send = (obj, code = 200) => {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(obj))
    }

    // 写操作需要自定义头（防跨站）
    if (req.method === 'POST' && String(req.headers['x-dsh-mind'] || '') !== '1') {
      return send({ ok: false, error: '缺少 x-dsh-mind 头' }, 403)
    }

    /* ── 状态 ── */
    if (req.method === 'GET' && p === '/state') {
      const sleepState = sleep.get()
      return send({
        ok: true,
        sleep: sleepState,
        fatigue: sleepState.fatigue,
        schedule: sleep.schedule.get(),
        sleepVerdict: (() => {
          try { return { sleep: sleep.shouldSleep(), wake: sleep.shouldWake() } }
          catch { return null }
        })(),
        thresholds: sleep.thresholds,
        inject: { enabled: cfg.inject === true, budget: cfg.injectBudgetChars, k: cfg.recallK },
        stats: store.stats(),
        // 角色名（面板标题用）—— 自动探测，不写死
        role: roleName,
        // 全部可调参数（面板设置页用）
        settings: cfgStore.all(),
      })
    }

    /* ── 图数据 ── */
    if (req.method === 'GET' && p === '/graph') {
      const limit = Math.max(1, Math.min(400, Number(url.searchParams.get('limit')) || 300))
      return send(store.graphData({ scope: 'private', limit }))
    }

    if (req.method === 'GET' && p === '/recent') {
      return send({ ok: true, items: store.recent(50) })
    }

    if (req.method === 'GET' && p === '/audit') {
      return send({ ok: true, items: store.auditList(80) })
    }

    if (req.method === 'GET' && p === '/memory/get') {
      const id = String(url.searchParams.get('id') || '')
      const m = store.get(id)
      return m ? send({ ok: true, memory: m }) : send({ ok: false, error: '不存在' }, 404)
    }

    if (req.method === 'GET' && p === '/query') {
      const q = String(url.searchParams.get('q') || '').trim()
      if (!q) return send({ ok: true, hits: [] })
      return send({ ok: true, hits: store.search(q, { k: 20, minScore: 0.15 }) })
    }

    /* ── 记忆写操作 ── */
    if (req.method === 'POST' && p === '/memory/correct') {
      return readBody(req, (b) => {
        try {
          if (!b || !b.id) return send({ ok: false, error: '缺少 id' }, 400)
          const r = store.correct(b.id, { newText: b.text, reason: b.reason || '面板编辑', actor: 'user' })
          return send({ ok: true, ...r })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    if (req.method === 'POST' && p === '/memory/forget') {
      return readBody(req, (b) => {
        try {
          if (!b || !b.id) return send({ ok: false, error: '缺少 id' }, 400)
          const r = store.forget(b.id, { tier: b.tier || 1, reason: b.reason || '面板降权' })
          return send({ ok: true, ...r })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    if (req.method === 'POST' && p === '/memory/delete') {
      return readBody(req, (b) => {
        try {
          if (!b || !b.id) return send({ ok: false, error: '缺少 id' }, 400)
          const r = store.purge(b.id, { reason: b.reason || '用户手动删除' })
          log('物理删除记忆 ' + b.id)
          return send({ ok: true, ...r })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    /* ── 睡眠控制 ── */
    if (req.method === 'GET' && p === '/sleep/schedule') {
      try { return send({ ok: true, schedule: sleep.schedule.get(), fatigue: sleep.fatigue.get() }) }
      catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
    }

    if (req.method === 'POST' && p === '/sleep/schedule') {
      return readBody(req, (b) => {
        try {
          const patch = {}
          for (const k of ['auto', 'preferFixedTime']) if (b && typeof b[k] === 'boolean') patch[k] = b[k]
          for (const k of ['fatigueSleep', 'fatigueWake']) if (b && typeof b[k] === 'number') patch[k] = b[k]
          if (b && Array.isArray(b.windows)) patch.windows = b.windows
          const next = sleep.schedule.set(patch)
          return send({ ok: true, schedule: next, sleep: sleep.get() })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    if (req.method === 'POST' && p === '/sleep/fatigue') {
      return readBody(req, (b) => {
        try {
          if (!b || typeof b.value !== 'number') return send({ ok: false, error: 'value 必须是数字' }, 400)
          const v = sleep.fatigue.set(b.value)
          return send({ ok: true, fatigue: v, sleep: sleep.get() })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    if (req.method === 'POST' && p === '/sleep/enter') {
      return readBody(req, (b) => {
        try {
          let cur = sleep.get()
          // 若已在睡眠流程中，直接返回当前状态（幂等）
          if (cur.state !== 'awake') {
            return send({ ok: true, sleep: cur, note: '已在睡眠流程中' })
          }
          const r = sleep.enterPreparing({ reason: '手动入睡', manual: true })
          return send({ ok: true, sleep: r })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    if (req.method === 'POST' && p === '/sleep/wake') {
      return readBody(req, () => {
        try {
          const r = sleep.wake({ reason: '手动叫醒', manual: true })
          return send({ ok: true, sleep: r })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    if (req.method === 'GET' && p === '/sleep/history') {
      try { return send({ ok: true, items: sleep.history() }) }
      catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
    }

    if (req.method === 'POST' && p === '/sleep/clear-override') {
      return readBody(req, () => {
        try { sleep.clearOverride(); return send({ ok: true, sleep: sleep.get() }) }
        catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    if (req.method === 'POST' && p === '/sleep/heal') {
      return readBody(req, () => {
        try {
          sleep.selfHeal()
          sleep.fatigue.advance()
          return send({ ok: true, sleep: sleep.get() })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    /* ══════════ 设置 ══════════ */
    // 读：返回 schema + 当前值（面板据此渲染表单）
    if (req.method === 'GET' && p === '/settings') {
      return send({
        ok: true,
        schema: CONFIG_SCHEMA,
        values: cfgStore.all(),
        loadedFrom: cfgStore.loadedFrom(),
        file: cfgStore.file,
      })
    }

    // 写：批量更新，校验后落盘，返回生效后的值
    if (req.method === 'POST' && p === '/settings') {
      return readBody(req, (b) => {
        try {
          const patch = (b && b.values) || b || {}
          const r = cfgStore.update(patch)
          // 睡眠阈值、注入参数改了要立刻重建视图
          cfg = readCfg()
          sleep.thresholdsReload && sleep.thresholdsReload(sleepThresholds())
          try {
            setMemoryOptions({
              dedupeKinds: cfgStore.get('memory.dedupeKinds'),
              maxTextLen: cfgStore.get('memory.maxTextLen'),
              mergeSimilar: cfgStore.get('memory.mergeSimilar'),
            })
          } catch {}
          log('设置已更新：' + r.applied.length + ' 项')
          return send({ ok: true, ...r, schema: CONFIG_SCHEMA })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    // 恢复默认（可指定某一组）
    if (req.method === 'POST' && p === '/settings/reset') {
      return readBody(req, (b) => {
        try {
          const groupName = b && b.group
          const values = cfgStore.reset(groupName)
          cfg = readCfg()
          sleep.thresholdsReload && sleep.thresholdsReload(sleepThresholds())
          try {
            setMemoryOptions({
              dedupeKinds: cfgStore.get('memory.dedupeKinds'),
              maxTextLen: cfgStore.get('memory.maxTextLen'),
              mergeSimilar: cfgStore.get('memory.mergeSimilar'),
            })
          } catch {}
          return send({ ok: true, values, group: groupName || 'all' })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    // 星图参数（面板打开星图时拉一次）
    if (req.method === 'GET' && p === '/graph-settings') {
      return send({ ok: true, values: cfgStore.group('graph') })
    }

    /* ── 角色名 ── */
    if (req.method === 'POST' && p === '/role-name') {
      return readBody(req, (b) => {
        try {
          const n = String((b && b.name) || '').trim().slice(0, 40)
          if (!n) return send({ ok: false, error: '名字不能为空' }, 400)
          roleName = { name: n, source: 'manual' }
          nameResolver.invalidate()
          try { cfgStore.update({ 'panel.roleName': n }) } catch {}
          // 落盘到 state.json，重启后仍生效
          try {
            const sf = join(dataDir, 'state.json')
            const cur = existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : {}
            cur.roleName = n
            writeFileSync(sf, JSON.stringify(cur, null, 2))
          } catch {}
          log('角色名已设为 ' + n)
          return send({ ok: true, role: roleName })
        } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
      })
    }

    /* ── qq-bridge 状态代理 ── */
    if (req.method === 'GET' && p === '/bridge-status') {
      try {
        const bc = readBridgeConfig()
        if (!bc) return send({ ok: false, error: '未配置 QQ_BRIDGE_CONFIG' }, 503)
        const ac = new AbortController()
        const timer = setTimeout(() => { try { ac.abort() } catch {} }, 5000)
        timer.unref?.()
        const resp = await fetch('http://127.0.0.1:' + bc.port + '/api/status', {
          headers: { 'x-console-token': bc.token },
          signal: ac.signal,
        })
        clearTimeout(timer)
        if (!resp.ok) return send({ ok: false, error: 'bridge HTTP ' + resp.status }, 502)
        return send({ ok: true, ...(await resp.json()) })
      } catch (e) {
        return send({ ok: false, error: 'bridge 不可达：' + (e?.message ?? e) }, 502)
      }
    }

    /* ── qq-bridge 通用代理（角色卡 / 令牌消费）── */
    if (req.method === 'GET' && p.startsWith('/bridge/')) {
      const ALLOWED = [
        '/api/presets', '/api/roles', '/api/roles/content',
        '/api/preset/sim-prompt',
        '/api/tokens/summary', '/api/tokens/series',
        '/api/tokens/turns', '/api/tokens/recent',
      ]
      const target = p.slice('/bridge'.length)
      if (!ALLOWED.includes(target)) {
        return send({ ok: false, error: '不允许的代理路径：' + target }, 403)
      }
      try {
        const bc = readBridgeConfig()
        if (!bc) return send({ ok: false, error: '未配置 QQ_BRIDGE_CONFIG' }, 503)
        const ac = new AbortController()
        const timer = setTimeout(() => { try { ac.abort() } catch {} }, 6000)
        timer.unref?.()
        // 带上 query（/api/roles/content?name=… 靠它定位文件）
        const resp = await fetch('http://127.0.0.1:' + bc.port + target + (url.search || ''), {
          headers: { 'x-console-token': bc.token },
          signal: ac.signal,
        })
        clearTimeout(timer)
        const txt = await resp.text()
        res.writeHead(resp.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(txt)
        return
      } catch (e) {
        return send({ ok: false, error: 'bridge 不可达：' + (e?.message ?? e) }, 502)
      }
    }

    /* ── 面板页面 ── */
    if (req.method === 'GET' && p === '/panel') {
      try {
        const html = readFileSync(join(__dirname, 'panel', 'index.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      } catch (e) {
        return send({ ok: false, error: '面板文件缺失：' + (e?.message ?? e) }, 500)
      }
    }

    /* ── 星图引擎 ── */
    if (req.method === 'GET' && p === '/universe.js') {
      try {
        const src = readFileSync(join(__dirname, 'panel', 'universe.js'))
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(src)
        return
      } catch (e) {
        return send({ ok: false, error: '星图引擎缺失：' + (e?.message ?? e) }, 500)
      }
    }

    /* ── 静态资源（Three.js）── */
    if (req.method === 'GET' && (p === '/vendor' || p.startsWith('/vendor/'))) {
      try {
        const rel = decodeURIComponent(p.slice('/vendor'.length)) || '/'
        const root = join(__dirname, 'panel', 'vendor')
        const abs = resolve(root, '.' + rel)
        const rootResolved = resolve(root)
        // 路径穿越防护
        if (!abs.startsWith(rootResolved + sep) && abs !== rootResolved) {
          return send({ ok: false, error: '非法路径' }, 403)
        }
        if (!existsSync(abs)) return send({ ok: false, error: '资源不存在' }, 404)
        const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase()
        const MIME = {
          '.js': 'text/javascript; charset=utf-8',
          '.mjs': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
        }
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
        res.end(readFileSync(abs))
        return
      } catch (e) {
        return send({ ok: false, error: e?.message ?? String(e) }, 500)
      }
    }

    return send({ ok: false, error: 'not found' }, 404)
  }
}
