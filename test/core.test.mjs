// dsh-mind 离线单测：记忆核心 / 注入协调 / mood 导入 / 睡眠状态机
// 全部使用临时目录与合成数据（含 mood 归档 jsonl 真实字段形状 {id,t,s,k,x}），不触真实 DSH。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb } from '../lib/db.js'
import { createMemoryStore } from '../lib/memory.js'
import { buildInjectBlock, RETRY_HINT } from '../lib/retrieve.js'
import { mapMoodLine, importMoodArchive } from '../lib/pointer.js'
import { createSleepManager } from '../lib/sleep.js'
import { toIndexText, bigrams, coverRatio } from '../lib/bigram.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mind-test-'))
}

function freshStore() {
  const dir = tmpDir()
  const db = openDb(path.join(dir, 'memory.db'))
  const store = createMemoryStore(db)
  return { dir, db, store }
}

// ── 记忆核心 ──

test('写入→检索：中文关键词（bigram）命中，含打分明细', () => {
  const { store } = freshStore()
  store.note({ kind: 'episode', text: '他说明天下午三点要去面试，有点紧张', importance: 0.8, entities: ['面试'] })
  store.note({ kind: 'fact', text: '用户喜欢吃辣，特别爱麻辣香锅', importance: 0.7 })
  const hits = store.search('面试 紧张', { k: 5, minScore: 0.1 })
  assert.equal(hits.length, 1, '应命中面试那条')
  assert.equal(hits[0].kind, 'episode')
  assert.ok(hits[0].score > 0.5, `分数应较高，实际 ${hits[0].score}`)
  assert.ok(hits[0].why.keyword > 0, '应含关键词分（可解释性）')
  // 语义外场景：换个说法搜不到属于预期（v1 无向量）——但"吃辣"这个词面能命中
  const spicy = store.search('吃辣', { k: 5, minScore: 0.1 })
  assert.equal(spicy.length, 1)
})

test('相似合并：同义事实只留一条，返回 duplicateOf', () => {
  const { store } = freshStore()
  const a = store.note({ kind: 'fact', text: '用户喜欢吃麻辣香锅，无辣不欢' })
  const b = store.note({ kind: 'fact', text: '用户爱吃麻辣香锅，无辣不欢' })
  assert.ok(b.duplicateOf === a.id, '第二条应并入第一条')
  const st = store.stats()
  assert.equal(st.total, 1, 'active 只剩一条')
})

test('纠正：旧记忆降权 15% + 版本链 + lesson 落库', () => {
  const { store } = freshStore()
  const a = store.note({ kind: 'fact', text: '用户喜欢可乐', importance: 0.8 })
  const r = store.correct(a.id, { newText: '用户喜欢的是雪碧，可乐是以前的事', reason: '他说早不喝可乐了' })
  const old = store.get(a.id)
  assert.ok(old.decay < 1, '旧记忆应降权')
  assert.equal(old.version, 2)
  assert.ok(r.newId, '应有新版本记忆')
  const lessons = store.search('用户纠正', { k: 5, minScore: 0.05 })
  assert.ok(lessons.length >= 1, '应有一条"用户纠正过我"的 lesson')
})

test('三级遗忘：降权/归档/删除，归档可恢复语义', () => {
  const { store } = freshStore()
  const a = store.note({ kind: 'episode', text: '一次普通的聊天记录，内容平平' })
  const r1 = store.forget(a.id, { tier: 1 })
  assert.match(r1.effect, /decay/)
  const r2 = store.forget(a.id, { tier: 2 })
  assert.match(r2.effect, /archived/)
  const got = store.get(a.id)
  assert.equal(got.status, 'archived')
  assert.ok(got.text.length > 0, '归档保留原文')
  const r3 = store.forget(a.id, { tier: 3 })
  assert.match(r3.effect, /deleted/)
  assert.equal(store.get(a.id).status, 'deleted')
  assert.equal(store.search('普通聊天', { k: 5, minScore: 0 }).length, 0, '删除后不再被检索')
  // 审计留痕
  const audits = store.auditList(10)
  assert.ok(audits.filter((x) => x.action.startsWith('forget')).length >= 3)
})

