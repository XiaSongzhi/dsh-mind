// dsh-mind 装配冒烟测试：用 mock ctx 验证 apply() 能被 DSH 宿主正确驱动
// （工具注册/HTTP 注册/注入灰度默认关/mood 归档导入），全程离线、临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mind-home-'))
process.env.DSH_HOME = HOME

// 预置一个 mood 归档（验证导入链路）
const moodData = path.join(HOME, 'mood-data')
fs.mkdirSync(moodData, { recursive: true })
fs.writeFileSync(path.join(moodData, 'dsh-mood-memory.jsonl'),
  JSON.stringify({ id: 'a1', t: 1792067106123, s: 'sess', k: 'u', x: '用户说他最近在准备面试' }))
fs.writeFileSync(path.join(moodData, 'dsh-mood.json'), JSON.stringify({
  current: { id: 'happy', label: '开心' },
}))
fs.writeFileSync(path.join(HOME, 'dsh-mood-store.json'), JSON.stringify({ default: moodData }))

const { name, apply } = await import('../index.js')

function makeCtx() {
  const registered = { tools: [], http: null, sections: [] }
  const ctx = {
    get(key) {
      if (key === 'tools') return { register(def) { registered.tools.push(def) } }
      if (key === 'web') return { register(o) { registered.http = o } }
      return undefined
    },
    effect(fn) { fn() },
    systemPrompt: {
      section(s) { registered.sections.push(s) },
    },
  }
  return { ctx, registered }
}

test('apply 装配（融合契约）：mood 系工具保留原名 + mind_* 并存 + news 排除 + memory 重指向 SQLite', () => {
  const { ctx, registered } = makeCtx()
  const api = apply(ctx, { dataDir: path.join(HOME, 'mind-data') })
  assert.equal(name, 'dsh-mind')
  const toolNames = registered.tools.map((t) => t.name).sort()
  assert.deepEqual(toolNames, ['diary', 'memory', 'mind_memory', 'mind_sleep', 'mood', 'taste'],
    '融合契约：mood 系原名保留（工具肌肉记忆不断）+ mind_* 新增 + news 排除')
  assert.equal(registered.http.path, '/dsh-mind-api')
  assert.equal(registered.sections.filter((s) => s.name === 'dsh-mind/inject').length, 0,
    'inject 默认 false：不得注册提示词节')

  // mood 归档被导入 SQLite
  const r = api.store.search('面试', { k: 5, minScore: 0.1 })
  assert.equal(r.length, 1, 'mood 归档应导入并可检索')
  assert.equal(r[0].source, 'mood-archive')

  // 重指向后的 memory 工具（同名）实际查 SQLite
  const out = registered.tools.find((t) => t.name === 'memory').execute({ action: 'search', query: '面试' })
  assert.equal(out.ok, true)
  assert.equal(out.hits.length, 1, 'memory 工具应命中 SQLite 里导入的归档')

  // mind_memory 工具可执行
  const out2 = registered.tools.find((t) => t.name === 'mind_memory').execute({ action: 'search', query: '面试' })
  assert.equal(out2.ok, true)
  assert.equal(out2.hits.length, 1)

  // HTTP state 路由可跑
  let body = ''
  const res = { writeHead() {}, end(s) { body = s } }
  registered.http.handler({ url: '/dsh-mind-api/state', method: 'GET', headers: {} }, res)
  const j = JSON.parse(body)
  assert.equal(j.ok, true)
  assert.equal(j.sleep.state, 'awake')
  assert.ok(j.stats.total >= 1)
})

test('apply 开启注入后：mood 各节 + dsh-mind/inject 并存，news 节被排除，text() 有输出', () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, { dataDir: path.join(HOME, 'mind-data-inject'), inject: true })
  const names = registered.sections.map((s) => s.name)
  assert.ok(names.includes('dsh-mind/inject'), '应有 dsh-mind/inject 节')
  assert.ok(names.some((n) => String(n).startsWith('dsh-mood/')), 'mood 各节应保留（情绪/日记/经验卡/品味）')
  assert.ok(!names.includes('dsh-mood/news'), 'news 节必须被排除（PRD）')
  const injectSection = registered.sections.find((s) => s.name === 'dsh-mind/inject')
  const text = injectSection.text()
  assert.ok(text.includes('【心情】'), '心情行应注入')
})
