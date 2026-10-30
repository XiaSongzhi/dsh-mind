// ═══════════════════════════════════════════════════════════════════
// dsh-mind / sleep.js —— 睡眠状态机 + 疲惫值模型（单一数据源）
// ───────────────────────────────────────────────────────────────────
//
// 【设计原则】
//
// ① 疲惫值只有一个真相来源：state.json 里的 fatigue + fatigueAt。
//    所有读取都走 advance()（按真实经过时间补算），不维护第二份。
//
// ② 不依赖 setInterval 作为时钟。
//    每次调用 advance() 都用 `now - lastCalcAt` 计算真实经过时间，
//    所以页面关闭、服务重启、电脑休眠后都能正确补算。
//    setInterval 只是"触发补算的时机之一"，不是时间的来源。
//
// ③ 四态可退出：
//    awake ⇄ preparing ⇄ sleeping ⇄ recovering ⇄ awake
//    blocked 起来的关键是：**每个状态都有超时兜底**，不靠单一布尔位。
//    recovering 若超过 maxRecoveringMs 强制回 awake。
//
// ④ 迟滞（hysteresis）：入睡阈值 70，醒来阈值 25，
//    中间留 45 的缓冲带，避免在阈值附近抖动。
//
// 【疲惫值模型】
//
//   清醒期累积速率（不是机械 +10/h）：
//     · 基础 6.0/h
//     · 刚醒 2 小时内 增速打折 0.55（人刚醒时不那么累）
//     · 连续清醒 > 12h 后线性加速到 14/h
//     · 夜间（22:00-06:00）额外 ×1.35（昼夜节律）
//     · 距上次睡眠窗口结束越久，额外 +（睡眠债）
//   睡眠期恢复速率：
//     · 前 90 分钟 18/h（深睡恢复最快）
//     · 90~300 分钟 12/h
//     · 超过 300 分钟 6/h（睡得越久越难再降）
//     · 睡眠债高时按比例提高上限，但不会瞬间归零
//
//   结果 clamp 到 [0,100]，并对 clock skew / 时间倒退做保护。
//
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const STATES = ['awake', 'preparing', 'sleeping', 'recovering']

const TRANSITIONS = {
  awake: ['preparing'],
  preparing: ['sleeping', 'awake'],      // preparing 可取消
  sleeping: ['recovering'],
  recovering: ['awake', 'sleeping'],     // recovering 中可再次入睡
}

/* ── 时间常量（毫秒）── */
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/* ── 状态机阈值与兜底 ── */
/* 默认阈值。运行时可由 settings 覆盖（见 createSleepManager 的 thresholds 参数） */
const TH_DEFAULTS = {
  fatigueSleep: 70,        // 疲惫 ≥ 此值 → 该睡
  fatigueSleepMin: 45,     // 在作息窗口内，疲惫 ≥ 此值也睡（更宽容）
  fatigueWake: 25,         // 疲惫 ≤ 此值 → 该醒
  sleepDebtWake: 40,       // 睡眠债高时，醒来阈值放宽到这个值

  preparingMinMs: 15 * MIN,      // 准备入睡最短过渡
  preparingMaxMs: 45 * MIN,      // 准备入睡最长（超时强制进 sleeping）

  minSleepMs: 45 * MIN,          // 最低睡眠时长（满这个才可能进 recovering）
  normalSleepMs: 90 * MIN,       // 常规睡眠时长
  maxSleepMs: 12 * HOUR,         // 安全网：超过强制醒

  recoveringMinMs: 3 * MIN,      // 将醒最少持续（让"刚睡醒"的迷糊有实体感）
  recoveringMaxMs: 40 * MIN,     // 将醒最长（超时强制回 awake —— 修死锁）

  manualOverrideMs: 2 * HOUR,    // 手动去睡/叫醒后，自动判断暂停这么久

  /* 疲惫值速率（可配置） */
  awakeRate: 6,
  awakeFreshMul: 0.55,
  awakeRushAfterH: 12,
  awakeRushMax: 8,
  nightMul: 1.35,
  sleepDebtMulCap: 0.5,
  sleepRateFast: 18,
  sleepRateMid: 12,
  sleepRateSlow: 6,
  sleepFastUntilH: 1.5,
  sleepMidUntilH: 5,
}

const TH = Object.assign({}, TH_DEFAULTS)

/* ═══════════════════════════════════════════════════════════════════
   时间窗口工具：跨午夜、多段、边界
   ═══════════════════════════════════════════════════════════════════ */

/** "HH:MM" → 当日分钟数 */
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return h * 60 + mi
}

/**
 * 判断某时刻是否落在时段内（正确处理跨午夜与边界）。
 * 返回 { inWindow, window, position: 'start'|'middle'|'end' }
 */
