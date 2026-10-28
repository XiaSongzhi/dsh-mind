// dsh-mind / memory.js —— 记忆操作层：写入 / 检索 / 纠错 / 合并 / 三级遗忘 / 星图数据
//
// 写入原则（PRD 5.3 / 手册）：只存"以后用得上的"；推断不得无确认转事实；
// 纠正 = 旧记忆降权 15% + 版本链 + audit_log；删除 = status 标记 + FTS 清理，物理行保留可审计。

import { ftsIndex, ftsDelete } from './db.js'
import { toIndexText, docBigrams, bigrams, coverRatio, toFtsQuery } from './bigram.js'

const KINDS = ['episode', 'fact', 'reflection', 'skill', 'lesson', 'procedural', 'emotion_event', 'media']
const HALF_LIFE_DAYS = 14          // 新鲜度半衰期（手册 §2.4）
const MERGE_SIMILAR = 0.75         // 相似合并阈值——注意：手册的 0.92 是余弦度量；bigram Dice 需要更低的 0.75（用例实测校准）
const MAX_TEXT = 400               // 单条记忆正文上限（省 token：写入时就压短）

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
    const text = String(input.text || '').trim().slice(0, MAX_TEXT)
    if (!text) throw new Error('memory text 不能为空')
    const kind = KINDS.includes(input.kind) ? input.kind : 'episode'
    const t = input.created_at ?? now()
    const entities = Array.isArray(input.entities) ? input.entities.map(String).slice(0, 8) : []

    // 相似合并检查：只对 fact/lesson 这类会被"长期重复"的类型去重
    if (['fact', 'lesson'].includes(kind)) {
      const rows = db.prepare("SELECT id, text FROM memories WHERE status='active' AND kind=?").all(kind)
      for (const r of rows) {
        if (simText(r.text, text) >= MERGE_SIMILAR) {
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

  /** 星图数据：节点=记忆+实体，边=关系。全部实时出库 */
  function graphData({ scope = 'private', limit = 200, kinds } = {}) {
    const kindSql = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''
    const mems = db.prepare(`SELECT id,kind,text,importance,access_count,status,decay,emotion_tags,entities,created_at
      FROM memories WHERE status IN ('active','archived') AND visibility IN (?, 'public')${kindSql}
      ORDER BY importance DESC, created_at DESC LIMIT ?`).all(scope, limit, ...(kinds?.length ? kinds : []))
    const nodes = mems.map((m) => ({
      id: m.id, group: 'memory', kind: m.kind, label: m.text.slice(0, 60),
      size: Math.round((m.importance * 0.7 + Math.min(1, m.access_count / 10) * 0.3) * 100) / 100,
      status: m.status, decay: m.decay, mood_tags: safeParse(m.emotion_tags), ts: m.created_at,
    }))
    const edges = []
    const entIds = new Set()
    for (const m of mems) {
      for (const r of db.prepare("SELECT dst_id, kind, weight FROM relations WHERE src_id=?").all(m.id)) {
        edges.push({ src: m.id, dst: r.dst_id, kind: r.kind, weight: r.weight })
        if (r.dst_id.startsWith('e')) entIds.add(r.dst_id)
      }
    }
    const entQ = db.prepare('SELECT id, name, type, mention_count FROM entities WHERE id = ?')
    for (const eid of entIds) {
      const e = entQ.get(Number(eid.slice(1)))
      if (e) nodes.push({ id: eid, group: 'entity', kind: e.type, label: e.name, size: Math.min(1, e.mention_count / 10), ts: e.last_seen })
    }
    return { nodes, edges, generated_at: now() }
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
  return { note, search, get: getById, correct, merge, forget, graphData, stats, recent, auditList, linkEntities }
}
