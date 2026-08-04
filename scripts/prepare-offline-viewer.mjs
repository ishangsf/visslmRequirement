import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const outputRoot = join(projectRoot, 'out', 'offline')
const htmlPath = join(outputRoot, 'index.html')
const cssPath = join(outputRoot, 'dashboard-viewer.css')
const cssSources = [
  join(projectRoot, 'node_modules', 'react-grid-layout', 'css', 'styles.css'),
  join(projectRoot, 'node_modules', 'react-resizable', 'css', 'styles.css'),
  join(projectRoot, 'src', 'renderer', 'src', 'styles.css'),
  join(projectRoot, 'src', 'renderer', 'offline', 'offline.css')
]

if (!existsSync(htmlPath)) throw new Error('离线 viewer 构建未生成 index.html')

let html = readFileSync(htmlPath, 'utf8')
const moduleScript = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/i)
if (!moduleScript) throw new Error('离线 viewer 入口脚本未找到')

let styleLink = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/i)
const css = cssSources.map((sourcePath) => {
  if (!existsSync(sourcePath)) throw new Error(`离线 viewer CSS 依赖未找到: ${sourcePath}`)
  return readFileSync(sourcePath, 'utf8')
}).join('\n\n')

if (!styleLink) {
  const offlineStyleLink = '<link rel="stylesheet" href="./dashboard-viewer.css" />'
  html = html.replace(moduleScript[0], `${offlineStyleLink}\n    ${moduleScript[0]}`)
  styleLink = [offlineStyleLink]
}
const offlineScripts = [
  '<script src="./dashboard-data.js"></script>',
  '<script src="./dashboard-viewer.js"></script>'
].join('\n    ')
html = html.replace(moduleScript[0], '')
const bodyEnd = html.search(/<\/body>/i)
if (bodyEnd === -1) throw new Error('离线 viewer HTML 缺少 body 结束标签')
html = `${html.slice(0, bodyEnd)}    ${offlineScripts}\n  ${html.slice(bodyEnd)}`
if (styleLink) {
  html = html.replace(styleLink[0], '<link rel="stylesheet" href="./dashboard-viewer.css" />')
} else {
  const headEnd = html.search(/<\/head>/i)
  if (headEnd === -1) throw new Error('离线 viewer HTML 缺少 head 结束标签')
  html = `${html.slice(0, headEnd)}    <link rel="stylesheet" href="./dashboard-viewer.css" />\n  ${html.slice(headEnd)}`
}
writeFileSync(htmlPath, html, 'utf8')
writeFileSync(cssPath, `${css}\n`, 'utf8')

console.log(JSON.stringify({ ok: true, outputRoot }, null, 2))
