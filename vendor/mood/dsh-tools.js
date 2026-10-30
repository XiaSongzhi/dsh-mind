// vendor/mood/dsh-tools.js —— @deepseek-ai/dsh-tools 的 defineTool 解析链
//
// 背景：裸 import('@deepseek-ai/dsh-tools') 只在 DSH 宿主模块钩子覆盖下解析；
// dsh-mind 的 vendor 副本链上没有 node_modules，裸 import 在多数环境直接失败
// （线上实测即如此）——所以这里按优先级解析，且**永远**返回一个可用的 defineTool：
//   ① 裸包名（宿主钩子环境）
//   ② 物理 ESM 副本（DSH_TOOLS_LIB 可覆盖；默认指本机 DSH 源码树，2026-10-29 实测可 import）
//   ③ 本地忠实回退——不依赖任何外部文件，工具照样能注册
//
// ③ 的产物与真库 2026-10-29 实测逐字节对齐（deepseek-harness-master 的 0.2.1-rc.2）：
//   parameterSchemaSpecToJsonSchema({a:{type:'string',enum,description},…}) →
//     {"type":"object","properties":{"a":{"type":"string","description":"…","enum":[…]}}}
//   valueSchemaSpecToJsonSchema({type:'json'}) → {}
//   defineTool 返回 {name,description,parameters,output:{schema,render},execute}（丢弃未知键）
// 仅支持本仓库实际用到的子集（string/number/boolean/array + description/enum），
// 其它 spec 在加载期就抛错——绝不静默退化成会被 DSH 注册校验拒绝的形状。
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PHYSICAL_CANDIDATES = [
  process.env.DSH_TOOLS_LIB,
  '${HOME}/Documents/deepseek-harness-master/packages/acp/acp/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
].filter(Boolean)

function localParamSchema(spec) {
  if (spec === undefined || spec === null) spec = {}
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`[dsh-mind] 本地 defineTool 回退不支持该 parameters spec：${JSON.stringify(spec)}`)
  }
  const properties = {}
  for (const [k, p] of Object.entries(spec)) {
    if (!p || typeof p !== 'object' || typeof p.type !== 'string') {
      throw new Error(`[dsh-mind] 本地 defineTool 回退不支持属性 "${k}"：${JSON.stringify(p)}（需要 {type:'string'|'number'|'boolean'|'array', description?, enum?}）`)
    }
    const node = { type: p.type }
    if (p.description !== undefined) node.description = String(p.description)
    if (Array.isArray(p.enum)) node.enum = [...p.enum]
    properties[k] = node
  }
  return { type: 'object', properties }
}

function localValueSchema(schema) {
  // 本仓库只用 {type:'json'}（真库编译为空前缀 schema）
  if (!schema || (typeof schema === 'object' && !Array.isArray(schema) && (schema.type === 'json' || Object.keys(schema).length === 0))) return {}
  throw new Error(`[dsh-mind] 本地 defineTool 回退不支持该 output.schema：${JSON.stringify(schema)}（只用 {type:'json'}）`)
}

function localDefineTool(def) {
  if (!def || !def.name) throw new Error('[dsh-mind] defineTool(def) 缺 name')
  if (!def.output || typeof def.output.render !== 'function') {
    throw new Error(`[dsh-mind] 工具 "${def.name}" 缺 output: { schema, render }（DSH 注册硬性要求）`)
  }
  const output = { schema: localValueSchema(def.output.schema), render: def.output.render }
  if (typeof def.output.presentationMeta === 'function') output.presentationMeta = def.output.presentationMeta
  const tool = {
    name: def.name,
    description: def.description,
    parameters: localParamSchema(def.parameters),
    output,
    execute: def.execute,
  }
  if (def.timeoutMs !== undefined) tool.timeoutMs = def.timeoutMs
  if (def.deferLoading === true) tool.deferLoading = true
  return tool
}

let real = null
let source = 'local'
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod?.defineTool === 'function') { real = mod.defineTool; source = 'bare' }
} catch { /* 无宿主钩子的环境到不了——继续试物理副本 */ }
if (!real) {
  for (const cand of PHYSICAL_CANDIDATES) {
    try {
      const mod = await import(pathToFileURL(path.resolve(cand)).href)
      if (typeof mod?.defineTool === 'function') { real = mod.defineTool; source = 'file'; break }
    } catch { /* 试下一个候选 */ }
  }
}
if (!real) {
  console.error('[dsh-mind] dsh-tools 真库不可用——defineTool 使用本地忠实回退（产物形状与真库对齐，工具注册不受影响）')
}

let warned = false
export const defineToolSource = source
export function defineTool(def) {
  if (real) {
    try { return real(def) } catch (e) {
      if (!warned) { warned = true; console.error('[dsh-mind] 真库 defineTool 拒绝了一个定义，落回本地回退：', e?.message ?? e) }
    }
  }
  return localDefineTool(def)
}
