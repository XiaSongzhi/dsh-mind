/**
 * 构建面板：把 panel/src 下的 CSS 与 JS 内联进 panel/index.html
 *
 * 为什么需要构建：
 *   后端只暴露三条静态路由：
 *     GET /dsh-mind-api/panel          → panel/index.html
 *     GET /dsh-mind-api/universe.js    → panel/universe.js
 *     GET /dsh-mind-api/vendor/*       → panel/vendor/*
 *   它**不服务** panel/src/*。所以 src 里的样式与逻辑必须在构建阶段
 *   内联成单文件，否则浏览器拿到 404，页面白屏。
 *
 * 用法：
 *   npm run build
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/* scripts/ 的上一级就是项目根目录 */
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PANEL = join(ROOT, 'panel')
const SRC = join(PANEL, 'src')

const templatePath = join(PANEL, 'template.html')
if (!existsSync(templatePath)) {
  console.error('✗ 缺少 panel/template.html')
  console.error('  期望路径: ' + templatePath)
  process.exit(1)
}

let html = readFileSync(templatePath, 'utf8')

/* ① 内联模板里所有 CSS 外链 */
const linkRe = /<link rel="stylesheet" href="\/dsh-mind-api\/panel\/src\/([^"]+)">\n?/g
let cssBundle = ''
let cssCount = 0

html = html.replace(linkRe, (m, name) => {
  const p = join(SRC, name)
  if (!existsSync(p)) {
    console.error('✗ 缺少样式文件: ' + name)
    process.exit(1)
  }
  cssBundle += '/* ==== ' + name + ' ==== */\n' + readFileSync(p, 'utf8') + '\n'
  cssCount++
  return ''
})

/* ② 内联 app.js */
const JS_MARK = '<script type="module" src="/dsh-mind-api/panel/src/app.js"></script>'
if (!html.includes(JS_MARK)) {
  console.error('✗ 模板缺少 app.js 外链')
  process.exit(1)
}
const appPath = join(SRC, 'app.js')
if (!existsSync(appPath)) {
  console.error('✗ 缺少 panel/src/app.js')
  process.exit(1)
}
const app = readFileSync(appPath, 'utf8')
html = html.split(JS_MARK).join('<script type="module">\n' + app + '\n</script>')

/* ③ 把 CSS 塞进 </head> 前 */
html = html.replace('</head>', '<style>\n' + cssBundle + '</style>\n</head>')

/* ④ 写盘 */
writeFileSync(join(PANEL, 'index.html'), html, 'utf8')

/* ⑤ 自检 */
const checks = {
  '样式已内联': html.includes('--bg-void') && html.includes('.sky-stage'),
  '前端逻辑已内联': html.includes('function boot'),
  '星图外链保留': html.includes('/dsh-mind-api/universe.js'),
  '面板大小合理(<400KB)': html.length < 400 * 1024,
}

console.log('✓ 构建完成: panel/index.html (' + (html.length / 1024).toFixed(1) +
  ' KB, 内联 ' + cssCount + ' 个 CSS)')
let bad = 0
for (const k of Object.keys(checks)) {
  console.log('  ' + (checks[k] ? '✓' : '✗') + ' ' + k)
  if (!checks[k]) bad++
}
if (bad) process.exit(1)
