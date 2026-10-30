// dsh-mind / consolidate.js —— 海马体式睡眠整理（PRD 9.3 的 13 步，可恢复/幂等）
//
// 运行约定：
//   · 在 Sleeping 状态期间由心跳调用 tick()，每次最多执行一个"LLM 步"（把整理指令
//     通过 sessionController.prompt({mode:'queue'}) 投递给模型——和 mood 日记同一条
//     官方通道。模型的文本输出不会发 QQ（reserved2），它用 mind_memory 工具完成写入）。
//   · 本地步骤（统计/衰减/归档/冲突/体检/报表）不依赖 LLM，直接执行。
//   · 每步 checkpoint 写入睡眠状态，断点续跑；失败重试 ≤3 次后 pause，不阻塞苏醒。
//   · 原始对话与原始记忆永不因摘要被覆盖——摘要只新增行并回指来源。

import { ftsRebuild } from './db.js'
import { toIndexText } from './bigram.js'

const STEPS = [
  { id: 1,  name: 'snapshot',        llm: false },
  { id: 2,  name: 'digest',          llm: false },   // 汇总近期对话与事件（本地统计）
  { id: 3,  name: 'extract-episode', llm: true  },   // LLM：候选情景记忆（经 sessionCtl 投递）
  { id: 4,  name: 'dedupe-conflict', llm: false },
  { id: 5,  name: 'merge',           llm: false },
  { id: 6,  name: 'longlist-candidates', llm: true }, // LLM：短期→长期候选
  { id: 7,  name: 'relations',       llm: false },
  { id: 8,  name: 'diary',           llm: false },   // 日记由 mood 引擎 23:59 生成，这里只索引
  { id: 9,  name: 'preferences',     llm: true  },   // LLM：偏好/经验卡提议
  { id: 10, name: 'reindex',         llm: false },
  { id: 11, name: 'forget-mark',     llm: false },
  { id: 12, name: 'report',          llm: false },
  { id: 13, name: 'commit',          llm: false },
]