function inWindowAt(win, date) {
  const a = parseHM(win.start)
  const b = parseHM(win.end)
  if (a == null || b == null) return { inWindow: false }

  const mins = date.getHours() * 60 + date.getMinutes()
  const cross = a > b          // 跨午夜，例如 23:30 → 08:30

  let hit = false
  let position = 'middle'
  if (cross) {
    // 两段：当天 [a, 24:00) ∪ [00:00, b]
    if (mins >= a) { hit = true; position = 'start' }
    else if (mins <= b) { hit = true; position = mins >= b - 30 ? 'end' : 'middle' }
  } else {
    // 同日段 [a, b]
    hit = mins >= a && mins <= b
    if (hit) position = mins === a ? 'start' : (mins >= b - 30 ? 'end' : 'middle')
  }
  return { inWindow: hit, window: win, position }
}

/**
 * 距离当前所在窗口「结束」还有多少毫秒。
 * w 是 currentWindow() 的返回值（含 window 对象与 inWindow 标志）。
 */
function msUntilWindowEnd(w, now) {
  if (!w || !w.inWindow || !w.window) return null
  const win = w.window
  const b = parseHM(win.end)
  if (b == null) return null
  const curMin = now.getHours() * 60 + now.getMinutes()
  const a = parseHM(win.start)
  let diff
  if (a != null && a > b) {
    // 跨午夜：结束在次日
    diff = (curMin >= a) ? (24 * 60 - curMin) + b : b - curMin
  } else {
    diff = b - curMin
  }
  if (diff < 0) diff += 24 * 60
  return diff * MIN
}

/** 距离下一次"窗口开始"还有多少毫秒（用于"距下次建议休息"） */
function msUntilNextWindow(windows, now) {
  let best = Infinity
  for (const w of (windows || [])) {
    if (w.enabled === false) continue
    const a = parseHM(w.start)
    if (a == null) continue
    const cur = now.getHours() * 60 + now.getMinutes()
    let diffMin = a - cur
    if (diffMin <= 0) diffMin += 24 * 60     // 今天已过 → 明天
    const ms = diffMin * MIN
    if (ms < best) best = ms
  }
  return best === Infinity ? null : best
}

/* ═══════════════════════════════════════════════════════════════════
   createSleepManager
   ═══════════════════════════════════════════════════════════════════ */

