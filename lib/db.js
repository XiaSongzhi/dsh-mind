// dsh-mind / db.js —— SQLite 主库（唯一权威）+ FTS5 bigram 索引（可整体重建）
//
// 原则（PRD）：向量/FTS 只是"找得快"，主库才是"存得对"。索引坏了 = 重建，记忆零损失。
// 运行时用 node:sqlite（Node 26 自带，零依赖）；FTS5 若宿主编译缺失，自动降级为 JS 扫描。

import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'episode'
    CHECK(kind IN (
      -- 七层记忆模型 + 细分类型（2026-10-29 扩展：原来 8 种太粗，
      -- 大量真实记忆都被塞进 episode，星图上看不出差别）
      'episode',        -- 事件：发生过的一次具体经历
      'fact',           -- 事实：客观信息、数据、客观描述
      'reflection',     -- 反思：对某事的思考、总结
      'skill',          -- 技能：会做的事、方法、技巧
      'lesson',         -- 教训：踩过的坑、经验之谈
      'procedural',     -- 程序性：固定流程、步骤、操作规范
      'emotion_event',  -- 情绪事件：强烈情绪触发的记忆
      'media',          -- 媒体：图片/音频相关的记忆
      'preference',     -- 偏好：AI 或用户的喜好倾向
      'relationship',   -- 关系：人与人之间发生的关系变化
      'promise',        -- 约定：双方确认过的承诺
      'plan',           -- 计划：待办、未来要做的事
      'profile',        -- 画像：关于某人的稳定特征
      'conflict',       -- 冲突：未消解的矛盾或误解
      'insight',        -- 洞察：突然想通的道理
      'milestone'       -- 里程碑：重要转折点
    )),
  text TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  valence REAL NOT NULL DEFAULT 0,
  arousal REAL NOT NULL DEFAULT 0,
  emotion_tags TEXT NOT NULL DEFAULT '[]',
  entities TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'agent-note',
  source_refs TEXT NOT NULL DEFAULT '[]',
  confirmed INTEGER NOT NULL DEFAULT 0,
  is_inference INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','suppressed','deleted')),
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at INTEGER NOT NULL,
  last_access INTEGER NOT NULL DEFAULT 0,
  access_count INTEGER NOT NULL DEFAULT 0,
  retrieval_feedback REAL NOT NULL DEFAULT 0,
  decay REAL NOT NULL DEFAULT 1,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  prev_id TEXT,
  merge_into TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_status ON memories(status, kind);
CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);

CREATE TABLE IF NOT EXISTS memories_fts(
  memory_id TEXT,
  bigram_text TEXT
);

