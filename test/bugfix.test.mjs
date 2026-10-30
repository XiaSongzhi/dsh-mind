/**
 * 回归测试：修两个真实 bug
 *
 * Bug 1：整理完成直接结束睡眠（睡眠只 7 分钟）
 * Bug 2：将醒 3 分钟必醒，疲惫值没降够（fatigue 67 就醒了）
 */
const LIB = '../lib'

const { createSleepManager } = await import(LIB + '/sleep.js')
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

/** 生成一个远离当前小时的窗口（保证测试时不在窗口内） */
function farStart() {
  const h = (new Date().getHours() + 8) % 24
  return String(h).padStart(2, '0') + ':00'
}
function farEnd() {
  const h = (new Date().getHours() + 10) % 24
  return String(h).padStart(2, '0') + ':00'
}

function seed(o) {
  const dir = mkdtempSync(join(tmpdir(), 'bugfix-'))
  const f = join(dir, 's.json')
  const base = {
    state: 'sleeping',
    since: Date.now(),
    lastWakeAt: Date.now() - 16 * HOUR,
    fatigue: 70,
    fatigueAt: Date.now(),
    sleepSessionStartedAt: null,
    recoveringStartedAt: null,
    sleepDebt: 0,
    schedule: {
      auto: true, preferFixedTime: false,
      fatigueSleep: 70, fatigueWake: 25,
      // ⚠️ 窗口必须远离"当前时刻"，否则凌晨跑测试会落在窗口内，
      //    而窗口内是不该醒的 —— 那样就测不到疲惫/时长条件了。
      windows: [{ name: '远离当前', start: farStart(), end: farEnd(), type: 'night', enabled: true }],
    },
    history: [],
  }
  writeFileSync(f, JSON.stringify(Object.assign(base, o)))
  return createSleepManager({ stateFile: f, log: () => {} })
}

console.log('\n═══ Bug 2：将醒不该 3 分钟就醒 ═══')
{
  // 场景：睡了 10 分钟，刚进将醒 3 分钟，疲惫 68（远未到 25）
  const m = seed({
    state: 'recovering',
    recoveringStartedAt: Date.now() - 3 * MIN,
    sleepSessionStartedAt: Date.now() - 10 * MIN,
    fatigue: 68,
    fatigueAt: Date.now() - 3 * MIN,
  })
  const w = m.shouldWake()
  ok('疲惫 68 + 睡 10 分钟 + 将醒 3 分钟 → 不该醒',
    w.yes === false, 'why=' + w.why)
}

console.log('\n═══ Bug 2b：睡够常规时长才该醒 ═══')
{
  const m = seed({
    state: 'recovering',
    recoveringStartedAt: Date.now() - 10 * MIN,
    sleepSessionStartedAt: Date.now() - 100 * MIN,   // 睡满 100 分钟 > 90
    fatigue: 40,
    fatigueAt: Date.now() - 10 * MIN,
  })
  const w = m.shouldWake()
  ok('睡满 100 分钟（>90 常规）→ 该醒', w.yes === true, 'why=' + w.why)
  ok('原因含"常规时长"', String(w.why).includes('常规时长'), w.why)
}

console.log('\n═══ Bug 2c：疲惫降到阈值该醒 ═══')
{
  const m = seed({
    state: 'recovering',
    recoveringStartedAt: Date.now() - 5 * MIN,
    sleepSessionStartedAt: Date.now() - 120 * MIN,
    fatigue: 20,
    fatigueAt: Date.now() - 5 * MIN,
  })
  const w = m.shouldWake()
  ok('疲惫 20（<25 阈值）→ 该醒', w.yes === true, 'why=' + w.why)
  ok('原因含"疲惫值已降到"', String(w.why).includes('疲惫值已降到'), w.why)
}

