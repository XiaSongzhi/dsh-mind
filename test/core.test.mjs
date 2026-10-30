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

// ── 回归：整理器必须能真正走完 13 步（线上曾卡死 5 小时的死锁）──
//
// 根因回顾：consolidate.saveProgress() 只调 sleep.setCheckpoint()，而 setCheckpoint
// 当时只写 st.checkpoint、不写 st.task.step。loadProgress() 读的是 task.step，
// 于是永远停在 0 —— 每次 tick 重复执行第 1 步，13 步永不完成，state 永远 sleeping。
// 这个测试专门盯死"tick 能推进游标"，防止同类死锁再被 32/32 全绿掩盖。

test('整理器：连续 tick 能走完 13 步，且不改变睡眠状态（防死锁回归）', async () => {
  // ⚠️ 语义变更（2026-10-31）：
  //    原用例断言"走完 13 步应迁到 recovering"，但那正是被修复的 bug
  //    —— 整理完成会强行结束睡眠（只睡 7 分钟就被拉去将醒）。
  //    正确语义：整理完成只标记 done，睡眠状态由 shouldWake() 决定。
  const { createConsolidator } = await import('../lib/consolidate.js')
  const { db, store } = freshStore()
  const sm = createSleepManager({ stateFile: path.join(tmpDir(), 'state.json') })
  sm.enterPreparing({ reason: 'test' })
  sm.enterSleeping()

  // sessionCtl 缺席：LLM 步会返回 ok=false，但失败 3 次后按设计"跳过继续"
  const consolidator = createConsolidator({ db, store, sleep: sm, getSessionCtl: () => null })

  let ticks = 0
  let last = null
  let doneAt = 0
  while (ticks < 200) {
    last = await consolidator.tick(null)
    ticks += 1
    // 游标必须真的在推进
    if (ticks > 1 && last && last.step) {
      assert.ok(last.step >= 1, `第 ${ticks} 拍应已推进到某一步，实际 ${last.step}`)
    }
    if (last && last.done === true) { doneAt = ticks; break }
  }

  assert.ok(doneAt > 0, '13 步应该能在有限拍内走完（否则是死锁）')

  const fin = sm.get()
  assert.equal(fin.state, 'sleeping', `整理完成**不应**改变睡眠状态（实际 ${fin.state}）`)
  assert.equal(fin.task.step, consolidator.STEPS.length, 'task.step 必须等于 13')
  // 有 3 个 LLM 步（3/6/9）在无 sessionCtl 时会各重试 3 次后跳过，
  // 所以拍数上限 = 13 步 + 3 个 LLM 步 × 2 次额外重试 = 19，再留一点余量。
  assert.ok(doneAt <= consolidator.STEPS.length + 3 * 2 + 1, `步进不应重跑（用了 ${doneAt} 拍）`)
  assert.ok(doneAt < 200, '不能无限循环——正是死锁的表现')

  // 状态迁移由驱动侧决定，状态机本身也允许
  sm.wake({ reason: '整理结束自然醒' })
  assert.equal(sm.get().state, 'awake')
})

// ── 回归：LLM 步投递必须符合宿主 prompt(request, signal) 契约 ──
//
// 线上曾因这一处把整个 DSH 打成 fatal load failure：
//   TypeError: Cannot read properties of undefined (reading 'throwIfAborted')
// 根因是 prompt 的 signal 必传（源码第一行 signal.throwIfAborted()），
// 且 content 必须是 [{type:'text',text}] 数组。这个测试用**真的会校验这两点**的
// mock controller 把契约钉死：少传 signal 或传字符串都会让它当场抛错。
test('整理器：LLM 步投递必须传 signal 与 content 数组（防崩宿主回归）', async () => {
  const { createConsolidator } = await import('../lib/consolidate.js')
  const { db, store } = freshStore()

  const calls = []
  const controller = {
    // 真实 list() 的条目带 cwd；来源隔离要求它是陪伴会话
    get sessionId() { return 'session-test-1' },
    async list() {
      return { items: [{ sessionId: 'session-test-1', cwd: '/tmp/test-workspace/agents', lastActiveAt: 9000 }] }
    },
    // 忠实模拟宿主的校验：signal 必传、content 必须含非空白文本
    prompt(request, signal) {
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      signal.throwIfAborted()
      const hasText = Array.isArray(request.content)
        && request.content.some((c) => c?.type === 'text' && String(c.text || '').trim())
      if (!hasText) throw new Error('prompt content must include non-whitespace text')
      if (!request.requestId) throw new Error('缺少 requestId')
      if (!request.sessionId) throw new Error('缺少 sessionId')
      calls.push(request)
      return Promise.resolve({ ok: true })
    },
  }

  const sm = createSleepManager({ stateFile: path.join(tmpDir(), 'state2.json') })
  sm.enterPreparing({ reason: 'test' })
  sm.enterSleeping()
  const consolidator = createConsolidator({ db, store, sleep: sm, getSessionCtl: () => controller })

  // 跑到第 3 步（第一个 LLM 步）为止
  let guard = 0
  let r = null
  while (guard++ < 10) {
    r = await consolidator.tick(controller)
    if (r && r.step === 3) break
  }
  assert.equal(r.step, 3, '应推进到第 3 步（extract-episode）')
  assert.equal(r.ok, true, '投递应成功：' + (r.note || ''))

  assert.equal(calls.length, 1, '应恰好投递一次')
  const req = calls[0]
  assert.ok(Array.isArray(req.content), 'content 必须是数组（字符串会被宿主拒）')
  assert.equal(req.content[0].type, 'text')
  assert.ok(String(req.content[0].text).includes('mind_memory'), '整理指令应引导模型用 mind_memory 落库')
  assert.equal(req.mode, 'queue')
  assert.equal(req.sessionId, 'session-test-1', '必须投给具体会话')
})

