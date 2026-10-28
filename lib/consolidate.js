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

  /** 本地步骤实现。返回 {ok, note} */
  function runLocalStep(step) {
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

  /** LLM 步：通过 sessionController.prompt 投递整理指令（模型用 mind_memory 工具落库） */
  function queueLlmStep(step, sessionCtl) {
    if (!sessionCtl || typeof sessionCtl.prompt !== 'function') {
      return { ok: false, note: 'sessionController 不可用——LLM 步延后（不阻塞）' }
    }
    const prompts = {
      3: '【睡眠整理·内部任务】请回顾最近的对话与笔记，把值得长期记住的**事件**用 mind_memory 工具写入（kind=episode，只写以后用得上的，每条一句话）。写完即收尾，不要给任何人发消息。',
      6: '【睡眠整理·内部任务】请从最近的记忆里挑出 1~2 条可以作为**长期有效**的（kind=fact 或 lesson）用 mind_memory 写入；已在库里的不要重复。写完即收尾。',
      9: '【睡眠整理·内部任务】请根据近期互动，用 mind_memory 写入 1 条你观察到的**用户偏好或习惯**（kind=fact，is_inference=1）；不确定的不要写。写完即收尾。',
    }
    const content = prompts[step.id]
    if (!content) return { ok: true, note: '（无 LLM 指令）' }
    try {
      sessionCtl.prompt({ mode: 'queue', content })
      return { ok: true, note: `已投递整理指令（步骤 ${step.id}），由模型用工具完成` }
    } catch (e) {
      return { ok: false, note: `投递失败：${e?.message ?? e}` }
    }
  }

  /** 心跳调用：每次推进一步（LLM 步投递后即视为完成该步，等模型自己写库） */
  function tick(sessionCtl) {
    if (running) return { busy: true }
    const s = sleep.get()
    if (s.state !== 'sleeping') return { idle: true }
    running = true
    try {
      const task = loadProgress()
      const step = STEPS.find((x) => x.id === task.step + 1)
      if (!step) {
        // 全部完成
        sleep.wake?.({ reason: '整理完成' })
        running = false
        return { done: true }
      }
      let res
      try {
        res = step.llm ? queueLlmStep(step, sessionCtl) : runLocalStep(step)
      } catch (e) {
        res = { ok: false, note: e?.message ?? String(e) }
      }
      const fails = (task.fails || 0) + (res.ok ? 0 : 1)
      if (res.ok || fails >= 3) {
        saveProgress(step.id, res.note || '')
        log(`[dsh-mind] 整理步骤 ${step.id}/${STEPS.length}（${step.name}）：${res.note || 'ok'}`)
      } else {
        log(`[dsh-mind] 整理步骤 ${step.id} 失败（${fails}/3）：${res.note || ''}——下拍重试`)
      }
      return { step: step.id, ...res }
    } finally { running = false }
  }

  return { tick, STEPS }
}