console.log('\n═══ Bug 2d：将醒超时兜底仍有效（selfHeal 直接重置为清醒）═══')
{
  // ⚠️ 注意语义：selfHeal 在**读取时**就把超时的 recovering 重置为 awake，
  //    所以 shouldWake 看到的是"已清醒"，返回"当前不在睡眠中" —— 这是对的。
  //    测试要验证的是"状态确实被兜底救回来了"，而不是 shouldWake 说 yes。
  const m = seed({
    state: 'recovering',
    recoveringStartedAt: Date.now() - 45 * MIN,     // 超过 40 分钟上限
    sleepSessionStartedAt: Date.now() - 60 * MIN,
    fatigue: 60,
    fatigueAt: Date.now() - 45 * MIN,
  })
  const st = m.get()
  ok('将醒 45 分钟（>40 上限）→ 状态已兜底为 awake',
    st.state === 'awake', 'state=' + st.state)
  ok('原因记录了"将醒超时"',
    String(st.reason).includes('将醒超时'), 'reason=' + st.reason)
}

console.log('\n═══ Bug 2e：最短缓冲内不醒 ═══')
{
  const m = seed({
    state: 'recovering',
    recoveringStartedAt: Date.now() - 1 * MIN,      // 才 1 分钟
    sleepSessionStartedAt: Date.now() - 200 * MIN,  // 已睡 200 分钟
    fatigue: 30,
    fatigueAt: Date.now() - 1 * MIN,
  })
  const w = m.shouldWake()
  ok('将醒 1 分钟（<3 缓冲）→ 不醒', w.yes === false, 'why=' + w.why)
  ok('给出了拒绝原因（说明为什么还没醒）',
    String(w.why).length > 0 && String(w.why).includes('睡'), w.why)
}

console.log('\n═══ Bug 1：整理完成不该结束睡眠 ═══')
{
  // 模拟：睡眠中，整理器 tick 完成（done）
  const m = seed({
    state: 'sleeping',
    sleepSessionStartedAt: Date.now() - 7 * MIN,   // 只睡 7 分钟
    fatigue: 68,
    fatigueAt: Date.now() - 7 * MIN,
  })
  const before = m.get().state
  ok('整理完成前状态是 sleeping', before === 'sleeping', before)

  // 关键：整理完成不应改变状态（现在只在 consolidate 里 return { done:true }）
  // 这里验证 shouldWake 不会因为"整理完成"而说 yes
  const w = m.shouldWake()
  ok('睡 7 分钟 + 疲惫 68 → 不该醒（整理完成也不影响）',
    w.yes === false, 'why=' + w.why)

  const after = m.get().state
  ok('状态仍是 sleeping', after === 'sleeping', after)
}

console.log('\n═══ 修复前的场景复现（应不再发生）═══')
{
  // 复现用户看到的现象：疲惫 70 入睡 → 7 分钟后整理完成 → 疲惫 68 就醒了
  const m = seed({
    state: 'sleeping',
    sleepSessionStartedAt: Date.now() - 7 * MIN,
    fatigue: 68,
    fatigueAt: Date.now() - 7 * MIN,
  })

  let woke = false
  for (let i = 0; i < 5; i++) {
    if (m.shouldWake().yes) { woke = true; break }
  }
  ok('连续 5 次检查都不会"7 分钟就醒"', woke === false,
    woke ? '仍会醒' : '')
}

console.log('\n═══ 正常长睡眠仍能醒 ═══')
{
  // 睡 9 小时，疲惫降到 20 → 应该醒
  const m = seed({
    state: 'sleeping',
    sleepSessionStartedAt: Date.now() - 9 * HOUR,
    fatigue: 20,
    fatigueAt: Date.now() - 1 * MIN,
    lastWakeAt: Date.now() - 25 * HOUR,
  })
  const w = m.shouldWake()
  ok('睡 9 小时 + 疲惫 20 → 该醒', w.yes === true, 'why=' + w.why)
}

console.log('\n────────────────────────────')
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
