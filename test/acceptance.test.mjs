// test/acceptance.test.mjs —— 通用验收用例
//
// 只测本仓库自己实现的边界：记忆写入/检索/删除、睡眠四态自愈、
// 数据库迁移。不依赖任何外部服务。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { openDb } from '../lib/db.js'
import { createMemoryStore } from '../lib/memory.js'
import { createSleepManager } from '../lib/sleep.js'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dshmind-'))
  const db = openDb(join(dir, 'memory.db'))
  const store = createMemoryStore(db, { log: () => {} })
  return { dir, db, store }
}

function freshSleep(overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsleep-'))
  const f = join(dir, 'state.json')
  if (overrides) writeJson(f, overrides)
  return createSleepManager({ stateFile: f, log: () => {} })
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2))
}

/* ═══════ 记忆 ═══════ */

test('记忆：写入后可按关键词检索', () => {
  const { store } = freshStore()
  store.note({ kind: 'episode', text: '今天去买了工学椅，腰有点酸', source: 'test' })
  const hits = store.search('工学椅', { k: 5, minScore: 0.2 })
  assert.ok(hits.length > 0, '应能检索到刚写入的记忆')
  assert.ok(String(hits[0].text).includes('工学椅'))
})

test('记忆：fact 类型相同内容会被合并而不是重复堆积', () => {
  const { store } = freshStore()
  // ⚠️ 去重只对 fact / lesson 这类"长期重复"的类型生效，
  //    episode 故意允许重复（同一件事可以发生多次）。
  const a = store.note({ kind: 'fact', text: '用户的生日是 10 月 29 日', source: 'test' })
  const b = store.note({ kind: 'fact', text: '用户的生日是 10 月 29 日', source: 'test' })
  assert.ok(b.duplicateOf, '第二条应被识别为重复并合并')
  assert.equal(store.stats().total, 1, '库里应只有一条')
})

test('记忆：物理删除会真正移除行与索引', () => {
  const { store } = freshStore()
  const r = store.note({ kind: 'episode', text: '这条将被彻底删除', source: 'test' })
  const before = store.stats().total
  store.purge(r.id, { reason: '测试' })
  const after = store.stats().total
  assert.equal(after, before - 1, '总数应减少 1')
  assert.ok(!store.get(r.id), '按 id 应取不到')
  const hits = store.search('彻底删除', { k: 5, minScore: 0.2 })
  assert.ok(!hits.some((h) => h.id === r.id), 'FTS 索引也应清掉')
})

test('记忆：降权只减半不删除', () => {
  const { store } = freshStore()
  const r = store.note({ kind: 'episode', text: '降权测试', importance: 0.8, source: 'test' })
  store.forget(r.id, { tier: 1 })
  const m = store.get(r.id)
  assert.ok(m, '降权后行仍在')
  assert.ok(m.decay < 1, 'decay 应被减半')
})

/* ═══════ 睡眠 ═══════ */

test('睡眠：疲惫值随真实时间推进', () => {
  const HOUR = 3600000
  const m = freshSleep({
    state: 'awake',
    since: Date.now(),
    fatigue: 30,
    fatigueAt: Date.now() - 6 * HOUR,
    lastWakeAt: Date.now() - 6 * HOUR,
    sleepDebt: 0,
    schedule: { auto: true, fatigueSleep: 70, fatigueWake: 25, windows: [] },
    history: [],
  })
  const v = m.fatigue.get()
  assert.ok(v > 30, '6 小时后疲惫值应上升，实际 ' + v)
  assert.ok(v <= 100, '不超过上限')
})

test('睡眠：睡眠期间疲惫值下降', () => {
  const HOUR = 3600000
  const m = freshSleep({
    state: 'sleeping',
    since: Date.now() - 3 * HOUR,
    sleepSessionStartedAt: Date.now() - 3 * HOUR,
    fatigue: 85,
    fatigueAt: Date.now() - 3 * HOUR,
    lastWakeAt: Date.now() - 20 * HOUR,
    sleepDebt: 0,
    schedule: { auto: true, fatigueSleep: 70, fatigueWake: 25, windows: [] },
    history: [],
  })
  const v = m.fatigue.get()
  assert.ok(v < 85, '睡 3 小时后应下降，实际 ' + v)
})

test('睡眠：卡住的 recovering 会被自愈为 awake', () => {
  const MIN = 60000
  const m = freshSleep({
    state: 'recovering',
    since: Date.now() - 50 * MIN,
    recoveringStartedAt: Date.now() - 50 * MIN,
    sleepSessionStartedAt: Date.now() - 10 * 3600000,
    fatigue: 36,
    fatigueAt: Date.now() - 50 * MIN,
    lastWakeAt: Date.now() - 10 * 3600000,
    sleepDebt: 0,
    schedule: { auto: true, fatigueSleep: 70, fatigueWake: 25, windows: [] },
    history: [],
  })
  const s = m.get()
  assert.equal(s.state, 'awake', '超过 40 分钟的上限应自动恢复清醒')
})

test('睡眠：跨午夜时段判断正确', () => {
  const m = freshSleep({
    state: 'awake', since: Date.now(), fatigue: 30, fatigueAt: Date.now(),
    lastWakeAt: Date.now(), sleepDebt: 0,
    schedule: { auto: true, fatigueSleep: 70, fatigueWake: 25, windows: [] },
    history: [],
  })
  const win = { name: '夜间', start: '23:30', end: '08:30', enabled: true }
  const at = (h, mi) => m.inWindowAt(win, new Date(2026, 0, 2, h, mi))

  assert.equal(at(23, 45).inWindow, true, '23:45 应在内')
  assert.equal(at(2, 0).inWindow, true, '02:00 应在内（跨午夜）')
  assert.equal(at(8, 20).inWindow, true, '08:20 应在内')
  assert.equal(at(8, 45).inWindow, false, '08:45 应已结束')
  assert.equal(at(15, 0).inWindow, false, '15:00 不应在内')
})

test('睡眠：四态可完整流转', () => {
  const m = freshSleep()
  m.fatigue.set(75)
  assert.equal(m.get().state, 'awake')

  const sv = m.shouldSleep()
  assert.equal(sv.yes, true, '疲惫 75 应该想睡')

  m.enterPreparing({ reason: '疲惫到线' })
  assert.equal(m.get().state, 'preparing')

  m.enterSleeping({ reason: '过渡完成' })
  assert.equal(m.get().state, 'sleeping')

  m.enterRecovering({ reason: '该醒了' })
  assert.equal(m.get().state, 'recovering')

  m.wake({ reason: '唤醒完成' })
  assert.equal(m.get().state, 'awake')
})

test('睡眠：手动叫醒后会进入保护期，不立即自动入睡', () => {
  const m = freshSleep()
  m.fatigue.set(90)
  m.wake({ reason: '手动叫醒', manual: true })
  const sv = m.shouldSleep()
  assert.equal(sv.yes, false, '保护期内不应自动入睡')
  assert.ok(String(sv.why).includes('保护期'))
})

test('睡眠：疲惫值被裁剪到 0~100', () => {
  const m = freshSleep()
  m.fatigue.set(999)
  assert.equal(m.fatigue.get(), 100)
  m.fatigue.set(-50)
  assert.equal(m.fatigue.get(), 0)
})