export function createConsolidator({ db, store, sleep, getSessionCtl, log = () => {} } = {}) {
  let running = false

  function loadProgress() {
    const s = sleep.get()
    return s.task && s.task.step ? s.task : { step: 0, batchId: 'b' + Date.now().toString(36) }
  }
  function saveProgress(step, note = '') {
    sleep.setCheckpoint?.(step, note)
  }

  /** 本地步骤实现。返回 {ok, note} */  function runLocalStep(step) {
    switch (step.name) {
      case 'snapshot': {
        const st = store.stats()
        return { ok: true, note: `快照：active=${st.total} archived=${st.archived} entities=${st.entities}` }
      }
      case 'digest': {
        const recent = store.recent(30)
        return { ok: true, note: `近 30 条已就绪（供 LLM 步引用）` }
      }
      case 'dedupe-conflict': {
        const st = store.stats()
        return { ok: true, note: `未处理冲突 ${st.conflictsOpen} 条（面板可人工裁决）` }
      }
      case 'merge': {
        return { ok: true, note: '合并由写入管线实时完成（相似≥0.75），睡眠期复核跳过' }
      }
      case 'relations': {
        return { ok: true, note: '关系由写入时实体抽取维护' }
      }
      case 'diary': {
        return { ok: true, note: '日记索引由 mood 引擎 23:59 生成，此处仅确认' }
      }
      case 'reindex': {
        const r = ftsRebuild(db, toIndexText)
        return { ok: r.ok, note: r.ok ? `FTS 已重建 ${r.rebuilt} 条` : `FTS 不可用（降级模式）` }
      }
      case 'forget-mark': {
        // 14 天未访问且 importance<0.3 → tier2 归档；confirmed=1 永不自动归档
        const cutoff = Date.now() - 14 * 86400000
        const rows = db.prepare("SELECT id, text, importance, confirmed FROM memories WHERE status='active' AND last_access < ? AND created_at < ? AND importance < 0.3 AND confirmed = 0").all(cutoff, cutoff)
        let n = 0
        for (const r of rows) { try { store.forget(r.id, { tier: 2, reason: '睡眠整理：低重要性且 14 天未访问' }); n++ } catch {} }
        return { ok: true, note: `归档 ${n} 条低价值记忆` }
      }
      case 'report': {
        const st = store.stats()
        const report = { at: Date.now(), stats: st, note: `睡眠整理报告：active=${st.total}，冲突 ${st.conflictsOpen}` }
        sleep.setReport?.(report)
        return { ok: true, note: report.note }
      }
      case 'commit': {
        // 一致性校验：FTS 行数与主库 active 数比对，不一致重建
        const st = store.stats()
        if (db._ftsAvailable) {
          const ftsN = db.prepare('SELECT COUNT(*) n FROM memories_fts').get().n
          if (ftsN !== st.total) ftsRebuild(db, toIndexText)
        }
        return { ok: true, note: '一致性校验完成，整理提交' }
      }
      default:
        return { ok: true, note: '（步骤占位）' }
    }
  }

  /**
   * LLM 步：通过 sessionController.prompt 投递整理指令（模型用 mind_memory 工具落库）
   *
   * ⚠️⚠️ 宿主契约（踩过致命坑）：
   *   `prompt(request, signal)` 的 **signal 是必传的**，源码第一行就是
   *   `signal.throwIfAborted()`（session-controller/lib/index.js:3212）。
   *   少传 signal → `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`
   *   → 直接把整个 DSH 打成 fatal load failure（2026-10-29 线上崩过一次）。
   *   而且：
   *     · content 必须是 `[{type:'text',text:'…'}]` **数组**，不是字符串
   *       （hasPromptContent 校验会拒字符串）
   *     · 必须带 requestId + sessionId（内容是投给某个具体会话的）
   *   所以这里做三件事：① 有 sessionId 才投递 ② content 用数组 ③ 永远传 signal。
   *   任何一项不满足就安静跳过（返回 ok:false 触发重试计数），绝不抛给宿主。
   */
  function queueLlmStep(step, sessionCtl) {
    if (!sessionCtl || typeof sessionCtl.prompt !== 'function') {
      return { ok: false, note: 'sessionController 不可用——LLM 步延后（不阻塞）' }
    }
    const prompts = {
      3: '【睡眠整理·内部任务】请回顾最近的对话与笔记，把值得长期记住的**事件**用 mind_memory 工具写入（kind=episode，只写以后用得上的，每条一句话）。写完即收尾，不要给任何人发消息。',
      6: '【睡眠整理·内部任务】请从最近的记忆里挑出 1~2 条可以作为**长期有效**的（kind=fact 或 lesson）用 mind_memory 写入；已在库里的不要重复。写完即收尾。',
      9: '【睡眠整理·内部任务】请根据近期互动，用 mind_memory 写入 1 条你观察到的**用户偏好或习惯**（kind=fact，is_inference=1）；不确定的不要写。写完即收尾。',
    }
    const text = prompts[step.id]
    if (!text) return { ok: true, note: '（无 LLM 指令）' }

    // 目标会话解析：
    //   ⚠️ controller 的形状实测（session-controller/lib/index.js:3054 起）：
    //     · controller 自身**没有** sessionId 字段
    //     · list(_request, signal) 是 **async**，返回 { items: [{ sessionId, ... }] }
    //   （早期把 list() 当同步数组用，拿到的是 Promise，sessionId 永远 null。）
    //   解析是异步的，所以整个 LLM 步改成 async，由 tick 负责 await。
    return resolveSessionId(sessionCtl).then((sessionId) => {
      if (!sessionId) return { ok: false, note: '没有可用会话——LLM 步延后（不阻塞）' }
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => { try { ctl.abort() } catch {} }, 15000)
        timer.unref?.()
        const p = sessionCtl.prompt({
          requestId: 'dsh-mind-consolidate-' + step.id + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, ctl.signal)
        if (p && typeof p.catch === 'function') {
          p.catch((e) => log(`[dsh-mind] 整理指令投递异步失败（步骤 ${step.id}）：${e?.message ?? e}`))
        }
        return { ok: true, note: `已投递整理指令（步骤 ${step.id}），由模型用工具完成` }
      } catch (e) {
        return { ok: false, note: `投递失败：${e?.message ?? e}` }
      }
    }).catch((e) => ({ ok: false, note: `投递失败：${e?.message ?? e}` }))
  }

  /** 解析一个可投递的 sessionId；拿不到就返回 null（绝不投错会话） */
  async function resolveSessionId(sessionCtl) {
    try {
      if (sessionCtl.sessionId) return sessionCtl.sessionId
      if (typeof sessionCtl.list === 'function') {
        const r = await sessionCtl.list()
        const arr = Array.isArray(r) ? r : (r?.items ?? [])
        if (arr.length) {
          const picked = arr.slice().sort((a, b) =>
            (b.lastActiveAt ?? b.updatedAt ?? 0) - (a.lastActiveAt ?? a.updatedAt ?? 0))[0]
          const sid = picked?.sessionId ?? picked?.id ?? null
          if (sid) return sid
        }
      }
    } catch (e) { log('[dsh-mind] 解析会话失败：', e?.message ?? e) }
    return null
  }

  // ═══════════ 会话来源隔离 ═══════════
  //
  // 为什么需要隔离：
  //   整理器要选一个会话投递 LLM 步。如果它挑到"最近活跃"的任意会话，
  //   在多工作区场景下可能把 A 项目的上下文写进 B 项目的记忆库。
  //
  // 配置方式（环境变量 MEMORY_SESSION_CWD_FILTER）：
  //   逗号分隔的路径片段（不区分大小写、用 / 分隔）。
  //   只有 cwd 同时包含**所有**片段才会被选中。
  //   例：MEMORY_SESSION_CWD_FILTER="companion,agents"
  //   不设置时：接受任意非空 cwd（单工作区部署的常见情况）。

  /**
   * cwd 白名单：逗号分隔的路径片段（环境变量 MEMORY_SESSION_CWD_FILTER）。
   * 只有 cwd 同时包含**所有**片段才会被选中。
   * 例：MEMORY_SESSION_CWD_FILTER="bridge,agents"
   * 不配置时接受任意非空 cwd（单工作区部署的常见情况）。
   */
  function cwdMarkers() {
    let raw = ''
    try {
      raw = (typeof process !== 'undefined' && process.env
        ? process.env.MEMORY_SESSION_CWD_FILTER
        : '') || ''
    } catch { raw = '' }
    return raw.split(',')
      .map(function (x) { return x.trim().toLowerCase().replace(/\\/g, '/') })
      .filter(Boolean)
  }

  function isCompanionCwd(cwd) {
    const c = String(cwd || '')
    if (!c) return false
    const norm = c.replace(/\\/g, '/').toLowerCase()
    const markers = cwdMarkers()
    if (!markers.length) return true
    return markers.every(function (m) { return norm.includes(m) })
  }

  /** 解析一个可投递的 sessionId；拿不到就返回 null（绝不投错会话） */
  async function resolveSessionId(sessionCtl) {
    try {
      if (typeof sessionCtl.list === 'function') {
        const r = await sessionCtl.list()
        const arr = Array.isArray(r) ? r : (r && r.items) || []
        if (!arr.length) return null
        // 只保留陪伴会话
        const candidates = arr.filter(function(it){ return isCompanionCwd(it && it.cwd) })
        if (!candidates.length) {
          log('[dsh-mind] 整理器：没有陪伴会话可用（跳过，避免投到开发会话）')
          return null
        }
        candidates.sort(function(a, b){
          const ta = (a.lastActiveAt != null ? a.lastActiveAt : (a.updatedAt != null ? a.updatedAt : 0))
          const tb = (b.lastActiveAt != null ? b.lastActiveAt : (b.updatedAt != null ? b.updatedAt : 0))
          return tb - ta
        })
        const sid = candidates[0].sessionId != null ? candidates[0].sessionId : candidates[0].id
        return sid || null
      }
      // 没有 list：退回直接持有的 sessionId（同样要验 cwd 拿不到就不投）
      if (sessionCtl.sessionId) return null
    } catch (e) { log('[dsh-mind] 解析会话失败：', e && e.message ? e.message : e) }
    return null
  }

  /**
   * 心跳调用：每次推进一步（LLM 步投递后即视为完成该步，等模型自己写库）
   * ⚠️ 现在是 async：LLM 步要 await sessionCtl.list()（宿主那边是异步的）。
   *    调用方（index.js 睡眠驱动）必须 await，否则会拿到 Promise 而不是结果。
   */
  async function tick(sessionCtl) {
    if (running) return { busy: true }
    const s = sleep.get()
    if (s.state !== 'sleeping') return { idle: true }
    running = true
    try {
      const task = loadProgress()
      const step = STEPS.find((x) => x.id === task.step + 1)
      if (!step) {
        // ⚠️ 修复（2026-10-31）：整理完成**不再**迁移到 recovering。
        //
        // 原来这里调 enterRecovering({reason:'整理完成'})，导致真实 bug：
        // 13 步约 7 分钟跑完，睡眠只持续 7 分钟就被拽去"将醒"，
        // 疲惫值才降 2 点（70→68）。用户看到的就是"刚睡下就醒"。
        //
        // 整理只是夜间睡眠期间顺便做的事，完成与否不该决定睡多久。
        // 状态迁移一律由 sleep.shouldWake() 说了算。
        return { done: true, note: '整理完成（不影响睡眠时长）' }
      }
      let res
      try {
        res = step.llm ? await queueLlmStep(step, sessionCtl) : runLocalStep(step)
      } catch (e) {
        res = { ok: false, note: e?.message ?? String(e) }
      }
      const fails = (task.fails || 0) + (res.ok ? 0 : 1)
      if (res.ok) {
        saveProgress(step.id, res.note || '')
        log(`[dsh-mind] 整理步骤 ${step.id}/${STEPS.length}（${step.name}）：${res.note || 'ok'}`)
      } else if (fails >= 3) {
        // 失败 3 次 → 跳过该步（推进游标），不阻塞苏醒
        saveProgress(step.id, `跳过（失败 ${fails} 次）：${res.note || ''}`)
        log(`[dsh-mind] 整理步骤 ${step.id}（${step.name}）连续失败 ${fails} 次，跳过继续`)
      } else {
        // ⚠️ 失败计数必须落到 state.json，否则每拍都从 0 重算（第二个死锁）
        try { sleep.bumpTaskFail?.(step.id) } catch {}
        log(`[dsh-mind] 整理步骤 ${step.id} 失败（${fails}/3）：${res.note || ''}——下拍重试`)
      }
      return { step: step.id, ...res }
    } finally { running = false }
  }

  return { tick, STEPS }
}
