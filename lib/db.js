// dsh-mind / db.js —— SQLite 主库（唯一权威）+ FTS5 bigram 索引（可整体重建）
//
// 原则（PRD）：向量/FTS 只是"找得快"，主库才是"存得对"。索引坏了 = 重建，记忆零损失。
// 运行时用 node:sqlite（Node 26 自带，零依赖）；FTS5 若宿主编译缺失，自动降级为 JS 扫描。

import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'episode'
    CHECK(kind IN ('episode','fact','reflection','skill','lesson','procedural','emotion_event','media')),
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

/** 打开数据库：WAL + 建表 + FTS 可用性探测（缺失则降级 JS 扫描，检索层负责） */
export function openDb(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(SCHEMA)
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
