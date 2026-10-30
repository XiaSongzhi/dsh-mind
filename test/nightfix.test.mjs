/**
 * 验证原项目的 4 项修复
 */
const P = '../lib'

const { createSleepManager } = await import(P + '/sleep.js')
const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')

const MIN = 60000
const HOUR = 3600000
let pass = 0, fail = 0
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n) }
  else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')) }
}

function seed(o) {
  const dir = mkdtempSync(join(tmpdir(), 'origfix-'))
  const f = join(dir, 's.json')
  const base = {
    state: 'awake', since: Date.now(),
    lastWakeAt: Date.now() - 16 * HOUR,
    fatigue: 66, fatigueAt: Date.now(),
    sleepSessionStartedAt: null, recoveringStartedAt: null, sleepDebt: 0,
    schedule: {
      auto: true, preferFixedTime: false,
      fatigueSleep: 70, fatigueSleepMin: 45, fatigueWake: 25,
      windows: [
        { name: '夜间睡眠', start: '23:30', end: '08:30', type: 'night', enabled: true },
        { name: '午睡', start: '13:00', end: '14:00', type: 'nap', enabled: true },
      ],
    },
    history: [],
  }
  writeFileSync(f, JSON.stringify(Object.assign(base, o)))
  return createSleepManager({ stateFile: f, log: () => {} })
}

/* 构造一个"当前在夜间窗口内"的时间点（今天 23:45 → 用 now 前推到夜里） */
function nightNow() {
  const d = new Date()
  d.setHours(23, 45, 0, 0)   // 今天 23:45
  return d.getTime()
}

console.log('\n═══ 修复1：fatigueSleepMin 不再 undefined ═══')
{
  const m = seed({})
  const cfg = m.schedule.get()
  ok('fatigueSleepMin 有值', typeof cfg.fatigueSleepMin === 'number', String(cfg.fatigueSleepMin))
  ok('值是 45', cfg.fatigueSleepMin === 45, String(cfg.fatigueSleepMin))

  // 在夜间窗口内、疲惫 66（>= 45 但 < 70）→ 应该睡
  const nt = nightNow()
  const v = m.shouldSleep(nt)
  ok('夜间窗口内 + 疲惫 66 → 该睡（修复前会卡在 undefined）',
    v.yes === true, 'why=' + v.why)
}

console.log('\n═══ 修复2+3：整理完成不结束睡眠、将醒需真条件 ═══')
{
  const m = seed({
    state: 'recovering',
    recoveringStartedAt: Date.now() - 5 * MIN,
    sleepSessionStartedAt: Date.now() - 10 * MIN,   // 只睡 10 分钟
    fatigue: 67,
    fatigueAt: Date.now() - 5 * MIN,
  })
  const w = m.shouldWake()
  ok('疲惫 67 + 睡 10 分钟 + 将醒 5 分钟 → 不醒',
    w.yes === false, 'why=' + w.why)
}

{
  // ⚠️ 新语义：窗口内不醒。这里把窗口挪到当前时刻之外，
  //    验证「窗口外 + 睡满常规时长 → 该醒」。
  const nowH = new Date().getHours()
  const farH = (nowH + 8) % 24
  const m = seed({
    state: 'recovering',
    recoveringStartedAt: Date.now() - 10 * MIN,
    sleepSessionStartedAt: Date.now() - 100 * MIN,  // 睡满 100 分钟
    fatigue: 40,
    fatigueAt: Date.now() - 10 * MIN,
    schedule: {
      auto: true, preferFixedTime: true,
      fatigueSleep: 70, fatigueSleepMin: 45, fatigueWake: 25,
      windows: [{ name: '远离当前', start: String(farH).padStart(2,'0') + ':00',
        end: String((farH + 2) % 24).padStart(2,'0') + ':00', type: 'night', enabled: true }],
    },
  })
  const w = m.shouldWake()
  ok('窗口外 + 睡满 100 分钟 → 该醒', w.yes === true, 'why=' + w.why)
}

console.log('\n═══ 修复4：只有夜间睡眠才整理 ═══')
{
  // 夜间窗口内
  const m = seed({})
  const d1 = new Date()
  d1.setHours(23, 45, 0, 0)
  const n1 = m.isNightSleep(d1.getTime())
  ok('23:45 → 是夜间睡眠', n1.yes === true, JSON.stringify(n1.window && n1.window.name))

  // 凌晨 3 点也在夜间窗口（23:30→08:30 跨午夜）
  const d2 = new Date()
  d2.setHours(3, 0, 0, 0)
  const n2 = m.isNightSleep(d2.getTime())
  ok('03:00 → 仍是夜间睡眠（跨午夜）', n2.yes === true, String(n2.yes))

  // 午睡时段 13:30 → 不是夜间
  const d3 = new Date()
  d3.setHours(13, 30, 0, 0)
  const n3 = m.isNightSleep(d3.getTime())
  ok('13:30 午睡 → 不是夜间睡眠（不整理）', n3.yes === false, String(n3.yes))

  // 傍晚 18:00（不在任何窗口）→ 不是
  const d4 = new Date()
  d4.setHours(18, 0, 0, 0)
  const n4 = m.isNightSleep(d4.getTime())
  ok('18:00 → 不是夜间睡眠', n4.yes === false, String(n4.yes))
}

console.log('\n═══ 回归：正常长睡眠仍能醒 ═══')
{
  const nowH = new Date().getHours()
  const farH = (nowH + 8) % 24
  const m = seed({
    state: 'recovering',
    recoveringStartedAt: Date.now() - 3 * MIN,
    sleepSessionStartedAt: Date.now() - 9 * HOUR,
    fatigue: 20, fatigueAt: Date.now() - 3 * MIN,
    lastWakeAt: Date.now() - 25 * HOUR,
    schedule: {
      auto: true, preferFixedTime: true,
      fatigueSleep: 70, fatigueSleepMin: 45, fatigueWake: 25,
      windows: [{ name: '远离当前', start: String(farH).padStart(2,'0') + ':00',
        end: String((farH + 2) % 24).padStart(2,'0') + ':00', type: 'night', enabled: true }],
    },
  })
  const w = m.shouldWake()
  ok('窗口外 + 睡 9 小时 + 疲惫 20 → 该醒', w.yes === true, 'why=' + w.why)
}

console.log('\n════════════════════════════')
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