// ── 回归：没有可用会话时不得投递（宁可跳过也不能投错会话） ──
test('整理器：无可用 sessionId 时 LLM 步安静跳过，绝不调 prompt', async () => {
  const { createConsolidator } = await import('../lib/consolidate.js')
  const { db, store } = freshStore()
  let promptCalls = 0
  const controller = {
    prompt() { promptCalls += 1; throw new Error('不应被调用') },
  }
  const sm = createSleepManager({ stateFile: path.join(tmpDir(), 'state3.json') })
  sm.enterPreparing({ reason: 'test' })
  sm.enterSleeping()
  const consolidator = createConsolidator({ db, store, sleep: sm, getSessionCtl: () => controller })

  let guard = 0, r = null
  while (guard++ < 10) {
    r = await consolidator.tick(controller)
    if (r && r.step === 3) break
  }
  assert.equal(r.step, 3)
  assert.equal(r.ok, false, '没有会话应判为未完成（走重试）')
  assert.equal(promptCalls, 0, '拿不到 sessionId 时绝不能调 prompt')
})

// ── 回归：sessionId 必须能从 controller.list() 的**真实异步形状**里解出来 ──
//
// 宿主 list(_request, signal) 是 async，返回 { items: [{ sessionId, ... }] }，
// controller 自身没有 sessionId 字段（session-controller/lib/index.js:3054）。
// 早期代码把 list() 当同步数组取，拿到的是 Promise → sessionId 永远 null，
// 于是 3 个 LLM 步全部"无会话跳过"，睡眠整理永远做不成记忆沉淀。
test('整理器：能从 controller.list() 的异步 {items:[{sessionId}]} 解析出目标会话', async () => {
  const { createConsolidator } = await import('../lib/consolidate.js')
  const { db, store } = freshStore()
  const targets = []
  // 忠实模拟真实形状：无 sessionId 字段、list 是 async、返回 { items }
  const controller = {
    async list() {
      // 真实 cwd：陪伴会话才能被投递（来源隔离要求）
      const CWD = '/tmp/test-workspace/agents'
      return { items: [
        { sessionId: 'session-old', cwd: CWD, lastActiveAt: 1000 },
        { sessionId: 'session-newest', cwd: CWD, lastActiveAt: 9000 },
      ] }
    },
    prompt(request, signal) {
      if (!signal || typeof signal.throwIfAborted !== 'function') throw new TypeError('signal 缺失')
      signal.throwIfAborted()
      targets.push(request.sessionId)
      return Promise.resolve()
    },
  }
  const sm = createSleepManager({ stateFile: path.join(tmpDir(), 'state4.json') })
  sm.enterPreparing({ reason: 'test' })
  sm.enterSleeping()
  const consolidator = createConsolidator({ db, store, sleep: sm, getSessionCtl: () => controller })

  let guard = 0, r = null
  while (guard++ < 10) {
    r = await consolidator.tick(controller)
    if (r && r.step === 3) break
  }
  assert.equal(r.ok, true, '有会话时投递应成功：' + (r.note || ''))
  assert.equal(targets.length, 1)
  assert.equal(targets[0], 'session-newest', '应挑最近活跃的那个会话（lastActiveAt 最大）')
})
