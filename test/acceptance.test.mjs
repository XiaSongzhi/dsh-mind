// dsh-mind 验收测试（PRD 第十三节的十五条 → 离线可测的逐条映射）
// 活体项（需要真实 DSH 运行 + QQ 交互）标记为「活体待测」，不伪造结果。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb, ftsRebuild } from '../lib/db.js'
import { createMemoryStore } from '../lib/memory.js'
import { buildInjectBlock } from '../lib/retrieve.js'
import { createSleepManager } from '../lib/sleep.js'
import { createConsolidator } from '../lib/consolidate.js'
import { toIndexText } from '../lib/bigram.js'

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mind-acc-')) }
function fresh() {
  const dir = tmp()
  const db = openDb(path.join(dir, 'memory.db'))
  const store = createMemoryStore(db)
  return { dir, db, store }
}

test('验收1 重复事件识别并关联原记忆', () => {
  const { store } = fresh()
  const a = store.note({ kind: 'fact', text: '用户每周三晚上要开会' })
  const b = store.note({ kind: 'fact', text: '用户每周三晚要开会，记得提醒' })
  assert.ok(b.duplicateOf === a.id, '重复事实应并入原记忆')
})

test('验收2 纠正后保留来源并更新当前有效结论', () => {
  const { store } = fresh()
  const a = store.note({ kind: 'fact', text: '用户喜欢可乐', source: 'conversation' })
  const r = store.correct(a.id, { newText: '用户现在喜欢雪碧' })
  const oldM = store.get(a.id), newM = store.get(r.newId)
  assert.equal(oldM.source, 'conversation', '旧记忆来源保留')
  assert.equal(newM.text, '用户现在喜欢雪碧', '当前有效结论已更新')
  assert.equal(newM.source, 'user-correction')
})

test('验收3 重启（库重开）后仍能检索历史记忆', () => {
  const dir = tmp()
  const f = path.join(dir, 'memory.db')
  const s1 = createMemoryStore(openDb(f))
  s1.note({ kind: 'episode', text: '他约了周五下午三点在图书馆见面' })
  // 模拟进程重启：重新打开同一个文件
  const s2 = createMemoryStore(openDb(f))
  const hits = s2.search('图书馆 见面', { k: 5, minScore: 0.1 })
  assert.equal(hits.length, 1, '重启后跨库检索应命中')
})

test('验收4 人名/时间/约定可关键词召回', () => {
  const { store } = fresh()
  store.note({ kind: 'episode', text: '和林小雨约好周六 14:00 在市中心咖啡店碰头' })
  for (const q of ['林小雨', '周六', '咖啡店', '14:00']) {
    const h = store.search(q, { k: 5, minScore: 0.05 })
    assert.ok(h.length >= 1, `「${q}」应能召回`)
  }
})

test('验收5 无关历史不进提示词（注入块为空/不超预算）', () => {
  const { store } = fresh()
  store.note({ kind: 'episode', text: '他聊了很久关于钓鱼竿的选择' })
  const hits = store.search('装修风格', { k: 2, minScore: 0.45 })
  const r = buildInjectBlock({ memoryHits: hits }, { injectBudgetChars: 1000 })
  assert.equal(r.text, '', '无关查询不得注入任何记忆')
})

test('验收6 情绪连续性（引擎侧）', () => {
  // mood 引擎按原样 vendored——情绪连续性由其既有行为保证。
  // 离线可测部分：情绪变化流水表的写入接口存在。
  const { store, db } = fresh()
  db.prepare('INSERT INTO emotions(t, mood_id, mood_label, intensity, trigger, source) VALUES (?,?,?,?,?,?)')
    .run(Date.now(), 'angry', '生气', 0.6, '被误解', 'user-stated')
  const row = db.prepare('SELECT * FROM emotions ORDER BY t DESC').get()
  assert.equal(row.mood_id, 'angry')
  // 活体待测：连续对话下心情的平滑变化（mood 引擎自身行为，未改动）
})

