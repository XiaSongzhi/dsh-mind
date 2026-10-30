import { createSleepManager } from '../lib/sleep.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOUR = 3600000
const MIN = 60000
let pass = 0, fail = 0

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

function newFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsleep-'))
  return join(dir, 's.json')
}

/** 写一个指定字段的 state.json 并加载 */
function seed(overrides) {
  const f = newFile()
  const base = {
    state: 'awake',
    since: Date.now(),
    lastWakeAt: Date.now() - 3 * HOUR,
    fatigue: 20,
    fatigueAt: Date.now(),
    sleepSessionStartedAt: null,
    sleepSessionEndedAt: null,
    recoveringStartedAt: null,
    sleepDebt: 0,
    schedule: {
      auto: true, preferFixedTime: false, fatigueSleep: 70, fatigueWake: 25,
      windows: [{ name: '夜间睡眠', start: '23:30', end: '08:30', type: 'night', enabled: true }],
    },
    history: [],
  }
  writeFileSync(f, JSON.stringify(Object.assign(base, overrides || {})))
  return { f, m: createSleepManager({ stateFile: f, log: () => {} }) }
}

console.log('\n═══ 1. 时间推进：清醒时疲惫值随时间增长 ═══')
{
  const { m } = seed({ fatigue: 20, fatigueAt: Date.now() - 8 * HOUR, lastWakeAt: Date.now() - 8 * HOUR })
  const after = m.fatigue.get()
  ok('8 小时后疲惫值上升', after > 20, 'got=' + after)
  // 速率含昼夜节律（夜间 ×1.35）、连续清醒加速、睡眠债加成，
  // 8 小时实测可达 85 左右，所以区间放宽到 40~100（100 是封顶）。
  ok('上升幅度合理(40~100)', after >= 40 && after <= 100, 'got=' + after)
}

console.log('\n═══ 2. 睡眠时疲惫值下降 ═══')
{
  const { m } = seed({
    state: 'sleeping',
    since: Date.now() - 3 * HOUR,
    sleepSessionStartedAt: Date.now() - 3 * HOUR,
    fatigue: 85,
    fatigueAt: Date.now() - 3 * HOUR,
    lastWakeAt: Date.now() - 20 * HOUR,
  })
  const after = m.fatigue.get()
  ok('睡 3 小时后疲惫下降', after < 85, 'got=' + after)
  ok('下降到合理区间(20~60)', after >= 20 && after <= 60, 'got=' + after)
}

console.log('\n═══ 3. 四态转换：卡住的"将醒"被自愈 ═══')
{
  const { m } = seed({
    state: 'recovering',
    since: Date.now() - 50 * MIN,
    recoveringStartedAt: Date.now() - 50 * MIN,
    sleepSessionStartedAt: Date.now() - 10 * HOUR,
    fatigue: 36,
    fatigueAt: Date.now() - 50 * MIN,
    lastWakeAt: Date.now() - 10 * HOUR,
  })
  const s = m.get()
  ok('50 分钟的"将醒"被自愈为清醒', s.state === 'awake', 'state=' + s.state + ' / ' + s.reason)
}

console.log('\n═══ 4. 将醒正常退出（3~40 分钟窗口）═══')
{
  // ⚠️ 新语义：窗口内不该醒。这里显式把窗口设到"远离当前时刻"，
  //    验证「窗口外 + 疲惫已降够 + 将醒满 3 分钟 → 可以回清醒」。
  const nowH = new Date().getHours()
  const farH = (nowH + 8) % 24
  const { m } = seed({
    state: 'recovering',
    since: Date.now() - 5 * MIN,
    recoveringStartedAt: Date.now() - 5 * MIN,
    sleepSessionStartedAt: Date.now() - 8 * HOUR,
    fatigue: 30,
    fatigueAt: Date.now() - 5 * MIN,
    lastWakeAt: Date.now() - 8 * HOUR,
    schedule: {
      auto: true, preferFixedTime: false, fatigueSleep: 70, fatigueWake: 25,
      windows: [{
        name: '远离当前',
        start: String(farH).padStart(2, '0') + ':00',
        end: String((farH + 2) % 24).padStart(2, '0') + ':00',
        type: 'night', enabled: true,
      }],
    },
  })
  const w = m.shouldWake()
  ok('窗口外 + 5 分钟将醒 + 疲惫30 → 可以醒', w.yes === true, 'why=' + w.why)
}

console.log('\n═══ 5. 跨午夜时段判断 ═══')
{
  const { m } = seed()
  const win = { name: '夜间', start: '23:30', end: '08:30', enabled: true }
  const at = (h, mi) => m.inWindowAt(win, new Date(2026, 9, 30, h, mi))
  ok('23:45 在窗口内', at(23, 45).inWindow === true)
  ok('02:00 在窗口内（跨午夜）', at(2, 0).inWindow === true)
  ok('08:20 在窗口内', at(8, 20).inWindow === true)
  ok('08:45 不在窗口内', at(8, 45).inWindow === false)
  ok('15:00 不在窗口内', at(15, 0).inWindow === false)
  ok('23:30 边界在窗口内', at(23, 30).inWindow === true)
}

