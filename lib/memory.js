// dsh-mind / memory.js —— 记忆操作层：写入 / 检索 / 纠错 / 合并 / 三级遗忘 / 星图数据
//
// 写入原则（PRD 5.3 / 手册）：只存"以后用得上的"；推断不得无确认转事实；
// 纠正 = 旧记忆降权 15% + 版本链 + audit_log；删除 = status 标记 + FTS 清理，物理行保留可审计。

import { ftsIndex, ftsDelete } from './db.js'
import { toIndexText, docBigrams, bigrams, coverRatio, toFtsQuery } from './bigram.js'

const KINDS = ['episode', 'fact', 'reflection', 'skill', 'lesson', 'procedural', 'emotion_event', 'media']
const HALF_LIFE_DAYS = 14          // 新鲜度半衰期（手册 §2.4）
const MERGE_SIMILAR = 0.75         // 相似合并阈值——注意：手册的 0.92 是余弦度量；bigram Dice 需要更低的 0.75（用例实测校准）
const MAX_TEXT = 400               // 默认正文上限（可被运行时设置覆盖）

/* ── 运行时设置（面板可改，立即生效，不用重启）── */
const RUNTIME = {
  dedupeKinds: ['fact', 'lesson'],
  maxTextLen: 400,
  mergeSimilar: 0.75,
}

/** 更新运行时设置 */
export function setMemoryOptions(patch) {
  if (!patch) return Object.assign({}, RUNTIME)
  if (Array.isArray(patch.dedupeKinds)) {
    RUNTIME.dedupeKinds = patch.dedupeKinds.filter((x) => typeof x === 'string')
  }
  if (typeof patch.maxTextLen === 'number' && patch.maxTextLen > 0) {
    RUNTIME.maxTextLen = patch.maxTextLen
  }
  if (typeof patch.mergeSimilar === 'number') {
    RUNTIME.mergeSimilar = Math.max(0.1, Math.min(1, patch.mergeSimilar))
  }
  return Object.assign({}, RUNTIME)
}

export function getMemoryOptions() { return Object.assign({}, RUNTIME) }

function now() { return Date.now() }
function uid() { return 'm' + now().toString(36) + Math.random().toString(36).slice(2, 7) }
function j(o) { return JSON.stringify(o ?? []) }
function clamp01(v) { v = Number(v); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5 }

function freshness(ts) {
  const days = Math.max(0, (now() - ts) / 86400000)
  return Math.exp(-days * Math.log(2) / HALF_LIFE_DAYS)
}

  /** 文本相似度：max(Dice, 包含系数)——包含系数专抓"同一事实+补充细节"型重复 */
  function simText(a, b) {
    const A = new Set(bigrams(a)), B = new Set(bigrams(b))
    if (!A.size || !B.size) return 0
    let inter = 0
    for (const x of A) if (B.has(x)) inter++
    const dice = (2 * inter) / (A.size + B.size)
    const contain = inter / Math.min(A.size, B.size)
    return Math.max(dice, contain)
  }

