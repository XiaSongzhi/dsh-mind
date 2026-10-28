// dsh-mind —— 统一记忆/情绪/睡眠插件（融合版）
//
// 融合架构：vendor 进来的 dsh-mood 0.14.16 源码（vendor/mood/）通过【过滤代理 ctx】
// 运行其 apply()——心情引擎/日记/经验卡/品味/会话索引的成熟接线原样生效；
// 代理层做三件事：
//   ① 排除：news 工具与 news 提示词节（PRD 排除项）；proactive 以 moodCfg 强制 enabled:false
//   ② 重定向：mood 的 memory 工具（jsonl 归档检索）→ SQLite 统一记忆库（同名工具，行为升级）
//   ③ 记账：mood 各提示词节的字符数进预算账本，dsh-mind 自己的注入块用剩余预算
// dsh-mind 自有新增：SQLite 统一记忆核心、mind_memory/mind_sleep 工具、睡眠状态机、
//   独立管理面板（/dsh-mind-api/panel，不进 DSH 设置模块）。
//
// 会话连续性（PRD 硬要求）：插件更换不改变 sessionPolicy（模式+预设+owner），
//   DSH 会话与桥接 state 均不受影响——夏凛的上下文不重开、不重建。
//
// 灰度纪律：inject 默认 false（"先只写不读"）。启用 = cordis.patch.yml 的 dsh-mind 行
//   加 config: { inject: true }，且应在 dsh-mood 停用/移除之后。
//
// 宿主 API（对齐 dsh-mood 实测）：
//   export const name / export function apply(root, rawConfig)
//   ctx.get('tools').register(def) / ctx.systemPrompt.section({name,order,text}) / ctx.effect(fn, label)
//   ctx.get('web').register({kind:'prefix', path, handler}) / ctx.on('session/event', …)

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from './lib/db.js'
import { createMemoryStore } from './lib/memory.js'
import { buildInjectBlock, RETRY_HINT } from './lib/retrieve.js'
import { createSleepManager } from './lib/sleep.js'
import { createConsolidator } from './lib/consolidate.js'
import { dataDir as resolveDataDir, importMoodArchive, moodDataDir } from './lib/pointer.js'
import { apply as moodApply } from './vendor/mood/index.js'

export const name = 'dsh-mind'

const CFG_DEFAULTS = {
  inject: false,               // 灰度开关：false=只写不读
  injectBudgetChars: 3500,     // 总预算（=mood 现状基础上调 500，用户指定）
  recallK: 2,                  // 每轮注入记忆条数
  recallMinScore: 0.45,
  memoryMaxChars: 80,          // 注入时单条截断
  noteMaxChars: 400,
  importMoodArchive: true,
  dataDir: '',
  blocks: {},                  // {memory,mood,procedures,profile} 逐块开关
}

// mood 侧被排除的工具（PRD：时事不开发；主动开口由桥接负责）
const MOOD_TOOL_DENY = new Set(['news'])
// mood 侧被排除的提示词节
const MOOD_SECTION_DENY = new Set(['dsh-mood/news'])