console.log('\n═══ 6. 同日时段判断（午睡）═══')
{
  const { m } = seed()
  const win = { name: '午睡', start: '13:00', end: '14:00', enabled: true }
  const at = (h, mi) => m.inWindowAt(win, new Date(2026, 9, 30, h, mi))
  ok('13:30 在午睡窗口', at(13, 30).inWindow === true)
  ok('12:50 不在', at(12, 50).inWindow === false)
  ok('14:10 不在', at(14, 10).inWindow === false)
}

console.log('\n═══ 7. 边界与异常保护 ═══')
{
  const { m } = seed()
  m.fatigue.set(999)
  ok('超上限裁到 100', m.fatigue.get() === 100, 'got=' + m.fatigue.get())
  m.fatigue.set(-50)
  ok('负值裁到 0', m.fatigue.get() === 0, 'got=' + m.fatigue.get())
}

console.log('\n═══ 8. 时间倒退不跳变 ═══')
{
  const { m } = seed({ fatigue: 40, fatigueAt: Date.now() + 5 * HOUR })
  const v = m.fatigue.get()
  ok('时间倒退后仍在合法区间', v >= 0 && v <= 100, 'got=' + v)
}

console.log('\n═══ 9. 持久化：重启后恢复 ═══')
{
  const f = newFile()
  const m1 = createSleepManager({ stateFile: f, log: () => {} })
  m1.fatigue.set(64)
  m1.enterPreparing({ reason: '测试入睡' })
  const v1 = m1.fatigue.get()
  const m2 = createSleepManager({ stateFile: f, log: () => {} })
  const s2 = m2.get()
  ok('重启后疲惫值保留', Math.abs(s2.fatigue - v1) < 3, v1 + ' vs ' + s2.fatigue)
  ok('重启后状态保留', s2.state === 'preparing', 'state=' + s2.state)
}

console.log('\n═══ 10. 手动覆盖不打架 ═══')
{
  const { m } = seed({ fatigue: 90, fatigueAt: Date.now(), lastWakeAt: Date.now() - 10 * HOUR })
  m.wake({ reason: '手动叫醒', manual: true })
  const sv = m.shouldSleep()
  ok('手动叫醒后不自动入睡', sv.yes === false, 'why=' + sv.why)
  ok('提示保护期', String(sv.why).indexOf('保护期') >= 0, sv.why)
}

console.log('\n═══ 11. 阈值迟滞 ═══')
{
  const { m } = seed()
  const TH = m.thresholds
  ok('入睡阈值 70', TH.fatigueSleep === 70)
  ok('醒来阈值 25', TH.fatigueWake === 25)
  ok('迟滞带宽 >= 30', TH.fatigueSleep - TH.fatigueWake >= 30,
     'band=' + (TH.fatigueSleep - TH.fatigueWake))
}

console.log('\n═══ 12. 距下次窗口 ═══')
{
  const { m } = seed()
  const wins = [{ start: '23:30', end: '08:30', enabled: true }]
  const ms = m.msUntilNextWindow(wins, new Date(2026, 9, 30, 20, 0))
  ok('20:00 距 23:30 约 3.5h', ms > 3 * HOUR && ms < 4 * HOUR, 'h=' + (ms / HOUR).toFixed(1))
  const ms2 = m.msUntilNextWindow(wins, new Date(2026, 9, 30, 0, 30))
  ok('00:30 距下个窗口约 23h', ms2 > 22 * HOUR && ms2 < 24 * HOUR, 'h=' + (ms2 / HOUR).toFixed(1))
}

console.log('\n═══ 13. 完整四态流转 ═══')
{
  const f = newFile()
  const m = createSleepManager({ stateFile: f, log: () => {} })
  m.fatigue.set(75)
  const s0 = m.get()
  ok('初始清醒', s0.state === 'awake')

  const sv = m.shouldSleep()
  ok('疲惫 75 该睡', sv.yes === true, sv.why)

  m.enterPreparing({ reason: '疲惫到线' })
  ok('进入准备入睡', m.get().state === 'preparing')

  m.enterSleeping({ reason: '过渡完成' })
  ok('进入沉睡', m.get().state === 'sleeping')

  m.enterRecovering({ reason: '该醒了' })
  ok('进入将醒', m.get().state === 'recovering')

  m.wake({ reason: '唤醒完成' })
  ok('回到清醒', m.get().state === 'awake')

  const hist = m.history()
  ok('历史记录了流转', hist.length >= 4, 'n=' + hist.length)
  ok('历史带 reason', hist.every(h => h.reason && h.reason.length > 0))
}

console.log('\n═══ 14. 准备入睡超时自愈 ═══')
{
  const { m } = seed({
    state: 'preparing',
    since: Date.now() - 60 * MIN,
    preparingStartedAt: Date.now() - 60 * MIN,
    lastWakeAt: Date.now() - 14 * HOUR,
    fatigue: 60,
    fatigueAt: Date.now() - 60 * MIN,
  })
  const s = m.get()
  ok('准备入睡 60 分钟后自动进沉睡', s.state === 'sleeping',
     'state=' + s.state + ' / ' + s.reason)
}

console.log('\n────────────────────────────')
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
