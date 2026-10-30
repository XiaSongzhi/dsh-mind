/**
 * 一次性导入外部 jsonl 归档
 *
 * 用法：
 *   node scripts/import-archive.mjs <path-to-archive.jsonl>
 *
 * 归档每行格式：{"t": 时间戳, "k": "u"|"a", "x": 正文}
 * 幂等：导入过一次就会记住，重复执行不会重复灌入。
 * 加 --force 可强制重跑。
 */
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { createMemoryStore } from '../lib/memory.js'
import { dataDir, importArchive } from '../lib/pointer.js'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/import-archive.mjs <archive.jsonl> [--force]')
  process.exit(1)
}

const force = process.argv.includes('--force')
const dd = dataDir({})
const db = openDb(join(dd, 'memory.db'))
const store = createMemoryStore(db, { log: console.log })

console.log('数据目录: ' + dd)
console.log('归档文件: ' + file)
if (force) console.log('已指定 --force，将强制重跑')

const r = importArchive(store, { db, dataDir: dd, file, force })

console.log('')
console.log('结果: ' + r.reason)
if (r.imported || r.skipped) {
  console.log('  导入 ' + r.imported + ' 条，跳过 ' + r.skipped + ' 条')
}
if (r.backupDir) console.log('  备份已落到 ' + r.backupDir)
console.log('  当前库内记忆: ' + store.stats().total + ' 条')