CREATE TABLE IF NOT EXISTS entities(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'thing',
  aliases TEXT NOT NULL DEFAULT '[]',
  mention_count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  profile TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ent_name ON entities(name);

CREATE TABLE IF NOT EXISTS relations(
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'cooccur',
  weight REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(src_id, dst_id, kind)
);

CREATE TABLE IF NOT EXISTS conflicts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS working(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS emotions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  mood_id TEXT NOT NULL,
  mood_label TEXT NOT NULL,
  intensity REAL NOT NULL DEFAULT 0.5,
  trigger TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'inference',
  cause_ref TEXT
);

CREATE TABLE IF NOT EXISTS diary_index(
  day TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  mood_label TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS preferences(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL CHECK(subject IN ('user','self')),
  domain TEXT NOT NULL DEFAULT 'general',
  text TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'inference',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS procedures_index(
  card TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  symptoms TEXT NOT NULL DEFAULT '',
  last_read INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS eval_cases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  expect_ids TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  before TEXT NOT NULL DEFAULT '',
  after TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS daily_stats(
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(day, key)
);

CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT
);
`

/**
 * 类型体系迁移（2026-10-29）。
 *
 * SQLite 的 CHECK 约束**无法就地修改**，只能"建新表 → 拷数据 → 删旧表 → 改名"。
 * 旧库只允许 8 种 kind，扩展类型时会写入失败（真实踩到）。
 *
 * 安全要求（PRD 硬约束：不得删记忆）：
 *   ① 迁移前把整张表备份到 memories_backup_<时间戳>
 *   ② 全程在一个事务里；任何一步失败就回滚，旧表原样保留
 *   ③ 只重建 memories 一张表，其它表（entities/relations/audit…）完全不动
 *   ④ 迁移是幂等的：检测到新结构就直接跳过
 */
function migrateKindCheck(db) {
  const NEW_KINDS = [
    'episode','fact','reflection','skill','lesson','procedural','emotion_event','media',
    'preference','relationship','promise','plan','profile','conflict','insight','milestone',
  ]
  let ddl = ""
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get()
    ddl = row ? (row.sql || "") : ""
  } catch (e) { return { migrated: false } }
  if (!ddl) return { migrated: false }
  if (ddl.indexOf("milestone") >= 0) return { migrated: false, reason: "current" }

  // 正则改 CHECK 会踩嵌套括号的坑（[^)]* 在第一个 ) 处截断），这里改为：
  // 直接重建完整建表语句 —— 保留所有列定义，只把 kind 那一段换成新列表。
  const lineList = ddl.split("\n")
  const kindIdx = lineList.findIndex(function(l){ return /^\s*kind\s+TEXT/i.test(l) })
  if (kindIdx < 0) return { migrated: false, reason: "no-kind-column" }
  // 从 kind 行开始，往上找直到出现 CHECK( 的闭合括号后再合并的行
  const indent = (lineList[kindIdx].match(/^\s*/) || [""])[0]
  let endIdx = kindIdx
  if (lineList[kindIdx].indexOf("CHECK(") < 0) {
    endIdx = kindIdx + 1
    while (endIdx < lineList.length && lineList[endIdx].indexOf("CHECK(") < 0) endIdx++
  }
  // 找到 CHECK(...) 的闭合：数括号
  let depth = 0, seenOpen = false
  let j = endIdx
  for (; j < lineList.length; j++) {
    for (const ch of lineList[j]) {
      if (ch === "(") { depth++; seenOpen = true }
      else if (ch === ")") { depth-- }
    }
    if (seenOpen && depth <= 0) break
  }
  if (j >= lineList.length) return { migrated: false, reason: "unterminated-check" }

  const kindDef = [
    indent + "kind TEXT NOT NULL DEFAULT 'episode'",
    indent + "  CHECK(kind IN (" + NEW_KINDS.map(function(k){ return "'" + k + "'" }).join(",") + ")),",
  ]
  const head = lineList.slice(0, kindIdx)
  const tail = lineList.slice(j + 1)
  const rebuilt = head.concat(kindDef, tail).join("\n")
    .replace(/CREATE TABLE (IF NOT EXISTS )?\"?(memories)\"?/i, "CREATE TABLE memories_new")

  try {
    db.exec("BEGIN")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    db.exec('DROP TABLE IF EXISTS "memories_backup_' + stamp + '"')
    db.exec('CREATE TABLE "memories_backup_' + stamp + '" AS SELECT * FROM memories')
    const before = db.prepare("SELECT COUNT(*) n FROM memories").get().n
    db.exec("DROP TABLE IF EXISTS memories_new")
    db.exec(rebuilt)
    db.exec("INSERT INTO memories_new SELECT * FROM memories")
    const after = db.prepare("SELECT COUNT(*) n FROM memories_new").get().n
    if (before !== after) throw new Error("行数不一致 " + before + " -> " + after)
    db.exec("DROP TABLE memories")
    db.exec("ALTER TABLE memories_new RENAME TO memories")
    db.exec("CREATE INDEX IF NOT EXISTS idx_mem_status ON memories(status, kind)")
    db.exec("CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at)")
    db.exec("COMMIT")
    return { migrated: true, rows: after, backup: "memories_backup_" + stamp }
  } catch (e) {
    try { db.exec("ROLLBACK") } catch (e2) {}
    return { migrated: false, error: String(e && e.message ? e.message : e) }
  }
}

/** 打开数据库：WAL + 建表 + FTS 可用性探测（缺失则降级 JS 扫描，检索层负责） */
export function openDb(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(SCHEMA)
  // 扩展类型体系（旧库需要重建表才能接受新 kind）
  const m = migrateKindCheck(db)
  db._kindMigration = m
  let fts = false
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS fts_probe USING fts5(x)')
    db.exec('DROP TABLE IF EXISTS fts_probe')
    fts = true
  } catch { fts = false }
  db._ftsAvailable = fts
  return db
}

/** FTS 索引写入（fts 不可用时为空操作——检索层会走 JS 全量扫描） */
export function ftsIndex(db, memoryId, indexText) {
  if (!db._ftsAvailable) return
  db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(memoryId)
  if (indexText) db.prepare('INSERT INTO memories_fts(memory_id, bigram_text) VALUES (?, ?)').run(memoryId, indexText)
}

export function ftsDelete(db, memoryId) {
  if (!db._ftsAvailable) return
  db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(memoryId)
}

/** FTS 全量重建（一致性修复：主库是权威，索引永远可以从主库重建） */
export function ftsRebuild(db, toIndexText) {
  if (!db._ftsAvailable) return { ok: false, reason: 'fts_unavailable' }
  db.exec('DELETE FROM memories_fts')
  const rows = db.prepare("SELECT id, text FROM memories WHERE status != 'deleted'").all()
  const ins = db.prepare('INSERT INTO memories_fts(memory_id, bigram_text) VALUES (?, ?)')
  for (const r of rows) ins.run(r.id, toIndexText(r.text))
  return { ok: true, rebuilt: rows.length }
}