export function createMemoryStore(db, { log = () => {} } = {}) {
  const get = db.prepare('SELECT * FROM memories WHERE id = ?')

  function upsertEntity(name, type = 'thing', t = now()) {
    name = String(name || '').trim().slice(0, 40)
    if (!name) return null
    const row = db.prepare('SELECT id, mention_count FROM entities WHERE name = ?').get(name)
    if (row) {
      db.prepare('UPDATE entities SET mention_count = mention_count + 1, last_seen = ? WHERE id = ?').run(t, row.id)
      return row.id
    }
    const r = db.prepare('INSERT INTO entities(name, type, first_seen, last_seen) VALUES (?,?,?,?)').run(name, type, t, t)
    return Number(r.lastInsertRowid)
  }

  function linkEntities(memoryId, names) {
    for (const n of names) {
      const eid = upsertEntity(n)
      if (eid == null) continue
      db.prepare('INSERT OR IGNORE INTO relations(src_id, dst_id, kind, weight, created_at) VALUES (?,?,?,?,?)')
        .run(memoryId, 'e' + eid, 'entity', 1, now())
    }
  }

  function audit(action, target, before = '', after = '', actor = 'system') {
    db.prepare('INSERT INTO audit_log(t, actor, action, target, before, after) VALUES (?,?,?,?,?,?)')
      .run(now(), actor, action, target, String(before).slice(0, 2000), String(after).slice(0, 2000))
  }

  /** 写入。返回 {id, duplicateOf?}。相似 ≥0.82 的 active 记忆自动合并（merge_into 留链） */
  function note(input = {}) {
    const text = String(input.text || '').trim().slice(0, RUNTIME.maxTextLen)
    if (!text) throw new Error('memory text 不能为空')
    const kind = KINDS.includes(input.kind) ? input.kind : 'episode'
    const t = input.created_at ?? now()
    const entities = Array.isArray(input.entities) ? input.entities.map(String).slice(0, 8) : []

    // 相似合并检查：类型列表可由运行时设置覆盖
  if (RUNTIME.dedupeKinds.includes(kind)) {
      const rows = db.prepare("SELECT id, text FROM memories WHERE status='active' AND kind=?").all(kind)
      for (const r of rows) {
        if (simText(r.text, text) >= RUNTIME.mergeSimilar) {
          const id = uid()
          db.prepare(`INSERT INTO memories(id,kind,text,importance,valence,emotion_tags,entities,source,source_refs,
            confirmed,is_inference,visibility,created_at,status,decay,merge_into)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'archived',1,?)`)
            .run(id, kind, text, clamp01(input.importance), clamp01(input.valence), j(input.emotion_tags),
              j(entities), String(input.source || 'agent-note'), j(input.source_refs),
              input.confirmed ? 1 : 0, input.is_inference ? 1 : 0, input.visibility || 'private', t, r.id)
          ftsIndex(db, id, toIndexText(text))
          audit('merge-duplicate', id, r.id, text)
          return { id, duplicateOf: r.id }
        }
      }
    }

    const id = uid()
    db.prepare(`INSERT INTO memories(id,kind,text,importance,valence,arousal,emotion_tags,entities,source,source_refs,
      confirmed,is_inference,visibility,created_at,last_access,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, kind, text, clamp01(input.importance), clamp01(input.valence), clamp01(input.arousal),
        j(input.emotion_tags), j(entities), String(input.source || 'agent-note'), j(input.source_refs),
        input.confirmed ? 1 : 0, input.is_inference ? 1 : 0, input.visibility || 'private',
        t, t, input.expires_at ?? null)
    ftsIndex(db, id, toIndexText(text))
    if (entities.length) linkEntities(id, entities)
    // 冲突检测：同实体 + 高相似 + 反义词对（简化版：喜欢/讨厌、能/不能、要/不要）
    detectConflicts(id, text, entities)
    audit('note', id, '', text)
    return { id }
  }

  const ANTONYMS = [['喜欢', '讨厌'], ['喜欢', '烦'], ['能', '不能'], ['要', '不要'], ['是', '不是']]
  function detectConflicts(id, text, entities) {
    if (!entities.length) return
    const like = db.prepare("SELECT id, text, entities FROM memories WHERE status='active' AND kind='fact' AND id != ? AND created_at > ?").all(id, now() - 90 * 86400000)
    for (const r of like) {
      if (simText(r.text, text) < 0.4) continue
      let entsOverlap = false
      try { if (JSON.parse(r.entities || '[]').some((e) => entities.includes(e))) entsOverlap = true } catch {}
      if (!entsOverlap) continue
      for (const [x, y] of ANTONYMS) {
        if ((r.text.includes(x) && text.includes(y)) || (r.text.includes(y) && text.includes(x))) {
          db.prepare('INSERT INTO conflicts(a_id, b_id, reason, created_at) VALUES (?,?,?,?)').run(r.id, id, `反义对:${x}/${y}`, now())
          audit('conflict-flag', `${r.id}|${id}`, r.text, text)
          break
        }
      }
    }
  }

  /** 混合检索：FTS(或 JS 扫描)候选 → 打分（关键词.56 图谱.14 重要性.19 新鲜度.11，乘 decay）
   *  语义 0.18 的槽位 v1 不启用——关键词权重相应放大（手册实测中文关键词 0.46 最重的结论保留） */
  function search(query, { k = 5, minScore = 0.3, visibility = 'private', kinds } = {}) {
    const qBigrams = bigrams(query)
    if (!qBigrams.length) return []
    const kindsSql = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''
    let candidates = []
    if (db._ftsAvailable) {
      const q = toFtsQuery(query)
      if (!q) return []
      try {
        const ids = db.prepare(`SELECT memory_id FROM memories_fts WHERE bigram_text MATCH ?`).all(q)
        candidates = ids.map((c) => get.get(c.memory_id)).filter(Boolean)
      } catch (e) {
        // 任何 FTS 异常（语法/损坏/上下文）都降级 JS 扫描——检索永远可用
        log?.(`FTS 查询异常，降级 JS 扫描：${e?.message ?? e}`)
        candidates = db.prepare("SELECT * FROM memories WHERE status='active'").all()
      }
    } else {
      candidates = db.prepare("SELECT * FROM memories WHERE status='active'").all()
    }
    candidates = candidates.filter((m) => m
      && m.status === 'active'
      && (m.visibility === visibility || m.visibility === 'public')
      && (!kinds?.length || kinds.includes(m.kind)))

    const scored = []
    for (const m of candidates) {
      const doc = docBigrams(m.text)
      const kw = coverRatio(doc, qBigrams)
      if (kw <= 0) continue
      // 图谱分：查询词命中该记忆的实体名
      let ents = []
      try { ents = JSON.parse(m.entities || '[]') } catch {}
      const graph = ents.some((e) => query.includes(e) || bigrams(e).some((b) => query.includes(b))) ? 1 : 0
      const score = (0.56 * kw + 0.14 * graph + 0.19 * clamp01(m.importance) + 0.11 * freshness(m.created_at)) * (m.decay ?? 1)
      if (score < minScore) continue
      scored.push({
        id: m.id, kind: m.kind, text: m.text, importance: m.importance,
        source: m.source, mood_tags: safeParse(m.emotion_tags), created_at: m.created_at,
        score: Number(score.toFixed(4)),
        why: { keyword: Number(kw.toFixed(2)), graph, freshness: Number(freshness(m.created_at).toFixed(2)), decay: m.decay },
      })
    }
    scored.sort((a, b) => b.score - a.score)
    const out = scored.slice(0, k)
    // 检索反馈：被召回的记忆更新访问位（衰减保护：30 天内被想起过的不归档）
    for (const r of out) {
      db.prepare('UPDATE memories SET access_count = access_count + 1, last_access = ? WHERE id = ?').run(now(), r.id)
    }
    return out
  }

  function safeParse(s) { try { return JSON.parse(s || '[]') } catch { return [] } }

  /** 纠正：旧记忆 decay×0.85 + 可选新版本入链 + 写一条 lesson（手册/PRD 5.3） */
  function correct(id, { newText, reason = '', actor = 'agent' } = {}) {
    const m = get.get(id)
    if (!m) throw new Error(`记忆 ${id} 不存在`)
    db.prepare('UPDATE memories SET decay = decay * 0.85, version = version + 1 WHERE id = ?').run(id)
    let newId = null
    if (newText && String(newText).trim()) {
      newId = uid()
      db.prepare(`INSERT INTO memories(id,kind,text,importance,valence,emotion_tags,entities,source,source_refs,
        confirmed,is_inference,visibility,created_at,status,prev_id,version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'private',?,'active',?,?)`)
        .run(newId, m.kind, String(newText).trim().slice(0, MAX_TEXT), m.importance, m.valence, m.emotion_tags,
          m.entities, 'user-correction', m.source_refs, 1, 0, now(), id, m.version + 1)
      ftsIndex(db, newId, toIndexText(newText))
    }
    note({ kind: 'lesson', text: `用户纠正过我：关于「${m.text.slice(0, 40)}」${
      reason ? `——${reason.slice(0, 60)}` : ''}`, importance: 0.7, source: 'user-correction', confirmed: 1 })
    audit('correct', id, m.text, newText || '', actor)
    return { oldId: id, newId, decayAfter: get.get(id).decay }
  }

  /** 合并：b 并入 a（b archived，关系迁移） */
  function merge(keepId, foldId) {
    const a = get.get(keepId), b = get.get(foldId)
    if (!a || !b) throw new Error('merge: 记忆不存在')
    db.prepare("UPDATE memories SET status='archived', merge_into=? WHERE id=?").run(keepId, foldId)
    const rels = db.prepare("SELECT * FROM relations WHERE src_id=?").all(foldId)
    for (const r of rels) {
      db.prepare('INSERT OR IGNORE INTO relations(src_id,dst_id,kind,weight,created_at) VALUES (?,?,?,?,?)')
        .run(keepId, r.dst_id, r.kind, r.weight, now())
    }
    ftsDelete(db, foldId)
    audit('merge', foldId, b.text, `→ ${keepId}`)
    return { kept: keepId, folded: foldId }
  }

  /** 三级遗忘：tier1 降权（可逆） / tier2 压缩归档（保留来源） / tier3 删除（status+FTS+审计） */
  function forget(id, { tier = 1, reason = '' } = {}) {
    const m = get.get(id)
    if (!m) throw new Error(`记忆 ${id} 不存在`)
    if (tier === 1) {
      db.prepare('UPDATE memories SET decay = decay * 0.5 WHERE id = ?').run(id)
      audit('forget-deprioritize', id, m.text.slice(0, 100), reason)
      return { tier, effect: 'decay×0.5' }
    }
    if (tier === 2) {
      db.prepare("UPDATE memories SET status='archived' WHERE id = ?").run(id)
      ftsDelete(db, id)
      audit('forget-archive', id, m.text.slice(0, 100), reason)
      return { tier, effect: 'archived（原文保留在行内，可恢复）' }
    }
    if (tier === 3) {
      db.prepare("UPDATE memories SET status='deleted' WHERE id = ?").run(id)
      ftsDelete(db, id)
      audit('forget-delete', id, m.text.slice(0, 100), reason)
      return { tier, effect: 'deleted（行保留仅作审计；FTS 已清）' }
    }
    throw new Error('tier 必须是 1/2/3')
  }

  /**
   * 物理删除一条记忆（用户明确要求"真的把这段记忆忘掉"）。
   *
   * 与 forget 的区别：forget 是三级软遗忘（降权/归档/软删除，行保留可审计），
   * purge 是**从数据库里整行删掉**，并清 FTS 索引，不可恢复（审计日志留痕）。
   *
   * 安全：仍写一条 audit_log（记下删了什么、谁删的），
   *      但正文只在日志里留前 100 字，其余随行一起消失。
   */
  function purge(id, { reason = '' } = {}) {
    const m = get.get(id)
    if (!m) throw new Error('记忆 ' + id + ' 不存在')
    const snap = String(m.text || '').slice(0, 100)

    // 关联边也一起清掉（否则星图会留下悬空连线）
    let relCleared = 0
    try {
      const r1 = db.prepare('DELETE FROM relations WHERE src_id = ? OR dst_id = ?').run(id, id)
      relCleared = Number(r1.changes || 0)
    } catch { /* 表可能不存在 */ }

    db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    try { ftsDelete(db, id) } catch { /* FTS 不可用时忽略 */ }

    audit('purge', id, snap, reason || '用户手动删除（不可恢复）')
    return { purged: true, id, relationsCleared: relCleared, textPreview: snap }
  }

  /** 星图数据：节点=记忆+实体，边=关系。全部实时出库 */
  // 从正文里挑一个能当标签看的片段。
  //   ⚠️ 线上真实数据暴露出：mood 归档里存的是**整段系统提示词**
  //   （"【当前时间】…【当前角色】…"），直接 slice(0,60) 会让每个节点标签
  //   都是一模一样的「【当前时间】2026/10/28」，星图看着像一堆重复的球。
  //   所以这里跳过成段的【】小标题，取第一句像人话的正文。
  function cleanLabel(text, max = 34) {
    let t = String(text || '')
    // 去掉所有「【xxx】」标题行与它们后面的冒号内容
    t = t.replace(/【[^】]*】/g, ' ')
    // 去掉桥接注入的系统提示词句式（这些都是"设定"，不是"发生了什么"）
    t = t.replace(/你的身份[^。]*。/g, ' ')
    t = t.replace(/消息里出现[^。]*。/g, ' ')
    t = t.replace(/会话令牌[^。]*。/g, ' ')
    t = t.replace(/完整角色卡[^）)]*[）)]?/g, ' ')
    t = t.replace(/（Asia\/Shanghai）/g, ' ')
    t = t.replace(/[（(][^）)]*[）)]/g, ' ')
    // 提示词里常见的指令性短语
    t = t.replace(/你不是客服[^。]*。/g, ' ')
    t = t.replace(/不用有求必应[^。]*。/g, ' ')
    // 开头的日期时间戳 → 只在标签里保留日期（时间靠 ts 字段，不占标签宽度）
    t = t.replace(/\s+/g, ' ').trim()
    // 去掉残留的纯时间戳（如 "2026/10/28 02:17:08"）——它对"这是哪件事"没有信息量
    t = t.replace(/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s*\d{1,2}:\d{2}(:\d{2})?\s*/,'').trim()
    t = t.replace(/\d{1,2}:\{2}:\{2}/g,'').trim()
    const m = t.match(/^[^。！？!?]{4,}/)
    if (m) t = m[0]
    t = t.trim()
    if (!t) t = '（提示词片段）'
    return t.length > max ? t.slice(0, max) : t
  }

  /** 清洗后还剩多少"人话"——判断这条记忆是不是提示词噪声（桥接曾把系统提示词当用户消息归档） */
  function humanRemainder(text) {
    let t = String(text || '')
    // 先把他提示词的骨架整段挖掉：所有【】标题行 + 已知的注入句式 + 令牌 + 时间
    t = t.replace(/【[^】]*】[^\n]*\n?/g, ' ')
    t = t.replace(/你的身份[^。]*。/g, ' ')
    t = t.replace(/消息里出现[^。]*。/g, ' ')
    t = t.replace(/会话令牌[^。]*。/g, ' ')
    t = t.replace(/你(不是客服|不用有求必应)[^。]*。/g, ' ')
    t = t.replace(/[0-9a-f]{24,}/gi, ' ')          // 会话令牌那种长十六进制串
    t = t.replace(/\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/g, ' ')
    t = t.replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')
    t = t.replace(/（Asia\/Shanghai）/g, ' ')
    t = t.replace(/[（(][^）)]*[）)]/g, ' ')
    t = t.replace(/[「」“”"'—\-·、，。：；]/g, ' ')
    t = t.replace(/\s+/g, '')
    return t.length
  }

  /** 这条正文是不是"系统提示词/设定"而不是一次真实对话 */
  function looksLikePrompt(text) {
    const t = String(text || '')
    const hasHeaderBlocks = (t.match(/【[^】]*】/g) || []).length >= 2
    const hasPersonaCue = /你的身份|完整角色卡|会话令牌|反AI味|积极性|表情包策略/.test(t)
    return hasHeaderBlocks || hasPersonaCue
  }

  function graphData({ scope = 'private', limit = 200, kinds, since, until } = {}) {
    const kindSql = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''
    // 时间过滤只作用于 created_at（记忆写入时间）。
    // ⚠️ 本表没有独立的"事件发生时间"字段——不编造一个出来充数，
    //    面板会明确说明时间轴筛选的是 createdAt。
    const timeSql = `${since ? ' AND created_at >= ?' : ''}${until ? ' AND created_at <= ?' : ''}`
    const args = [scope, ...(kinds?.length ? kinds : []), ...(since ? [since] : []), ...(until ? [until] : []), limit]
    const mems = db.prepare(`SELECT id,kind,text,importance,access_count,status,decay,emotion_tags,entities,source,created_at,last_access,confirmed,is_inference
      FROM memories WHERE status IN ('active','archived') AND visibility IN (?, 'public')${kindSql}${timeSql}
      ORDER BY importance DESC, created_at DESC LIMIT ?`).all(...args)
    const nodes = mems.map((m) => {
      const isPrompt = looksLikePrompt(m.text)
      const human = humanRemainder(m.text)
      const d = new Date(m.created_at)
      const stamp = isPrompt
        ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} 提示词残留`
        : cleanLabel(m.text)
      return {
        id: m.id, group: 'memory', kind: m.kind, label: stamp,
        size: Math.round((m.importance * 0.7 + Math.min(1, m.access_count / 10) * 0.3) * 100) / 100,
        status: m.status, decay: m.decay, mood_tags: safeParse(m.emotion_tags), ts: m.created_at,
        // noise=1：这行正文几乎全是系统提示词，不是真实对话。
        // 面板据此把节点画成暗淡的虚线轮廓，避免把提示词残留当成记忆。
        noise: (isPrompt && human < 80) ? 1 : 0,
        // ── 详情面板要用的真实字段（全部直接来自库，缺就留 null 让前端显示"未记录"）──
        importance: m.importance,
        accessCount: m.access_count,
        lastAccess: m.last_access || null,
        source: m.source || null,
        confirmed: !!m.confirmed,
        isInference: !!m.is_inference,
        emotionTags: safeParse(m.emotion_tags),
      }
    })
    const edges = []
    const entIds = new Set()
    // 关系依据：把 relations 表里能读到的 kind 原样带出去（前端据此显示"关联依据"）
    for (const m of mems) {
      for (const r of db.prepare("SELECT dst_id, kind, weight FROM relations WHERE src_id=?").all(m.id)) {
        edges.push({ src: m.id, dst: r.dst_id, kind: r.kind, weight: r.weight, basis: 'relations' })
        if (r.dst_id.startsWith('e')) entIds.add(r.dst_id)
      }
    }
    const entQ = db.prepare('SELECT id, name, type, mention_count FROM entities WHERE id = ?')
    const entName = new Map()
    for (const eid of entIds) {
      const e = entQ.get(Number(eid.slice(1)))
      if (e) {
        entName.set(eid, e.name)
        nodes.push({ id: eid, group: 'entity', kind: e.type, label: e.name, size: Math.min(1, e.mention_count / 10), ts: e.last_seen })
      }
    }

    // ── 共现边：实体抽取还没跑起来时，图谱不能是一片孤岛 ──
    //   神经脉络的本质是"联系"。有三路可用来造边，按可信度排：
    //   ① 同一记忆里出现相同实体（entities 字段，JSON 数组）
    //   ② 相邻时间窗内的记忆（同一段对话里发生的事天然相关）
    //   ③ 相同 kind + 相近情绪标签
    //   这里只补 ① 和 ②：两者都是真实数据推得的，不是编造的。
    if (!edges.length && mems.length > 1) {
      const byEnt = new Map()
      for (const m of mems) {
        let ents = []
        try { ents = JSON.parse(m.entities || '[]') } catch { ents = [] }
        if (!Array.isArray(ents)) ents = []
        for (const name of ents) {
          const k = String(name)
          if (!byEnt.has(k)) byEnt.set(k, [])
          byEnt.get(k).push(m.id)
        }
      }
      for (const [, ids] of byEnt) {
        if (ids.length < 2) continue
        for (let i = 0; i < ids.length - 1; i++) {
          edges.push({ src: ids[i], dst: ids[i + 1], kind: 'entity', weight: 1 })
        }
      }
      // 时间邻近：按 created_at 排序后把 20 分钟内的相邻记忆串起来
      if (!edges.length) {
        const sorted = mems.slice().sort((a, b) => a.created_at - b.created_at)
        const WIN = 20 * 60 * 1000
        for (let i = 0; i < sorted.length - 1; i++) {
          const gap = sorted[i + 1].created_at - sorted[i].created_at
          if (gap >= 0 && gap <= WIN) {
            edges.push({
              src: sorted[i].id, dst: sorted[i + 1].id, kind: 'cooccur',
              weight: 1 - gap / WIN * 0.6,
              // 依据要说清楚：这是"时间相邻"推得的推测关联，不是库里的显式关系
              basis: 'time-proximity',
              basisNote: `${Math.round(gap / 60000)} 分钟内相邻`,
            })
          }
        }
      }
    }
    // 实体边补上实体名，前端详情面板才能说清"因为共同提到 X 而相关"
    for (const e of edges) {
      if (e.dst && String(e.dst).startsWith('e') && entName.has(e.dst)) {
        e.dstLabel = entName.get(e.dst)
        if (!e.basisNote) e.basisNote = `共同实体「${entName.get(e.dst)}」`
      }
    }
    return { nodes, edges, generated_at: now() }
  }

  /** 时间轴元信息：库里真实的时间跨度与按类型计数（供面板滑块用，不编造区间） */
  function timeRange() {
    const r = db.prepare(`SELECT
        MIN(created_at) AS minT, MAX(created_at) AS maxT, COUNT(*) AS total
      FROM memories WHERE status IN ('active','archived') AND visibility IN ('private','public')`).get()
    const byKind = db.prepare(`SELECT kind, COUNT(*) n, MIN(created_at) mn, MAX(created_at) mx
      FROM memories WHERE status IN ('active','archived') AND visibility IN ('private','public')
      GROUP BY kind ORDER BY n DESC`).all()
    return {
      minT: r?.minT || null,
      maxT: r?.maxT || null,
      total: r?.total || 0,
      byKind: byKind || [],
      serverNow: now(),
    }
  }

  function stats() {
    const one = (sql, ...p) => db.prepare(sql).get(...p)
    return {
      total: one("SELECT COUNT(*) n FROM memories WHERE status='active'").n,
      archived: one("SELECT COUNT(*) n FROM memories WHERE status='archived'").n,
      byKind: db.prepare("SELECT kind, COUNT(*) n FROM memories WHERE status='active' GROUP BY kind").all(),
      entities: one('SELECT COUNT(*) n FROM entities').n,
      conflictsOpen: one('SELECT COUNT(*) n FROM conflicts WHERE resolved=0').n,
      dbBytes: one("SELECT page_count*page_size AS b FROM pragma_page_count(), pragma_page_size()").b,
    }
  }

  function recent(limit = 20) {
    return db.prepare("SELECT id,kind,text,importance,status,created_at FROM memories ORDER BY created_at DESC LIMIT ?").all(limit)
  }

  function auditList(limit = 50) {
    return db.prepare('SELECT * FROM audit_log ORDER BY t DESC LIMIT ?').all(limit)
  }

  function getById(id) { return get.get(id) }
  return { note, search, get: getById, correct, merge, forget, purge, graphData, timeRange, stats, recent, auditList, linkEntities }
}