test('验收7 用户偏好与 AI 自身偏好分轨可追溯', () => {
  const { db } = fresh()
  const ins = db.prepare('INSERT INTO preferences(subject,domain,text,confidence,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  ins.run('user', 'food', '用户爱吃辣', 0.9, 'user-stated', Date.now(), Date.now())
  ins.run('self', 'design', '我更喜欢暗色系界面', 0.4, 'inference', Date.now(), Date.now())
  const user = db.prepare("SELECT * FROM preferences WHERE subject='user'").all()
  const self = db.prepare("SELECT * FROM preferences WHERE subject='self'").all()
  assert.equal(user.length, 1); assert.equal(self.length, 1)
  assert.equal(user[0].source, 'user-stated'); assert.equal(self[0].source, 'inference')
})

test('验收8 星图数据来自真实库（非静态装饰）', () => {
  const { store } = fresh()
  const before = store.graphData({}).nodes.length
  store.note({ kind: 'episode', text: '和王教授讨论了论文选题', entities: ['王教授'], importance: 0.85 })
  const after = store.graphData({}).nodes.length
  assert.ok(after > before, '写入新记忆后星图节点必须增加')
  assert.ok(store.graphData({}).edges.some((e) => e.kind === 'entity'))
})

test('验收9 到点进入睡眠锁定（手动模式，状态机）', () => {
  const dir = tmp()
  const sm = createSleepManager({ stateFile: path.join(dir, 'state.json') })
  sm.enterPreparing({ reason: '作息到点' })
  sm.enterSleeping()
  assert.equal(sm.get().state, 'sleeping')
})

test('验收10 睡眠锁在消息链路生效（桥接插桩代码就位）+ SnowLuma 无自主应答', () => {
  // 代码就位检查：bridge.js 必须在 sendWakePromptV2 与 scheduleProactiveCheckV2 有闸门
  const bridgePath = process.env.QQ_BRIDGE_SRC || path.join(os.homedir(), 'Documents', 'qq-bridge', 'src', 'bridge.js')
  const bridge = fs.readFileSync(bridgePath, 'utf8')
  assert.ok(bridge.includes('mindSleepLockActive()'), 'sendWakePromptV2 投递入口必须有锁')
  assert.ok(bridge.includes('dsh-mind 睡眠锁：睡眠期间不做主动检查'), 'proactive 必须有锁')
  assert.ok(bridge.includes("mindStatePath: ''"), '配置字段必须存在')
  // SnowLuma 无自动回复（审计已证 0 匹配）；活体端到端：待测
})

test('验收11 整理异常时原始记忆安全、任务可恢复', () => {
  const dir = tmp()
  const db = openDb(path.join(dir, 'memory.db'))
  const store = createMemoryStore(db)
  const a = store.note({ kind: 'episode', text: '重要的原始记忆，不能被整理弄丢', confirmed: 1 })
  const sleep = createSleepManager({ stateFile: path.join(dir, 'state.json') })
  sleep.enterPreparing({ reason: 'x' }); sleep.enterSleeping()
  const cons = createConsolidator({ db, store, sleep, getSessionCtl: () => null })
  // LLM 步在无 sessionCtl 时必须"延后不阻塞、不动数据"
  const r = cons.tick(null)
  assert.ok(r.step === 1 || r.done || r.note, 'tick 应正常推进或明确延后')
  assert.equal(store.get(a.id).text, '重要的原始记忆，不能被整理弄丢', '原始记忆完好')
  // 本地步全推：到 forget-mark 也不得动 confirmed 记忆
  let guard = 0
  while (sleep.get().state === 'sleeping' && guard++ < 15) {
    const t = cons.tick(null)
    if (t.done) break
  }
  assert.equal(store.get(a.id).status, 'active', 'confirmed 记忆不得被自动归档')
  assert.equal(store.get(a.id).text.includes('不能被整理弄丢'), true)
})

test('验收12 苏醒后解除锁定', () => {
  const dir = tmp()
  const sleep = createSleepManager({ stateFile: path.join(dir, 'state.json') })
  sleep.enterPreparing({}); sleep.enterSleeping(); sleep.enterRecovering(); sleep.wake({})
  assert.equal(sleep.get().state, 'awake')
  assert.equal(sleep.blocksWake(), false)
})

test('验收13 索引与主库不一致可检测并重建', () => {
  const dir = tmp()
  const db = openDb(path.join(dir, 'memory.db'))
  const store = createMemoryStore(db)
  for (let i = 0; i < 5; i++) store.note({ kind: 'fact', text: `一致性校验样本记忆第 ${i} 条，关于蓝牙耳机` })
  // 人为破坏 FTS
  db.exec('DELETE FROM memories_fts')
  let broken = db.prepare('SELECT COUNT(*) n FROM memories_fts').get().n
  assert.equal(broken, 0)
  const r = ftsRebuild(db, toIndexText)
  assert.equal(r.ok, true); assert.equal(r.rebuilt, 5)
  broken = db.prepare('SELECT COUNT(*) n FROM memories_fts').get().n
  assert.equal(broken, 5, '重建后索引恢复')
})

test('验收14 治理全留审计日志', () => {
  const { store } = fresh()
  const a = store.note({ kind: 'fact', text: '待治理的记忆' })
  store.correct(a.id, { newText: '治理后的记忆' })
  store.forget(a.id, { tier: 2, reason: 'test' })
  const logs = store.auditList(20).map((x) => x.action)
  assert.ok(logs.includes('correct')); assert.ok(logs.includes('forget-archive'))
})

test('验收15 重启与重复导入不产生大面积重复', () => {
  const dir = tmp()
  const db = openDb(path.join(dir, 'memory.db'))
  const store = createMemoryStore(db)
  // 同一条重复写 5 次（模拟重复消息/重复任务）
  for (let i = 0; i < 5; i++) store.note({ kind: 'fact', text: '用户最喜欢的动画是瑞克和莫蒂，一集不落' })
  const st = store.stats()
  assert.equal(st.total, 1, '相似合并应把 5 次重复收敛为 1 条')
})

test('PRD 预算：注入总预算默认 3500 字（用户指定：mood 基础上调 500）', async () => {
  process.env.DSH_HOME = tmp()
  const { apply } = await import('../index.js')
  const ctx = { get() { return { register() {} } }, effect(fn) { fn() }, systemPrompt: { section() {} } }
  const api = apply(ctx, { dataDir: path.join(tmp(), 'mind') })
  assert.equal(api.cfg.injectBudgetChars, 3500)
  assert.equal(api.cfg.inject, false, '灰度默认关')
})
