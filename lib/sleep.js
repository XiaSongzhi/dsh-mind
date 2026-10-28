// dsh-mind / sleep.js —— 睡眠状态机（四态、持久化、重启恢复）
//
// 状态：awake → preparing → sleeping → recovering → awake
// 持久化：$DSH_HOME/dsh-mind/state.json —— 进程重启后锁仍在（PRD 9.2）。
// 整理任务（13 步）在阶段五实现；本模块先提供状态机、闸门与 checkpoint 框架。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const STATES = ['awake', 'preparing', 'sleeping', 'recovering']
const TRANSITIONS = {
  awake: ['preparing'],
  preparing: ['sleeping', 'awake'],      // preparing 可取消
  sleeping: ['recovering'],
  recovering: ['awake', 'sleeping'],     // recovering 中可再次入睡
}

export function createSleepManager({ stateFile, log = () => {} } = {}) {
  function load() {
    try {
      if (existsSync(stateFile)) return JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch { /* 损坏则视为清醒——安全侧 */ }
    return { state: 'awake', since: Date.now(), reason: '', strict: true, checkpoint: null, lastReport: null }
  }
  function save(s) {
    mkdirSync(join(stateFile, '..'), { recursive: true })
    writeFileSync(stateFile, JSON.stringify(s, null, 2))
  }
  let st = load()

  function assertCan(next) {
    if (!STATES.includes(next)) throw new Error(`未知状态 ${next}`)
    if (!TRANSITIONS[st.state]?.includes(next)) {
      throw new Error(`非法状态迁移 ${st.state} → ${next}`)
    }
  }

  function transition(next, { reason = '', task = null } = {}) {
    assertCan(next)
    st = {
      ...st, state: next, since: Date.now(),
      reason: reason || st.reason,
      task: next === 'preparing' ? (task || { step: 0, batchId: 'b' + Date.now().toString(36) }) : st.task,
    }
    save(st)
    log(`[dsh-mind] 睡眠状态：${st.state}${reason ? `（${reason}）` : ''}`)
    return { ...st }
  }

  return {
    get() { return { ...st } },
    isSleeping() { return st.state === 'sleeping' },
    /** 桥接闸门调用：sleeping 时一切正常陪伴唤醒被拒（消息自然滞留为未读） */
    blocksWake() { return st.state === 'sleeping' },
    enterPreparing({ reason, strict }) {
      const r = transition('preparing', { reason, task: { step: 0, batchId: 'b' + Date.now().toString(36) } })
      if (typeof strict === 'boolean') { st.strict = strict; save(st) }
      return r
    },
    enterSleeping() { return transition('sleeping', { reason: '整理开始' }) },
    enterRecovering({ reason } = {}) { return transition('recovering', { reason: reason || '整理暂停或完成' }) },
    wake({ reason } = {}) { return transition('awake', { reason: reason || '苏醒' }) },
    cancel() { return transition('awake', { reason: '入睡取消' }) },
    setCheckpoint(step, note = '') {
      st.checkpoint = { step, note, t: Date.now() }
      save(st)
    },
    setReport(report) { st.lastReport = report; save(st) },
    /** 管理授权：strict=true（默认）时，普通消息与 agent 都无法强制唤醒 */
    canForceWake(byAdmin) { return !st.strict || byAdmin === true },
  }
}