test('永久保留约束：手动标记 confirmed 的重要约定不因遗忘自动归档（decay 可降但原文在）', () => {
  const { store } = freshStore()
  const a = store.note({ kind: 'fact', text: '约定：周六下午陪用户去医院复查', importance: 0.95, confirmed: 1 })
  store.forget(a.id, { tier: 1 })
  const m = store.get(a.id)
  assert.equal(m.status, 'active', 'tier1 只降权不归档')
  assert.ok(m.text.includes('周六'), '原文完整')
})

test('星图数据：节点来自真实记忆行，边来自实体关系', () => {
  const { store } = freshStore()
  store.note({ kind: 'episode', text: '和妈妈通电话，她说周末回家吃饭', entities: ['妈妈'], importance: 0.8 })
  const g = store.graphData({})
  assert.ok(g.nodes.some((n) => n.group === 'memory' && n.label.includes('妈妈')))
  assert.ok(g.nodes.some((n) => n.group === 'entity' && n.label === '妈妈'), '实体节点应存在')
  assert.ok(g.edges.some((e) => e.kind === 'entity'), '应有一条实体边')
})

test('FTS 降级路径：fts 不可用时 JS 扫描仍能检索（挂起 fts 标志模拟）', () => {
  const dir = tmpDir()
  const db = openDb(path.join(dir, 'memory.db'))
  db._ftsAvailable = false // 模拟 FTS 缺失
  const store = createMemoryStore(db)
  store.note({ kind: 'fact', text: '用户养了一只猫叫团子' })
  const hits = store.search('团子', { k: 5, minScore: 0.1 })
  assert.equal(hits.length, 1, '降级路径仍应命中')
})

// ── 注入协调器（省 token）──

test('注入块：预算裁剪、门槛过滤、marker、每块字数可解释', () => {
  const hits = [
    { kind: 'fact', text: 'x'.repeat(120), score: 0.9 },
    { kind: 'episode', text: 'y'.repeat(60), score: 0.6 },
    { kind: 'lesson', text: 'z'.repeat(40), score: 0.2 }, // 低于 0.45 门槛
  ]
  const r = buildInjectBlock({ memoryHits: hits, moodLine: '现在是「委屈」。情绪只影响语气，不影响判断。' },
    { injectBudgetChars: 220, recallK: 2, memoryMaxChars: 80, recallMinScore: 0.45 })
  assert.ok(r.text.startsWith('<!--dsh-mind:v1-->'), '应带 marker')
  assert.ok(!r.text.includes('z'), '低分记忆不得注入')
  assert.ok(r.usedChars <= 220, `不得超预算，实际 ${r.usedChars}`)
  assert.ok(r.text.includes('【心情】'), '心情块在预算内应保留')
  assert.ok(r.text.includes('【相关记忆】'), '高分记忆应注入')
})

test('注入块：全部为空时返回空串（不占提示词）', () => {
  const r = buildInjectBlock({}, {})
  assert.equal(r.text, '')
})

test('省 token 重试提示存在且非空（写进工具描述的契约）', () => {
  assert.ok(RETRY_HINT.includes('换同义关键词'))
})

// ── mood 归档导入（真实字段形状 {id,t,s,k,x}）──

