/**
 * 验证「作息窗口最高优先级」
 *
 * ⚠️ 构造要点：判定时刻必须用 Date.now()，
 *    否则 advanceFatigue 会按 nowMs - fatigueAt 补算疲惫值，
 *    传未来时间会把疲惫算到 0，测试就失真了。
 *
 *    窗口内/外用**窗口配置**来控制：
 *      · 窗口 00:00-03:00 → 现在（凌晨）落在窗口内
 *      · 窗口 05:00-06:00 → 现在落在窗口外
 */
const ROOT = '../lib'

const { createSleepManager } = await import('../lib/sleep.js')
const { writeFileSync, mkdtempSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')

const MIN = 60000
const HOUR = 3600000
let pass = 0, fail = 0
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n) }
  else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')) }
}

/** 当前时刻落在哪个窗口，由 winStart/winEnd 决定 */
function mk({ fatigue, sleptMin = 60, state = 'sleeping', debtHow = 0,
             winStart = '00:00', winEnd = '03:00', winType = 'night' }) {
  const dir = mkdtempSync(join(tmpdir(), 'winpri-'))
  const f = join(dir, 's.json')
  const now = Date.now()
  const startedAt = now - sleptMin * MIN

  writeFileSync(f, JSON.stringify({
    state,
    since: state === 'recovering' ? now - 10 * MIN : startedAt,
    lastWakeAt: now - 20 * HOUR,
    fatigue,
    fatigueAt: now,                        // 锚在现在 → 不补算
    sleepSessionStartedAt: startedAt,
    recoveringStartedAt: state === 'recovering' ? now - 10 * MIN : null,
    sleepDebt: debtHow,
    schedule: {
      auto: true, preferFixedTime: true,
      fatigueSleep: 70, fatigueSleepMin: 45, fatigueWake: 25,
      windows: [{ name: '测试窗口', start: winStart, end: winEnd, type: winType, enabled: true }],
    },
    history: [],
  }))

  const m = createSleepManager({ stateFile: f, log: () => {} })
  return { m, at: now }
}

/* 现在时刻 */
const nowH = new Date().getHours()
console.log('当前时刻: ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }))

/* 根据当前小时动态选窗口，保证"内"或"外" */
function inWindowCfg() {
  // 覆盖当前小时的前后各 1 小时
  const s = String(Math.max(0, nowH - 1)).padStart(2, '0') + ':00'
  const e = String(Math.min(23, nowH + 2)).padStart(2, '0') + ':00'
  return { winStart: s, winEnd: e }
}
function outWindowCfg() {
  // 明显避开当前小时
  const far = (nowH + 8) % 24
  const s = String(far).padStart(2, '0') + ':00'
  const e = String((far + 2) % 24).padStart(2, '0') + ':00'
  return { winStart: s, winEnd: e }
}

const WIN = inWindowCfg()
const OUT = outWindowCfg()
console.log('窗口内配置: ' + WIN.winStart + '-' + WIN.winEnd)
console.log('窗口外配置: ' + OUT.winStart + '-' + OUT.winEnd + '\n')

/* 先验证配置真的生效 */
{
  const { m, at } = mk(Object.assign({ fatigue: 60 }, WIN))
  const r = m.isNightSleep(at)
  console.log('窗口内判定: ' + r.yes)
  const { m: m2, at: at2 } = mk(Object.assign({ fatigue: 60 }, OUT))
  const r2 = m2.isNightSleep(at2)
  console.log('窗口外判定: ' + r2.yes + '\n')
}

console.log('\n═══ ① 窗口内：疲惫再低也不醒 ═══')
{
  const { m, at } = mk(Object.assign({ fatigue: 15, sleptMin: 30 }, WIN))
  const w = m.shouldWake(at)
  ok('窗口内 + 疲惫15 + 睡30分 → 不醒', w.yes === false, 'why=' + w.why)
  ok('原因提到窗口', String(w.why).includes('窗口'), w.why)
}

console.log('\n═══ ② 窗口内睡满90分钟也不醒 ═══')
{
  const { m, at } = mk(Object.assign({ fatigue: 20, sleptMin: 100 }, WIN))
  const w = m.shouldWake(at)
  ok('窗口内 + 睡100分 → 不醒', w.yes === false, 'why=' + w.why)
}

console.log('\n═══ ③ 安全网：超12小时必须醒 ═══')
{
  const { m, at } = mk(Object.assign({ fatigue: 10, sleptMin: 13 * 60 }, OUT))
  const w = m.shouldWake(at)
  ok('睡13小时 → 醒', w.yes === true, 'why=' + w.why)
}

console.log('\n═══ ④ 窗口外 + 疲惫低 → 醒 ═══')
{
  const { m, at } = mk(Object.assign({ fatigue: 20, sleptMin: 50 }, OUT))
  const w = m.shouldWake(at)
  ok('窗口外 + 疲惫20 + 睡50分 → 醒', w.yes === true, 'why=' + w.why)
}

console.log('\n═══ ⑤ 窗口外 + 疲惫高 → 继续睡 ═══')
{
  const { m, at } = mk(Object.assign({ fatigue: 55, sleptMin: 50 }, OUT))
  const w = m.shouldWake(at)
  ok('窗口外 + 疲惫55 + 睡50分 → 不醒', w.yes === false, 'why=' + w.why)
}

console.log('\n═══ ⑥ 窗口外 + 睡满90分 + 疲惫高 → 按时长醒 ═══')
{
  const { m, at } = mk(Object.assign({ fatigue: 60, sleptMin: 100 }, OUT))
  const w = m.shouldWake(at)
  ok('窗口外 + 睡100分 + 疲惫60 → 醒', w.yes === true, 'why=' + w.why)
  ok('原因提到常规时长', String(w.why).includes('常规时长'), w.why)
}

console.log('\n═══ ⑦ 将醒在窗口内 → inWindow=true ═══')
{
  const { m, at } = mk(Object.assign({ fatigue: 30, sleptMin: 60, state: 'recovering' }, WIN))
  const w = m.shouldWake(at)
  ok('将醒 + 窗口内 → 不醒', w.yes === false, 'why=' + w.why)
  ok('返回 inWindow=true', w.inWindow === true, 'inWindow=' + w.inWindow)
}

console.log('\n═══ ⑧ 睡眠债放宽醒来阈值 ═══')
{
  const a = mk(Object.assign({ fatigue: 35, sleptMin: 60, debtHow: 0 }, OUT))
  const wn = a.m.shouldWake(a.at)
  ok('债0 + 疲惫35 → 不醒（阈值25）', wn.yes === false, 'why=' + wn.why)

  const b = mk(Object.assign({ fatigue: 35, sleptMin: 60, debtHow: 100 }, OUT))
  const wd = b.m.shouldWake(b.at)
  ok('债100 + 疲惫35 → 醒（阈值40）', wd.yes === true, 'why=' + wd.why)
}

console.log('\n════════════════════════════')
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
