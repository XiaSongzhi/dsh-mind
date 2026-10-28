// dsh-mind / bigram.js —— 中文 bigram 分词（FTS 预分词列 + 查询改写）
//
// 为什么不用 unicode61 直接切：它把整段 CJK 当一个 token，"面试"永远搜不到"他说面试很紧张"。
// 做法：CJK 连续段切两字 bigram，拉丁词整词保留；入 FTS 的列存"空格连接的 bigram 串"，
// unicode61 就能按词命中。检索打分不用 FTS 的 bm25，由 retrieve.js 自己算覆盖率。


function isCjkRun(s) {
  return /^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(s)
}

/** 把文本切成检索词（去重）：CJK 两字 bigram + 拉丁/数字词（小写） */
export function bigrams(text) {
  const out = new Set()
  const runs = String(text || '').match(/[\u3400-\u4dbf\u4e00-\u9fff]+|[A-Za-z0-9_]{2,}/g) || []
  for (const run of runs) {
    if (isCjkRun(run)) {
      if (run.length === 1) { out.add(run); continue }
      for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
    } else {
      out.add(run.toLowerCase())
    }
  }
  return [...out]
}

/** 入 FTS 列：空格连接（unicode61 按空格切词） */
export function toIndexText(text) {
  return bigrams(text).join(' ')
}

/** 查询改写：'OR' 连接的带引号词；空查询返回 '' */
export function toFtsQuery(text) {
  const g = bigrams(text)
  return g.length ? g.map((t) => `"${t}"`).join(' OR ') : ''
}

/** 覆盖率：候选文档的 bigram 被查询命中的比例（0..1）——打分主因子 */
export function coverRatio(docBigrams, queryBigrams) {
  if (!queryBigrams.length) return 0
  const set = new Set(docBigrams)
  let hit = 0
  for (const q of queryBigrams) if (set.has(q)) hit++
  return hit / queryBigrams.length
}

/** 文本 → bigram 数组（检索侧对候选文档再切一遍） */
export function docBigrams(text) {
  return bigrams(text)
}