export function apply(ctx, rawConfig) {
  const cfg = { ...CFG_DEFAULTS, ...(rawConfig || {}) }
  const log = (...a) => { try { console.log('[dsh-mind]', ...a) } catch { /* 不管 */ } }

  // ═══ 1. dsh-mind 自有核心（SQLite 统一记忆 + 睡眠） ═══
  const dataDir = resolveDataDir(cfg)
  mkdirSync(dataDir, { recursive: true })
  const db = openDb(join(dataDir, 'memory.db'))
  const store = createMemoryStore(db, { log })

  // mood 归档一次性导入（拷贝式；源文件零改动；幂等）
  if (cfg.importMoodArchive) {
    try {
      const r = importMoodArchive(store, { db, dataDir })
      if (r.imported || r.reason !== 'already-imported') log(`mood 归档导入：${JSON.stringify(r)}`)
    } catch (e) { log('mood 归档导入失败（不影响启动）：', e?.message ?? e) }
  }

  const sleep = createSleepManager({ stateFile: join(dataDir, 'state.json'), log })

  // ═══ 2. 过滤代理 ctx：在它的看护下运行 vendored mood 的 apply() ═══
  const budgetLedger = []   // mood 各提示词节最近一次渲染的字符数（预算账本）
  const realTools = () => {
    const t = ctx.get ? ctx.get('tools') : ctx.tools
    if (!t || typeof t.register !== 'function') throw new Error('宿主 tools 注册器不可用')
    return t
  }

  // SQLite 版 memory 工具（同名替换 mood 的 jsonl 归档版——行为升级、名字不变）
  function memoryToolDef() {
    return {
      name: 'memory',
      description:
        '查询或写入你的长期记忆库（已升级为结构化存储，跨会话、上下文压缩后依然可查）。' +
        'action=search 按关键词检索（' + RETRY_HINT + '）；action=note 写入一条结构化记忆' +
        '（kind：episode 事件/fact 事实/reflection 反思/skill 技能/lesson 道理；只写以后用得上的，一条一句话）；' +
        'action=recent 最近写入；action=stats 记忆库概况。',
      parameters: {
        action: { type: 'string', enum: ['search', 'note', 'recent', 'stats'] },
        query: { type: 'string', description: 'search 的关键词' },
        text: { type: 'string', description: 'note 的记忆正文' },
        kind: { type: 'string', description: 'note 的记忆类型' },
        importance: { type: 'number', description: '0~1 重要程度' },
      },
      execute(a = {}) {
        switch (a.action) {
          case 'search': {
            const hits = store.search(a.query || '', { k: 5, minScore: 0.25 })
            return { ok: true, hits, hint: hits.length ? '' : RETRY_HINT }
          }
          case 'note': {
            const r = store.note({ kind: a.kind, text: a.text, importance: a.importance ?? 0.5, source: 'agent-note', is_inference: true })
            return { ok: true, id: r.id, duplicateOf: r.duplicateOf ?? null }
          }
          case 'recent':
            return { ok: true, items: store.recent(10) }
          case 'stats':
            return { ok: true, ...store.stats() }
          default:
            return { ok: false, error: '未知 action' }
        }
      },
    }
  }

  const moodCtx = Object.create(ctx)
  moodCtx.get = (key) => {
    if (key === 'tools') {
      return {
        register(def) {
          if (!def || !def.name) return
          if (MOOD_TOOL_DENY.has(def.name)) { log(`[fusion] 排除 mood 工具：${def.name}`); return }
          if (def.name === 'memory') {
            log('[fusion] mood memory 工具 → 重指向 SQLite 统一记忆库')
            return realTools().register(memoryToolDef())
          }
          return realTools().register(def)
        },
      }
    }
    return ctx.get ? ctx.get(key) : undefined
  }
  moodCtx.systemPrompt = {
    section(s) {
      if (s && MOOD_SECTION_DENY.has(s.name)) { log(`[fusion] 排除 mood 提示词节：${s.name}`); return }
      if (s && typeof s.text === 'function') {
        const orig = s.text
        s = { ...s, text: () => {
          const out = orig()
          try {
            budgetLedger.push({ name: s.name, chars: (out || '').length })
            if (budgetLedger.length > 24) budgetLedger.splice(0, budgetLedger.length - 24)
          } catch {}
          return out
        } }
      }
      return ctx.systemPrompt.section(s)
    },
  }

  // ═══ 3. 运行 mood 引擎（代理下） ═══
  try {
    moodApply(moodCtx, { proactive: { enabled: false }, ...((rawConfig || {}).mood || {}) })
    log('[fusion] mood 引擎已在代理下装配（情绪/日记/经验卡/品味/会话索引）')
  } catch (e) {
    log('‼️ mood 引擎装配失败——dsh-mind 自有核心继续运行，但情绪系统不可用：', e?.stack || e?.message || e)
  }

  // ═══ 4. 心情桥接行 + 自有工具 ═══
  function moodLine() {
    try {
      const f = join(moodDataDir(), 'dsh-mood.json')
      if (!existsSync(f)) return ''
      const s = JSON.parse(readFileSync(f, 'utf8'))
      const cur = typeof s.current === 'string' ? s.current : (s.current?.id ?? '')
      return cur ? `现在是「${cur}」。情绪只影响语气，不影响判断。` : ''
    } catch { return '' }
  }

  const tools = ctx.get ? ctx.get('tools') : ctx.tools
  if (tools && typeof tools.register === 'function') {
    const mindMemoryDef = {
      name: 'mind_memory',
      description:
        '你的长期记忆库高级接口（SQLite 结构化存储，跨会话、上下文压缩后依然可查）。' +
        'action=search 按关键词检索（' + RETRY_HINT + '）；' +
        'action=note 写入一条结构化记忆（kind：episode 事件/fact 事实/reflection 反思/skill 技能/lesson 道理；' +
        '只写以后用得上的，一条一句话，≤120 字；is_inference=1 表示推断）；' +
        'action=get 看全文与来源；action=correct 用户纠正时用（旧记忆自动降权并记一条"用户纠正过我"）；' +
        'action=forget 三级遗忘；action=recent 最近写入。',
      parameters: {
        action: { type: 'string', enum: ['search', 'note', 'get', 'correct', 'forget', 'recent'] },
        query: { type: 'string' }, text: { type: 'string' }, kind: { type: 'string' },
        id: { type: 'string' }, importance: { type: 'number' },
        entities: { type: 'array' }, is_inference: { type: 'boolean' },
        reason: { type: 'string' }, tier: { type: 'number' },
      },
      execute(a = {}) {
        switch (a.action) {
          case 'note': {
            const r = store.note({
              kind: a.kind, text: a.text, importance: a.importance ?? 0.5,
              entities: a.entities, source: 'agent-note', is_inference: a.is_inference !== false,
            })
            return { ok: true, id: r.id, duplicateOf: r.duplicateOf ?? null }
          }
          case 'search': {
            const hits = store.search(a.query || '', { k: 5, minScore: 0.25 })
            return { ok: true, hits, hint: hits.length ? '' : RETRY_HINT }
          }
          case 'get': {
            const m = store.get(a.id)
            return m ? { ok: true, memory: m } : { ok: false, error: '不存在' }
          }
          case 'correct':
            return { ok: true, ...store.correct(a.id, { newText: a.text, reason: a.reason, actor: 'agent' }) }
          case 'forget':
            return { ok: true, ...store.forget(a.id, { tier: a.tier || 1, reason: a.reason }) }
          case 'recent':
            return { ok: true, items: store.recent(10) }
          default:
            return { ok: false, error: '未知 action' }
        }
      },
    }
    ctx.effect(() => tools.register(mindMemoryDef), 'dsh-mind memory tool')

    const sleepDef = {
      name: 'mind_sleep',
      description: '查看你的睡眠状态（睡眠期间系统在整理你的记忆）。仅供感知与收尾参考。',
      parameters: {},
      execute() {
        const s = sleep.get()
        return {
          ok: true, state: s.state, since: s.since, reason: s.reason,
          checkpoint: s.checkpoint, lastReport: s.lastReport,
          hint: s.state === 'sleeping' ? '你在睡眠整理期：本轮不是陪聊，不要给对方发消息。' : '',
        }
      },
    }
    ctx.effect(() => tools.register(sleepDef), 'dsh-mind sleep tool')
  }

  // ═══ 5. 提示词注入（灰度默认关；开启后受 3500 总预算约束）═══
  //    mood 各节（885/890 等 order）先渲染并进账本；我们的节 order=881 恰在它们之前
  //    ——所以预算按"上一轮账本"扣减（一轮延迟，实践上足够稳）。
  if (cfg.inject === true && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'dsh-mind/inject',
      order: 881,
      interpolate: false,
      text: () => {
        try {
          const used = budgetLedger.reduce((s, x) => s + (x.chars || 0), 0)
          const remaining = Math.max(200, cfg.injectBudgetChars - used)
          const hits = store.search(lastQueryHint || '', { k: cfg.recallK, minScore: cfg.recallMinScore })
          return buildInjectBlock(
            { memoryHits: hits, moodLine: moodLine() },
            { injectBudgetChars: remaining, recallK: cfg.recallK, memoryMaxChars: cfg.memoryMaxChars, blocks: cfg.blocks },
          ).text
        } catch (e) { log('注入块生成失败（降级为空）：', e?.message ?? e); return '' }
      },
    }), 'dsh-mind inject section')
  }

  // 最近一条用户消息缓存：阶段五由会话事件写入，注入协调器用于检索
  let lastQueryHint = ''
  function setQueryHint(q) { lastQueryHint = String(q || '').slice(0, 200) }

  // ═══ 6. 独立管理面（/dsh-mind-api，不进 DSH 设置模块）═══
  const web = ctx.get ? ctx.get('web') : ctx.web
  if (web && typeof web.register === 'function') {
    ctx.effect(() => web.register({
      kind: 'prefix',
      path: '/dsh-mind-api',
      handler(req, res) {
        try {
          const url = new URL(String(req.url || ''), 'http://localhost')
          const p = url.pathname.replace(/^\/dsh-mind-api/, '') || '/'
          const send = (obj, code = 200) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          }
          if (req.method === 'POST' && String(req.headers['x-dsh-mind'] || '') !== '1') {
            return send({ ok: false, error: '缺少 x-dsh-mind 头（跨站写保护）' }, 403)
          }
          if (req.method === 'GET' && p === '/state') {
            return send({
              ok: true, sleep: sleep.get(),
              inject: { enabled: cfg.inject === true, budget: cfg.injectBudgetChars, k: cfg.recallK },
              stats: store.stats(), mood: moodLine(), budgetLedger,
            })
          }
          if (req.method === 'GET' && p === '/graph') {
            return send({ ok: true, ...store.graphData({ scope: url.searchParams.get('scope') || 'private', limit: Number(url.searchParams.get('limit')) || 200 }) })
          }
          if (req.method === 'GET' && p === '/recent') return send({ ok: true, items: store.recent(50) })
          if (req.method === 'GET' && p === '/audit') return send({ ok: true, items: store.auditList(80) })
          if (req.method === 'GET' && p === '/query') {
            const q = url.searchParams.get('q') || ''
            return send({ ok: true, q, hits: q ? store.search(q, { k: 8, minScore: 0.15 }) : [] })
          }
          if (req.method === 'POST' && p === '/memory/correct') {
            return readBody(req, (b) => send({ ok: true, ...store.correct(b.id, { newText: b.text, reason: b.reason, actor: 'panel' }) }))
          }
          if (req.method === 'POST' && p === '/memory/forget') {
            return readBody(req, (b) => send({ ok: true, ...store.forget(b.id, { tier: b.tier || 1, reason: b.reason, actor: 'panel' }) }))
          }
          if (req.method === 'POST' && p === '/sleep/enter') {
            return send({ ok: true, ...sleep.enterPreparing({ reason: '管理面板手动' }) })
          }
          if (req.method === 'POST' && p === '/sleep/wake') {
            if (sleep.get().state === 'sleeping' && !sleep.canForceWake(true)) return send({ ok: false, error: '严格锁生效中' }, 403)
            return send({ ok: true, ...sleep.wake({ reason: '管理面板手动' }) })
          }
          if (req.method === 'GET' && p === '/panel') {
            try {
              const html = readFileSync(join(__dirname, 'panel', 'index.html'))
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              res.end(html)
            } catch { send({ ok: false, error: '面板文件缺失' }, 500) }
            return
          }
          send({ ok: false, error: '未知路径' }, 404)
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) })) } catch {}
        }
      },
    }), 'dsh-mind http')
  }

  function readBody(req, cb) {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 65536) req.destroy() })
    req.on('end', () => { try { cb(JSON.parse(buf || '{}')) } catch { cb(null) } })
  }

  log(`就绪（融合模式）：dataDir=${dataDir} inject=${cfg.inject === true ? 'on' : 'off(灰度)'}`)
  return { cfg, store, sleep, setQueryHint, db }
}