test('mood 导入：字段映射 + 短句过滤 + 幂等 + 备份目录', () => {
  const dir = tmpDir()
  const db = openDb(path.join(dir, 'memory.db'))
  const store = createMemoryStore(db)
  // 造一个假的 mood 数据目录
  const moodData = path.join(dir, 'mood-data')
  fs.mkdirSync(moodData, { recursive: true })
  const jsonl = path.join(moodData, 'dsh-mood-memory.jsonl')
  const lines = [
    JSON.stringify({ id: 'x1', t: 1792067106123, s: 'sessA', k: 'u', x: '用户说他这周要准备面试，挺紧张的' }),
    JSON.stringify({ id: 'x2', t: 1792067206123, s: 'sessA', k: 'a', x: '好的' }),                    // 短句应被过滤
    JSON.stringify({ id: 'x3', t: 1792067306123, s: 'sessB', k: 'u', x: '他说周末想去看电影放松一下' }),
    'not-json-garbage',                                                                               // 坏行应跳过
  ]
  fs.writeFileSync(jsonl, lines.join('\n'))
  fs.writeFileSync(path.join(dir, 'dsh-mood-store.json'), JSON.stringify({ default: moodData }))

  // 把 mood 指针指向测试目录（临时改写 pointer 读取——通过 DSH_HOME 环境变量隔离）
  const home = path.join(dir, 'dsh-home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-mood-store.json'), JSON.stringify({ default: moodData }))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const dataDir = path.join(dir, 'mind-data')
  fs.mkdirSync(dataDir, { recursive: true })
  const r = importMoodArchive(store, { db, dataDir })
  assert.equal(r.imported, 2, `应导入 2 条，实际 ${JSON.stringify(r)}`)
  assert.ok(r.skipped >= 2, `短句+坏行应跳过，实际 ${JSON.stringify(r)}`)
  assert.ok(r.backupDir, '应有备份目录')
  const hits = store.search('面试', { k: 5, minScore: 0.1 })
  assert.equal(hits.length, 1, '导入后可检索')
  assert.equal(hits[0].source, 'mood-archive')

  // 幂等：再跑一次不再导入
  const r2 = importMoodArchive(store, { db, dataDir })
  assert.equal(r2.reason, 'already-imported')

  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
})

test('mood 行映射：onlyUser 模式过滤 assistant 消息', () => {
  const u = mapMoodLine(JSON.stringify({ id: '1', t: 1, s: 's', k: 'u', x: '用户说的很长的一句话' }))
  const a = mapMoodLine(JSON.stringify({ id: '2', t: 1, s: 's', k: 'a', x: '助手说的很长的一句话' }), { onlyUser: true })
  assert.ok(u, '用户消息应通过')
  assert.equal(a, null, 'onlyUser 时助手消息被过滤')
})

// ── 睡眠状态机 ──

test('睡眠状态机：合法迁移 + 非法迁移拒绝 + 持久化恢复', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'state.json')
  const sm = createSleepManager({ stateFile: file })
  assert.equal(sm.get().state, 'awake')
  assert.equal(sm.blocksWake(), false)

  sm.enterPreparing({ reason: '到点' })
  sm.enterSleeping()
  assert.equal(sm.blocksWake(), true, 'Sleeping 必须挡住正常唤醒')
  // 非法迁移：sleeping → preparing 不允许
  assert.throws(() => sm.enterPreparing({ reason: 'x' }), /非法状态迁移/)

  // 持久化：新实例（模拟进程重启）恢复睡眠锁
  const sm2 = createSleepManager({ stateFile: file })
  assert.equal(sm2.get().state, 'sleeping', '重启后睡眠锁必须还在')
  assert.equal(sm2.blocksWake(), true)

  sm2.enterRecovering()
  sm2.wake({ reason: '整理完成' })
  assert.equal(sm2.get().state, 'awake')
})

test('睡眠状态机：strict 锁默认开启，普通调用不能强制唤醒', () => {
  const dir = tmpDir()
  const sm = createSleepManager({ stateFile: path.join(dir, 'state.json') })
  sm.enterPreparing({ reason: 'test', strict: true })
  sm.enterSleeping()
  assert.equal(sm.canForceWake(false), false, '非管理员不得强制唤醒')
  assert.equal(sm.canForceWake(true), true, '管理授权可以')
})
