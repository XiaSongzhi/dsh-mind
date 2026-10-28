// dsh-mind / retrieve.js —— 省 token 注入协调器 + 混合打分入口
//
// 三条省 token 纪律：
//   1. 注入块总预算默认 1000 字，超预算按优先级裁（记忆 > 心情 > 经验卡 > 偏好）
//   2. 记忆条数默认 top-2、单条截 80 字、低于 0.45 分不注入（手册：私聊 2 条、门槛 0.45）
//   3. 注入关闭时（inject:false，"先只写不读"灰度期）本模块只算不发

const SECTION_ORDER = ['memory', 'mood', 'procedures', 'profile']
const MARKER = '<!--dsh-mind:v1-->'

/**
 * 组装注入块。inputs:
 *   memoryHits: memory.search() 的结果（已打分）
 *   moodLine:   '当前心情：…'（emotions 桥接给出，可为空）
 *   procedureHook: 经验卡消歧索引（procedures.js renderHook，可为空）
 *   profileLine: 偏好一句话（可为空）
 * cfg: { injectBudgetChars, recallK, memoryMaxChars, blocks:{memory,mood,procedures,profile} 开关 }
 * 返回 { text, usedChars, sections: [{name, chars}] }——面板可解释：每块花了多少。
 */
export function buildInjectBlock({ memoryHits = [], moodLine = '', procedureHook = '', profileLine = '' } = {}, cfg = {}) {
  const budget = Number(cfg.injectBudgetChars) || 1000
  const k = Number(cfg.recallK) || 2
  const maxChars = Number(cfg.memoryMaxChars) || 80
  const minScore = Number(cfg.recallMinScore) ?? 0.45
  const on = (name) => !cfg.blocks || cfg.blocks[name] !== false

  const sections = []
  if (on('memory') && memoryHits.length) {
    const hits = memoryHits.filter((h) => h.score >= minScore).slice(0, k)
    if (hits.length) {
      const lines = hits.map((h, i) => `${i + 1}.${h.text.slice(0, maxChars)}（${h.kind}）`)
      sections.push({ name: 'memory', text: `【相关记忆】\n${lines.join('\n')}` })
    }
  }
  if (on('mood') && moodLine) sections.push({ name: 'mood', text: `【心情】${moodLine}` })
  if (on('procedures') && procedureHook) sections.push({ name: 'procedures', text: procedureHook })
  if (on('profile') && profileLine) sections.push({ name: 'profile', text: `【偏好】${profileLine}` })

  // 按优先级裁剪到预算
  const kept = []
  let used = MARKER.length + 2
  for (const name of SECTION_ORDER) {
    const s = sections.find((x) => x.name === name)
    if (!s) continue
    const cost = s.text.length + 1
    if (used + cost > budget) continue
    kept.push(s.text)
    used += cost
  }
  const text = kept.length ? `${MARKER}\n${kept.join('\n')}` : ''
  return { text, usedChars: text.length, sections: kept.map((t) => ({ name: t.slice(1, 4), chars: t.length })) }
}

/** agent 侧检索提示：搜不到时换词重查（写进 mind_memory 工具描述） */
export const RETRY_HINT = '首轮无命中或分数低时，换同义关键词（如"紧张"→"压力/考试"）再查 1~2 次；仍无就如实说想不起来。'