export function createSleepManager({ stateFile, log = () => {} } = {}) {

  /* ─────────── 持久化 ─────────── */

  function defaults() {
    const now = Date.now()
    return {
      state: 'awake',
      since: now,
      reason: '初始化',
      strict: true,
      checkpoint: null,
      lastReport: null,
      task: null,

      // 疲惫值（单一数据源）
      fatigue: 20,
      fatigueAt: now,          // 上次完成补算的时间戳

      // 状态时间线
      lastStateChangedAt: now,
      sleepSessionStartedAt: null,
      sleepSessionEndedAt: null,
      lastWakeAt: now,         // 上次醒来
      lastSleepAt: null,       // 上次入睡
      recoveringStartedAt: null,

      // 睡眠债（0~100）：连续睡眠不足累积
      sleepDebt: 0,

      // 手动覆盖
      manualOverride: null,    // { kind:'sleep'|'wake', at, until }

      // 作息
      schedule: {
        auto: true,
        preferFixedTime: false,
        fatigueSleep: TH.fatigueSleep,
        // ⚠️ 曾漏这一项 → shouldSleep 里 fat >= undefined 恒 false，
        //    表现为「进了作息窗口、疲惫很高却永远不睡」。
        fatigueSleepMin: TH.fatigueSleepMin,
        fatigueWake: TH.fatigueWake,
        windows: [
          { name: '夜间睡眠', start: '23:30', end: '08:30', type: 'night', enabled: true },
          { name: '午睡', start: '13:00', end: '14:00', type: 'nap', enabled: true },
        ],
      },

      // 状态变更记录（环形，最多 40 条）
      history: [],
    }
  }

  function load() {
    try {
      if (!existsSync(stateFile)) return defaults()
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
      // 合并默认值（老文件缺字段时补齐）
      const base = defaults()
      const merged = Object.assign({}, base, raw)
      merged.schedule = Object.assign({}, base.schedule, raw.schedule || {})
      // 疲惫值缺失 → 用默认；存在则保留
      if (typeof raw.fatigue !== 'number' || !isFinite(raw.fatigue)) merged.fatigue = base.fatigue
      if (typeof raw.fatigueAt !== 'number' || !isFinite(raw.fatigueAt)) merged.fatigueAt = base.fatigueAt
      if (!Array.isArray(merged.history)) merged.history = []
      return merged
    } catch {
      return defaults()
    }
  }

  function save() {
    try {
      mkdirSync(join(stateFile, '..'), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(st, null, 2))
    } catch (e) {
      log('[dsh-mind] state.json 写入失败：' + (e && e.message))
    }
  }

  let st = load()

  /* ─────────── 历史记录 ─────────── */

  function recordHistory(kind, reason, extra) {
    st.history.push(Object.assign({
      at: Date.now(),
      kind: kind,
      reason: reason,
      fatigue: Math.round(st.fatigue),
      from: st.state,
      to: st.state,
    }, extra || {}))
    if (st.history.length > 40) st.history = st.history.slice(-40)
  }

  /* ═══════════ 疲惫值计算（核心）═══════════ */

  /**
   * 按真实经过时间补算疲惫值。
   *
   * ⚠️ 这是**唯一**修改 st.fatigue 的地方（除手动 set 外）。
   * 所有调用方（HTTP、驱动、面板）都通过它拿最新值。
   */
  function advanceFatigue(nowMs) {
    const now = nowMs || Date.now()
    const last = st.fatigueAt

    // ── 保护：时间倒退 / 异常跨度 ──
    if (!isFinite(last) || last <= 0) { st.fatigueAt = now; return st.fatigue }
    let elapsed = now - last
    if (elapsed < 0) {
      // 系统时钟回拨：不补算，只重置锚点
      log('[dsh-mind] 检测到时间倒退，重置疲惫锚点')
      st.fatigueAt = now
      return st.fatigue
    }
    if (elapsed < 30 * 1000) {
      // 30 秒内不重复计算（避免每拍抖动）
      return st.fatigue
    }
    // 单次最多补算 7 天，防止极端跨度造成跳变
    const capped = Math.min(elapsed, 7 * DAY)
    const hours = capped / HOUR

    let delta = 0

    if (st.state === 'awake') {
      // ── 清醒：累积 ──
      let rate = TH.awakeRate

      // 刚醒 2 小时内没那么累
      const sinceWakeH = st.lastWakeAt ? (now - st.lastWakeAt) / HOUR : 99
      if (sinceWakeH < 2) rate *= TH.awakeFreshMul

      // 连续清醒超过 12 小时加速
      const awakeH = st.lastWakeAt ? (now - st.lastWakeAt) / HOUR : 0
      if (awakeH > TH.awakeRushAfterH) {
        rate += Math.min(TH.awakeRushMax, (awakeH - TH.awakeRushAfterH) * 1.2)
      }

      // 昼夜节律：夜间更累
      const hourOfDay = new Date(now).getHours()
      if (hourOfDay >= 22 || hourOfDay < 6) rate *= TH.nightMul

      // 睡眠债：欠得越多，累得越快
      if (st.sleepDebt > 0) rate *= (1 + Math.min(0.5, st.sleepDebt / 200))

      delta = rate * hours

    } else if (st.state === 'preparing') {
      // ── 准备入睡：继续增，但增速明显降低 ──
      delta = 2.0 * hours

    } else if (st.state === 'sleeping' || st.state === 'recovering') {
      // ── 睡眠：恢复 ──
      const sleptH = st.sleepSessionStartedAt
        ? (now - st.sleepSessionStartedAt) / HOUR
        : 0
      let rate
      if (sleptH < TH.sleepFastUntilH) rate = TH.sleepRateFast
      else if (sleptH < TH.sleepMidUntilH) rate = TH.sleepRateMid
      else rate = TH.sleepRateSlow
      // 睡眠债高时恢复稍快（但不会瞬归零）
      if (st.sleepDebt > 40) rate *= 1.15
      delta = -rate * hours
    }

    // 应用
    const next = Math.max(0, Math.min(100, st.fatigue + delta))
    st.fatigue = next
    st.fatigueAt = now

    // 起床后更新睡眠债：醒来时若疲惫仍高，说明没睡够
    if ((st.state === 'awake') && st.lastSleepAt && st.lastWakeAt &&
        st.lastWakeAt === st.since && st.fatigue > 50) {
      st.sleepDebt = Math.min(100, st.sleepDebt + 3)
    }

    return st.fatigue
  }

  /* ═══════════ 状态迁移 ═══════════ */

  function assertCan(next) {
    if (!STATES.includes(next)) throw new Error('未知状态 ' + next)
    if (!TRANSITIONS[st.state] || !TRANSITIONS[st.state].includes(next)) {
      throw new Error('非法状态迁移 ' + st.state + ' → ' + next)
    }
  }

  function transition(next, opts) {
    const o = opts || {}

    // ── 幂等：已经在目标状态 → 直接返回，不抛错 ──
    // 场景：用户在"清醒"时点"叫醒"、在"沉睡"时点"去睡"、
    //      驱动重复触发同一迁移。这些都不该是错误。
    if (st.state === next) {
      if (o.manual) {
        // 手动操作仍要记录覆盖时间（避免自动判断立刻反扑）
        st.manualOverride = {
          kind: next === 'awake' ? 'wake' : 'sleep',
          at: Date.now(),
          until: Date.now() + TH.manualOverrideMs,
        }
        save()
      }
      return getState()
    }

    assertCan(next)
    const now = Date.now()
    const from = st.state
    const fatigueAtChange = Math.round(st.fatigue)

    st.state = next
    st.since = now
    st.lastStateChangedAt = now
    st.reason = o.reason || st.reason

    if (next === 'preparing') {
      st.task = o.task || { step: 0, batchId: 'b' + now.toString(36) }
      st.preparingStartedAt = now
      st.lastSleepAt = now
      st.recoveringStartedAt = null
    }
    if (next === 'sleeping') {
      st.sleepSessionStartedAt = now
      st.sleepSessionEndedAt = null
      st.preparingStartedAt = null
      st.recoveringStartedAt = null
    }
    if (next === 'recovering') {
      st.recoveringStartedAt = now
      st.sleepSessionEndedAt = now
    }
    if (next === 'awake') {
      st.lastWakeAt = now
      st.sleepSessionStartedAt = null
      st.sleepSessionEndedAt = now
      st.recoveringStartedAt = null
      st.checkpoint = null
    }

    recordHistory('transition', st.reason, { from: from, to: next, fatigue: fatigueAtChange })
    save()
    log('[dsh-mind] 睡眠状态：' + from + ' → ' + next + (st.reason ? '（' + st.reason + '）' : ''))
    return getState()
  }

  /* ═══════════ 判断：该睡 / 该醒 ═══════════ */

  function getSchedule() {
    const base = defaults().schedule
    return Object.assign({}, base, st.schedule || {}, {
      windows: Array.isArray(st.schedule && st.schedule.windows)
        ? st.schedule.windows
        : base.windows,
    })
  }

  /** 是否在某个生效的作息窗口内 */
  function currentWindow(nowDate) {
    const d = nowDate || new Date()
    for (const w of getSchedule().windows) {
      if (w.enabled === false) continue
      const r = inWindowAt(w, d)
      if (r.inWindow) return r
    }
    return { inWindow: false, window: null }
  }

  /** 手动覆盖是否仍生效 */
  function overrideActive(nowMs) {
    const o = st.manualOverride
    if (!o) return null
    if (!isFinite(o.until) || o.until <= (nowMs || Date.now())) {
      st.manualOverride = null
      save()
      return null
    }
    return o
  }

  function shouldSleep(nowMs) {
    const now = nowMs || Date.now()
    const nowDate = new Date(now)
    const cfg = getSchedule()
    const fat = advanceFatigue(now)
    const w = currentWindow(nowDate)
    const ov = overrideActive(now)

    if (st.state !== 'awake') {
      return { yes: false, why: '当前不在清醒状态（' + st.state + '）', fatigue: fat }
    }
    // 手动叫醒后 2 小时内不自动睡
    if (ov && ov.kind === 'wake') {
      return { yes: false, why: '手动叫醒保护期内（还剩 ' + Math.round((ov.until - now) / MIN) + ' 分钟）', fatigue: fat }
    }

    // ① 疲惫到线（与作息无关）
    if (fat >= cfg.fatigueSleep) {
      return { yes: true, why: '疲惫值 ' + Math.round(fat) + ' 已达 ' + cfg.fatigueSleep, fatigue: fat, trigger: 'fatigue' }
    }

    // ② 固定时间优先模式：进窗口就准备睡
    if (cfg.preferFixedTime && w.inWindow) {
      return { yes: true, why: '固定作息「' + w.window.name + '」时段', fatigue: fat, trigger: 'fixed' }
    }

    // ③ 自主判断：在窗口内且疲惫中等
    if (cfg.auto !== false && w.inWindow && fat >= cfg.fatigueSleepMin) {
      return { yes: true, why: '在「' + w.window.name + '」时段，疲惫 ' + Math.round(fat), fatigue: fat, trigger: 'schedule' }
    }

    // ④ 连续清醒超 20 小时（安全网）
    const awakeH = st.lastWakeAt ? (now - st.lastWakeAt) / HOUR : 0
    if (awakeH >= 20) {
      return { yes: true, why: '已连续清醒 ' + Math.round(awakeH) + ' 小时', fatigue: fat, trigger: 'awake-too-long' }
    }

    const nextWin = msUntilNextWindow(cfg.windows, nowDate)
    return {
      yes: false,
      why: '疲惫 ' + Math.round(fat) + '，还不到该睡的时候',
      fatigue: fat,
      nextWindowInMs: nextWin,
    }
  }

  function shouldWake(nowMs) {
    const now = nowMs || Date.now()
    const nowDate = new Date(now)
    const cfg = getSchedule()
    const fat = advanceFatigue(now)
    const w = currentWindow(nowDate)
    const ov = overrideActive(now)

    // ⚠️ 四态都要能应答（修"将醒"死锁）
    if (!['preparing', 'sleeping', 'recovering'].includes(st.state)) {
      return { yes: false, why: '当前不在睡眠中', fatigue: fat }
    }

    const base = st.state === 'recovering'
      ? (st.recoveringStartedAt || st.since)
      : (st.sleepSessionStartedAt || st.since)
    const elapsedMs = now - base
    const sleptMin = elapsedMs / MIN

    // ① 手动叫醒 → 立刻醒
    if (ov && ov.kind === 'wake') {
      return { yes: true, why: '手动叫醒', fatigue: fat, trigger: 'manual' }
    }

    // ② 疲惫已降够 —— 但**仅在作息窗口外**才生效
    //
    // ⚠️ 关键优先级：作息窗口 > 疲惫值。
    //    窗口内即使疲惫降到 10 也不该醒（身体在休息，中途醒来只会打断恢复）。
    //    原实现这里不看窗口，导致"窗口内疲惫一低就醒"，违背用户设定。
    const wakeTH = st.sleepDebt > 40 ? TH.sleepDebtWake : cfg.fatigueWake
    const inWindowNow = w.inWindow
    if (!inWindowNow && fat <= wakeTH) {
      return { yes: true, why: '疲惫值已降到 ' + Math.round(fat) + '（阈值 ' + wakeTH + '）',
        fatigue: fat, trigger: 'fatigue' }
    }

    // ③ 将醒状态：超时强制回清醒（核心修复）
    if (st.state === 'recovering' && elapsedMs >= TH.recoveringMaxMs) {
      return { yes: true, why: '将醒已持续 ' + Math.round(elapsedMs / MIN) + ' 分钟，强制清醒',
        fatigue: fat, trigger: 'recovering-timeout' }
    }
    // 将醒且满足最小持续 → 可以醒
    // ⚠️ 原实现「将醒满 3 分钟必醒」与 fatigueWake 完全脱钩，
    //    实测疲惫 67 就走了（离阈值 25 差 42 点）。改为：缓冲过后
    //    必须满足真正的醒来条件（睡够常规时长 / 窗口结束 / 安全网），
    //    否则继续留在将醒。
    if (st.state === 'recovering' && elapsedMs >= TH.recoveringMinMs) {
      const sleptM = st.sleepSessionStartedAt
        ? (now - st.sleepSessionStartedAt) / MIN
        : 0

      // 安全网优先
      if (sleptM >= TH.maxSleepMs / MIN) {
        return { yes: true, why: '睡眠超过最长时长（安全网）',
          fatigue: fat, trigger: 'safety', sleptMin: Math.round(sleptM) }
      }

      // ① 在作息窗口内 → 回到沉睡继续睡（不按时长醒）
      if (w.inWindow) {
        return { yes: false, inWindow: true,
          why: '在「' + (w.window ? w.window.name : '作息') + '」窗口内，应继续沉睡',
          fatigue: fat, sleptMin: Math.round(sleptM) }
      }

      // ② 窗口外
      if (sleptM >= TH.minSleepMs / MIN) {
        if (fat <= wakeTH) {
          return { yes: true, why: '窗口已结束，疲惫降到 ' + Math.round(fat) + '（阈值 ' + wakeTH + '）',
            fatigue: fat, trigger: 'recovered', sleptMin: Math.round(sleptM) }
        }
        if (sleptM >= TH.normalSleepMs / MIN) {
          return { yes: true, why: '窗口已结束且已睡 ' + Math.round(sleptM) + ' 分钟（常规时长）',
            fatigue: fat, trigger: 'duration', sleptMin: Math.round(sleptM) }
        }
        return { yes: false,
          why: '窗口已结束，等待恢复：还需降 ' + Math.round(fat - wakeTH) + ' 点疲惫',
          fatigue: fat, sleptMin: Math.round(sleptM) }
      }

      return { yes: false,
        why: '还需 ' + Math.max(0, Math.round((TH.minSleepMs / MIN) - sleptM)) +
          ' 分钟达到最短睡眠（已睡 ' + Math.round(sleptM) + '）',
        fatigue: fat, sleptMin: Math.round(sleptM) }
    }

    // ④ 准备入睡超时 → 直接进沉睡（不卡在 preparing）
    if (st.state === 'preparing' && elapsedMs >= TH.preparingMinMs) {
      return { yes: false, why: '准备入睡完成，该进沉睡', fatigue: fat, trigger: 'to-sleep' }
    }

    // ⑤ 沉睡中的醒来判定（优先级：作息窗口 > 疲惫值 > 安全网）
    if (st.state === 'sleeping') {
      const inWin = w.inWindow

      // ── 安全网：超过最长睡眠必须醒（任何情况都生效）──
      if (sleptMin >= TH.maxSleepMs / MIN) {
        return {
          yes: true,
          why: '睡眠已超过 ' + Math.round(TH.maxSleepMs / 3600000) + ' 小时（安全网）',
          fatigue: fat, trigger: 'safety',
        }
      }

      // ── ① 在作息窗口内 → 一直睡，不看疲惫值 ──
      //    身体在休息，中途醒来反而打断恢复。
      if (inWin) {
        const endInMs = msUntilWindowEnd(w, nowDate)
        return {
          yes: false,
          why: '在「' + (w.window ? w.window.name : '作息') + '」窗口内，持续沉睡' +
            (endInMs != null ? '（窗口约 ' + Math.round(endInMs / MIN) + ' 分钟后结束）' : ''),
          fatigue: fat, sleptMin: Math.round(sleptMin),
          windowEndInMs: endInMs,
        }
      }

      // ── ② 窗口外：按疲惫值判断（睡够最短时长后）──
      if (sleptMin >= TH.minSleepMs / MIN) {
        // 疲惫已降够 → 醒
        if (fat <= wakeTH) {
          return {
            yes: true,
            why: '窗口已结束，疲惫降到 ' + Math.round(fat) + '（阈值 ' + wakeTH + '）',
            fatigue: fat, trigger: 'recovered', sleptMin: Math.round(sleptMin),
          }
        }
        // 睡够常规时长 → 允许按时长醒（窗口外的补睡不该无限延长）
        if (sleptMin >= TH.normalSleepMs / MIN) {
          return {
            yes: true,
            why: '窗口已结束且已睡 ' + Math.round(sleptMin) + ' 分钟（常规时长）',
            fatigue: fat, trigger: 'duration', sleptMin: Math.round(sleptMin),
          }
        }
        // 都没到 → 继续睡（等疲惫恢复）
        const needMoreFat = Math.round(fat - wakeTH)
        return {
          yes: false,
          why: '窗口已结束，等待恢复：还需降 ' + needMoreFat + ' 点疲惫（当前 ' +
            Math.round(fat) + '，阈值 ' + wakeTH + '）',
          fatigue: fat, sleptMin: Math.round(sleptMin),
        }
      }

      // 还没睡够最短时长（窗口外但刚躺下）
      return {
        yes: false,
        why: '还需 ' + Math.max(0, Math.round((TH.minSleepMs / MIN) - sleptMin)) +
          ' 分钟达到最短睡眠（已睡 ' + Math.round(sleptMin) + '）',
        fatigue: fat, sleptMin: Math.round(sleptMin),
      }
    }

    const nextWindow = msUntilNextWindow(cfg.windows, nowDate)
    return {
      yes: false,
      why: '已睡 ' + Math.round(sleptMin) + ' 分钟，疲惫 ' + Math.round(fat),
      fatigue: fat,
      sleptMin: Math.round(sleptMin),
      nextWindowInMs: nextWindow,
    }
  }

  /* ═══════════ 状态修复（防死锁）═══════════ */

  /**
   * 每次读取时自检：修复损坏 / 无限停留的状态。
   * 这是"将醒卡死"的最后一道保险。
   */
  function selfHeal(nowMs) {
    const now = nowMs || Date.now()
    let changed = false

    // ① 状态值非法
    if (!STATES.includes(st.state)) {
      st.state = 'awake'; st.since = now; st.reason = '状态值非法，已修复为清醒'
      changed = true
    }

    // ② recovering 但没有 recoveringStartedAt（老数据）→ 补上
    if (st.state === 'recovering' && !st.recoveringStartedAt) {
      st.recoveringStartedAt = st.since || now
      changed = true
    }

    // ③ recovering 超时 → 强制 awake（核心修复）
    if (st.state === 'recovering') {
      const elapsed = now - (st.recoveringStartedAt || st.since || now)
      if (elapsed >= TH.recoveringMaxMs) {
        st.lastWakeAt = now
        st.sleepSessionStartedAt = null
        st.sleepSessionEndedAt = now
        st.recoveringStartedAt = null
        st.checkpoint = null
        st.state = 'awake'
        st.since = now
        st.lastStateChangedAt = now
        st.reason = '将醒超时（' + Math.round(elapsed / MIN) + ' 分钟），自动恢复清醒'
        recordHistory('self-heal', st.reason, { to: 'awake' })
        changed = true
        log('[dsh-mind] 自愈：将醒超时 → 清醒')
      }
    }

    // ④ sleeping 但没有 sleepSessionStartedAt → 补
    if (st.state === 'sleeping' && !st.sleepSessionStartedAt) {
      st.sleepSessionStartedAt = st.since || now
      changed = true
    }

    // ⑤ sleeping 超 12 小时 → 强制 recovering
    if (st.state === 'sleeping') {
      const slept = now - (st.sleepSessionStartedAt || st.since || now)
      if (slept >= TH.maxSleepMs) {
        st.state = 'recovering'
        st.recoveringStartedAt = now
        st.since = now
        st.sleepSessionEndedAt = now
        st.lastStateChangedAt = now
        st.reason = '睡眠超过 12 小时，强制进入将醒'
        recordHistory('self-heal', st.reason, { from: 'sleeping', to: 'recovering' })
        changed = true
        log('[dsh-mind] 自愈：睡眠超时 → 将醒')
      }
    }

    // ⑥ preparing 超 45 分钟 → 强制 sleeping
    if (st.state === 'preparing') {
      const p = now - (st.preparingStartedAt || st.since || now)
      if (p >= TH.preparingMaxMs) {
        st.state = 'sleeping'
        st.sleepSessionStartedAt = now
        st.since = now
        st.lastStateChangedAt = now
        st.reason = '准备入睡超时，直接进入沉睡'
        recordHistory('self-heal', st.reason, { from: 'preparing', to: 'sleeping' })
        changed = true
        log('[dsh-mind] 自愈：准备入睡超时 → 沉睡')
      }
    }

    // ⑦ 疲惫值非法
    if (typeof st.fatigue !== 'number' || !isFinite(st.fatigue)) {
      st.fatigue = 20; changed = true
    }
    if (st.fatigue < 0) { st.fatigue = 0; changed = true }
    if (st.fatigue > 100) { st.fatigue = 100; changed = true }

    if (changed) save()
  }

  /* ═══════════ 对外状态 ═══════════ */

  /**
   * 清理「快照式 reason」。
   * 历史数据里 sleeping 的 reason 可能是「已睡 10 分钟，疲惫 67」——
   * 那是进入状态时的快照，之后不再更新，和实时 sleptMs 会矛盾。
   * 读出时替换成静态描述（实时量由 sleptMs / stateElapsedMs 提供）。
   */
  function sanitizeReason(raw, state) {
    const r = String(raw || '')
    if (!r) return '—'
    // 匹配「已睡 N 分钟，疲惫 M」这类随时间变化的旧文案
    if (/已睡\s*\d+\s*分钟/.test(r) && state === 'sleeping') {
      return '进入沉睡（整理进度与时长见下方实时数据）'
    }
    return r
  }

  function getState() {
    const now = Date.now()
    const cfg = getSchedule()
    const w = currentWindow(new Date(now))
    const sleptMs = st.state === 'sleeping' && st.sleepSessionStartedAt
      ? now - st.sleepSessionStartedAt
      : (st.state === 'recovering' && st.sleepSessionStartedAt ? 0 : 0)
    const stateElapsedMs = now - (st.since || now)
    const nextWin = msUntilNextWindow(cfg.windows, new Date(now))

    return {
      state: st.state,
      since: st.since,
      reason: sanitizeReason(st.reason, st.state),
      strict: st.strict,
      task: st.task,
      checkpoint: st.checkpoint,
      lastReport: st.lastReport,

      fatigue: Math.round(st.fatigue * 10) / 10,
      fatigueAt: st.fatigueAt,
      sleepDebt: Math.round(st.sleepDebt),

      lastStateChangedAt: st.lastStateChangedAt,
      sleepSessionStartedAt: st.sleepSessionStartedAt,
      sleepSessionEndedAt: st.sleepSessionEndedAt,
      lastWakeAt: st.lastWakeAt,
      lastSleepAt: st.lastSleepAt,
      recoveringStartedAt: st.recoveringStartedAt,

      stateElapsedMs: stateElapsedMs,
      sleptMs: sleptMs,
      inWindow: w.inWindow,
      currentWindow: w.window,
      nextWindowInMs: nextWin,
      manualOverride: overrideActive(now),
      schedule: cfg,
      history: st.history.slice(-20).reverse(),
    }
  }

  /* ═══════════ 导出 ═══════════ */

  const api = {
    /* ── 读 ── */
    get() {
      selfHeal()
      advanceFatigue()
      save()
      return getState()
    },

    /** 只补算疲惫值（驱动每拍调它） */
    tickFatigue() {
      selfHeal()
      advanceFatigue()
      save()
      return Math.round(st.fatigue * 10) / 10
    },

    isSleeping() { return st.state === 'sleeping' || st.state === 'recovering' },

    /**
     * 当前是否属于「夜间睡眠」——只有夜间睡眠才整理记忆。
     *
     * 判定：当前时刻落在某个 type='night' 的生效窗口内。
     * 白天小睡（type='nap' 或不在任何 night 窗口）返回 false，
     * 那种睡眠只恢复疲惫值，不做记忆整理。
     */
    isNightSleep(nowMs) {
      const d = new Date(nowMs || Date.now())
      const wins = getSchedule().windows || []
      for (const w of wins) {
        if (w.enabled === false) continue
        if ((w.type || 'night') !== 'night') continue
        const r = inWindowAt(w, d)
        if (r.inWindow) return { yes: true, window: w }
      }
      return { yes: false, window: null }
    },
    blocksWake() { return st.state === 'sleeping' },

    /* ── 疲惫值（唯一来源）── */
    fatigue: {
      get() { advanceFatigue(); return Math.round(st.fatigue * 10) / 10 },
      set(v) {
        st.fatigue = Math.max(0, Math.min(100, Math.round(Number(v) * 10) / 10))
        st.fatigueAt = Date.now()
        recordHistory('manual-fatigue', '手动设置疲惫值为 ' + st.fatigue, {})
        save()
        return st.fatigue
      },
      advance() { return advanceFatigue() },
    },

    /* ── 状态迁移 ── */
    enterPreparing(opts) {
      const o = opts || {}
      const r = transition('preparing', { reason: o.reason, task: o.task })
      if (o.manual) {
        st.manualOverride = { kind: 'sleep', at: Date.now(), until: Date.now() + TH.manualOverrideMs }
        save()
      }
      return r
    },
    enterSleeping(opts) {
      const o = opts || {}
      return transition('sleeping', { reason: o.reason || '进入沉睡' })
    },
    enterRecovering(opts) {
      const o = opts || {}
      return transition('recovering', { reason: o.reason || '开始醒来' })
    },
    wake(opts) {
      const o = opts || {}
      // sleeping 必须先经 recovering（状态机约束），但用户点"叫醒"应一步生效：
      // 这里自动补一步，避免 UI 报错。
      if (st.state === 'sleeping') {
        try { transition('recovering', { reason: '准备唤醒' }) } catch (e) {}
      }
      const r = transition('awake', { reason: o.reason || '醒来' })
      if (o.manual) {
        st.manualOverride = { kind: 'wake', at: Date.now(), until: Date.now() + TH.manualOverrideMs }
        save()
      }
      return r
    },
    cancel() { return transition('awake', { reason: '入睡取消' }) },

    /* ── 判断 ── */
    shouldSleep: shouldSleep,
    shouldWake: shouldWake,
    currentWindow: function () { return currentWindow(new Date()) },
    inWindowAt: inWindowAt,
    msUntilNextWindow: msUntilNextWindow,

    /* ── 作息表 ── */
    schedule: {
      get() { return getSchedule() },
      set(patch) {
        const cur = getSchedule()
        const next = Object.assign({}, cur, patch || {})
        if (Array.isArray(patch && patch.windows)) next.windows = patch.windows
        st.schedule = next
        recordHistory('schedule', '作息表已更新')
        save()
        // 改了作息要立刻重算状态
        selfHeal()
        advanceFatigue()
        save()
        return getSchedule()
      },
    },

    /* ── 整理进度 ── */
    setCheckpoint(step, note) {
      st.checkpoint = { step: step, note: note || '', t: Date.now() }
      if (st.task && typeof st.task === 'object') {
        st.task.step = step
        st.task.fails = 0
        st.task.failStep = null
      }
      save()
    },
    bumpTaskFail(step) {
      if (!st.task || typeof st.task !== 'object') return 0
      if (st.task.failStep !== step || !st.task.fails) st.task.fails = 0
      st.task.failStep = step
      st.task.fails = (st.task.fails || 0) + 1
      save()
      return st.task.fails
    },
    getTask() { return st.task ? Object.assign({}, st.task) : null },
    setReport(report) { st.lastReport = report; save() },
    canForceWake(byAdmin) { return !st.strict || byAdmin === true },

    /* ── 自主意愿（她自己表达想睡/想醒）── */
    intendSleep(o) {
      const oo = o || {}
      st.self = Object.assign({}, st.self, {
        sleeping: true, why: oo.reason || '', mood: oo.mood || '',
        at: Date.now(), bySelf: true,
      })
      save()
      return Object.assign({}, st.self)
    },
    intendWake(o) {
      const oo = o || {}
      st.self = Object.assign({}, st.self, {
        sleeping: false, why: oo.reason || '', at: Date.now(), bySelf: true,
      })
      save()
      return Object.assign({}, st.self)
    },
    selfIntent() { return st.self ? Object.assign({}, st.self) : null },

    /* ── 刚睡醒 ── */
    markJustWoke(o) {
      const oo = o || {}
      st.justWoke = {
        at: Date.now(),
        sleptMin: Math.round(oo.sleptMin || 0),
        until: Date.now() + 20 * MIN,
      }
      save()
      return Object.assign({}, st.justWoke)
    },
    isJustWoke() {
      if (!st.justWoke) return null
      if (Date.now() > (st.justWoke.until || 0)) {
        delete st.justWoke
        save()
        return null
      }
      return Object.assign({}, st.justWoke)
    },

    /* ── 手动覆盖 ── */
    manualOverride() { return overrideActive() },
    clearOverride() {
      st.manualOverride = null
      save()
      return true
    },

    /* ── 自愈 ── */
    selfHeal: selfHeal,
    history() { return st.history.slice(-40).reverse() },

    /* ── 常量（面板展示用）── */
    thresholds: TH,

    /** 运行时换阈值（面板改设置后调用，无需重启） */
    thresholdsReload(next) {
      if (!next) return
      for (const k of Object.keys(TH)) {
        if (next[k] != null && isFinite(next[k])) TH[k] = next[k]
      }
    },
  }

  // 启动即自检 + 补算（重启后立刻正确）
  try {
    selfHeal()
    advanceFatigue()
    save()
  } catch (e) { log('[dsh-mind] 睡眠初始化异常：' + (e && e.message)) }

  return api
}
