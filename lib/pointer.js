// dsh-mind / pointer.js —— 存储指针 + mood 数据一次性导入（拷贝式，mood 文件零改动）
//
// 指针：$DSH_HOME/dsh-mind-store.json → { "default": "D:\\x", "dirs": {...} }
// 迁移：首次启动检测 dsh-mood-memory.jsonl → memories(kind=episode, source='mood-archive')
//       全程读源写新，源文件不动；迁移前自动备份到 <dataDir>/backup/<ts>/
// 回滚：卸载 dsh-mind + 重装 dsh-mood——mood 数据从未被写坏。

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}
// 惰性求值：测试会改 DSH_HOME，路径必须在调用时算
export function pointerFile() { return join(dshHome(), 'dsh-mind-store.json') }
export function moodPointerFile() { return join(dshHome(), 'dsh-mood-store.json') }

export function readPointer() {
  try {
    if (!existsSync(pointerFile())) return { default: null, dirs: {}, migrated: undefined }
    const j = JSON.parse(readFileSync(pointerFile(), 'utf8')) || {}
    return { default: j.default || null, dirs: j.dirs || {}, migrated: j.migrated }
  } catch { return { default: null, dirs: {}, migrated: undefined } }
}

export function writePointer(p) {
  mkdirSync(dshHome(), { recursive: true })
  writeFileSync(pointerFile(), JSON.stringify(p, null, 2))
}

export function dataDir(cfg = {}) {
  const p = readPointer()
  return cfg.dataDir || p.default || join(dshHome(), 'dsh-mind')
}

export function moodDataDir() {
  try {
    const j = JSON.parse(readFileSync(moodPointerFile(), 'utf8')) || {}
    return j.default || j.dir || dshHome()
  } catch { return dshHome() }
}

export function moodArchiveFile() {
  try {
    const j = JSON.parse(readFileSync(moodPointerFile(), 'utf8')) || {}
    const dir = j.default || j.dir
    return dir ? join(dir, 'dsh-mood-memory.jsonl') : join(dshHome(), 'dsh-mood-memory.jsonl')
  } catch { return join(dshHome(), 'dsh-mood-memory.jsonl') }
}

/** mood memory.jsonl 行格式映射（实测字段：{id, t, s, k:'u'|'a', x}）→ 记忆行。null=跳过 */
export function mapMoodLine(line, { onlyUser = false } = {}) {
  try {
    const o = JSON.parse(line)
    const text = String(o.x ?? o.text ?? o.content ?? '').trim()
    if (text.length < 6) return null                       // 手册：短句不入库污染检索
    if (onlyUser && o.k !== 'u') return null               // onlyUser 模式只收用户消息
    if (!['u', 'a'].includes(o.k)) return null
    return {
      kind: 'episode',
      text,
      importance: o.k === 'u' ? 0.6 : 0.45,                // 用户侧记忆默认更值得留
      valence: 0,
      entities: [],
      source: 'mood-archive',
      source_refs: [o.s ? `session:${o.s}` : 'mood', `msg:${o.id || ''}`].filter((x) => x !== 'msg:'),
      confirmed: 0,
      is_inference: 0,                                     // 归档原文是真实发生过的对话
      created_at: Number(o.t) || undefined,
    }
  } catch { return null }
}

/**
 * 导入 mood 归档。store: memory.js 的 store；返回 {imported, skipped, backupDir|null}
 * 幂等：meta 表记 migrated_at，重复启动不重复导入。
 */
export function importMoodArchive(store, { db, dataDir, pointerFilePath = pointerFile(), force = false } = {}) {
  const done = db.prepare("SELECT value FROM meta WHERE key='mood_archive_imported_at'").get()
  if (done && !force) return { imported: 0, skipped: 0, reason: 'already-imported' }
  const file = moodArchiveFile()
  if (!existsSync(file)) return { imported: 0, skipped: 0, reason: 'no-mood-archive' }
  let backupDir = null
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    backupDir = join(dataDir, 'backup', ts)
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(file, join(backupDir, 'dsh-mood-memory.jsonl'))
    if (existsSync(moodPointerFile())) copyFileSync(moodPointerFile(), join(backupDir, 'dsh-mood-store.json'))
  } catch { backupDir = null } // 备份失败不阻塞导入（源文件本来就只读）

  const raw = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  let imported = 0, skipped = 0
  for (const line of raw) {
    const mapped = mapMoodLine(line)
    if (!mapped) { skipped++; continue }
    try {
      const r = store.note(mapped)
      if (r.duplicateOf) skipped++; else imported++
    } catch { skipped++ }
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('mood_archive_imported_at', ?)").run(String(now()))
  try { writeFileSync(pointerFile, JSON.stringify({ ...(readPointer()), migrated: { at: now(), imported, skipped, from: file } }, null, 2)) } catch {}
  return { imported, skipped, backupDir }
}

function now() { return Date.now() }