const PANEL_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-mind 记忆面板</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0d0f1c;color:#e6e8f5;max-width:960px;margin:30px auto;padding:0 16px}
h1{font-size:20px}.card{background:#151829;border:1px solid #262b4a;border-radius:12px;padding:16px;margin:14px 0}
.k{color:#8f94b5;font-size:12px}.num{font-size:26px;font-weight:650}code{color:#a3abee}
button{background:#5457d6;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;margin-right:6px}
input{background:#1a1e33;border:1px solid #31365e;border-radius:8px;color:#e6e8f5;padding:8px;width:60%}
.m{color:#aeb2cf;font-size:13px;line-height:1.7}</style></head><body>
<h1>dsh-mind 记忆面板（独立页 · 不属于 DSH 设置）</h1>
<div class="card"><span class="k">状态</span><div id="state">加载中…</div></div>
<div class="card"><span class="k">检索调试（可解释打分）</span><br>
<input id="q" placeholder="关键词，如：面试"><button onclick="doQuery()">搜索</button>
<div class="m" id="hits"></div></div>
<script>
async function jf(u,o){const r=await fetch(u,Object.assign({headers:{'x-dsh-mind':'1'}},o||{}));return r.json()}
async function load(){const r=await jf('/dsh-mind-api/state');
document.getElementById('state').innerHTML=
 '睡眠：<b>'+r.sleep.state+'</b> ｜ 记忆：<b>'+r.stats.total+'</b> 条（归档 '+r.stats.archived+'）｜ 实体 '+r.stats.entities+
 ' ｜ 未处理冲突 '+r.stats.conflictsOpen+'<br>注入：'+(r.inject.enabled?'<b style="color:#4fd1a5">开</b>':'<b style="color:#e9bd6c">关（灰度只写）</b>')+
 '，总预算 '+r.inject.budget+' 字 ｜ '+ (r.mood||'') }
async function doQuery(){const q=document.getElementById('q').value;
const r=await jf('/dsh-mind-api/query?q='+encodeURIComponent(q));
document.getElementById('hits').innerHTML=(r.hits||[]).map(h=>'<div>['+h.kind+'] '+h.text+' <span class="k">score '+h.score+'</span></div>').join('')||'（无命中——可换同义词再试）'}
load()
</script></body></html>`
