import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const output = resolve('artifacts/dashboard-generation-remediation')
await mkdir(output, { recursive: true })
const live = process.argv.includes('--live')
const entry = join(output, live ? 'live-electron.cjs' : 'render-smoke.cjs')
const html = resolve('out/renderer/dashboard-preview.html')
const code = `
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { renderDashboardPreview } from './src/main/dashboards/render-preview'
import { QueryEngine } from './src/main/analytics/query-engine'
import { VisualizationAgent } from './src/main/experts/visualization-agent'
import { DashboardGenerationSession } from './src/main/dashboards/generation-tools'
app.setPath('userData', ${JSON.stringify(join(output, live ? 'live-profile' : 'render-profile'))})
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
 const records = Array.from({ length: 16 }, (_, i) => ({ uid: String(i), projectId: 'synthetic', nodeType: 'Issue', itemId: 'I-' + i, name: '问题 ' + i, lastModifyTime: '2026-10-01', raw: { 状态: i % 2 ? '处理中' : '完成', 地区: i % 2 ? '南区' : '北区', 风险分: i + 1 } }))
 const scope = { projectIds: ['synthetic'] }
 const engine = new QueryEngine({ scanAnalyticsRecords: () => records })
 const generated = []
 if (${live}) {
  const fetchModel = globalThis.fetch
  globalThis.fetch = async (url, init) => {
   const response = await fetchModel(url, init)
   if (String(url).endsWith('/api/chat')) { const payload = await response.clone().json(); const request = JSON.parse(String(init?.body)); console.log(JSON.stringify({ modelStage: request.messages[0]?.content.slice(0, 60), reply: payload.message }).slice(0, 14000)) }
   return response
  }
  const invoke = DashboardGenerationSession.prototype.handle
  DashboardGenerationSession.prototype.handle = async function(request) {
   const result = await invoke.call(this, request)
   if (request.method === 'tools/call') console.log(JSON.stringify({ tool: request.params?.name, arguments: request.params?.arguments, error: result?.result?.isError ? result.result.content : result?.error }).slice(0, 2200))
   return result
  }
  const started = Date.now()
  let renderIndex = 0
  const agent = new VisualizationAgent(engine, { source: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: process.env.VISSLM_EVAL_MODEL || 'qwen3.8:27b', thinking: false }, run => { console.log(JSON.stringify({ mode: 'live', status: run.status, tools: run.toolCalls.map(item => item.tool), error: run.errorMessage })) }, event => console.log(JSON.stringify(event)), { renderPreview: async spec => {
   const result = await renderDashboardPreview(spec, undefined, ${JSON.stringify(html)})
   writeFileSync(${JSON.stringify(output)} + '/live-attempt-' + (++renderIndex) + '.png', Buffer.from(result.screenshot.data, 'base64'))
   console.log(JSON.stringify({ renderIssues: result.issues }))
   return result
  } })
  const spec = await agent.generate('基于当前问题数据生成大屏，展示记录总量和按状态的问题数量分布。', scope)
  if (!spec.generationEvidence?.rendered || !spec.components.some(item => item.query?.dimensions?.some(dim => dim.field === '状态'))) throw Error('真实模型没有生成经过渲染验收的状态分析')
  const preview = await renderDashboardPreview(spec, undefined, ${JSON.stringify(html)})
  writeFileSync(${JSON.stringify(join(output, 'live.png'))}, Buffer.from(preview.screenshot.data, 'base64'))
  generated.push({ ok: true, elapsedMs: Date.now() - started, components: spec.components.map(item => ({ type: item.type, title: item.title, query: item.query })), evidence: spec.generationEvidence })
 } else {
  for (const theme of ['technology-dark','business-light','charcoal-dark','minimal-light']) {
   const spec = { schemaVersion: '1.0', id: 'render-' + theme, title: '问题数据概览', subtitle: '隔离的桌面渲染验收', theme, updatedAt: new Date().toISOString(), components: [
    { id: 'total', type: 'kpi', title: '问题总量', layout: { x: 0, y: 0, w: 6, h: 4 }, data: [{ name: '问题', value: 16 }] },
    ...['bar','pie','insight'].map((type, i) => ({ id: type, type, title: '问题状态分布', layout: { x: (i + 1) * 6, y: 0, w: 6, h: 4 }, data: [{ name: '处理中', value: 8 }, { name: '完成', value: 8 }] })) ] }
   const preview = await renderDashboardPreview(spec, undefined, ${JSON.stringify(html)})
   writeFileSync(${JSON.stringify(output)} + '/' + theme + '.png', Buffer.from(preview.screenshot.data, 'base64'))
   if (!preview.rendered || preview.componentCount !== 4 || preview.issues.length) throw Error(JSON.stringify({ theme, preview: { ...preview, screenshot: undefined } }))
   generated.push({ theme, ok: true, componentCount: preview.componentCount })
   console.log(JSON.stringify(generated.at(-1)))
  }
 }
 writeFileSync(${JSON.stringify(join(output, live ? 'live-result.json' : 'render-result.json'))}, JSON.stringify(generated, null, 2))
 app.exit(0)
}).catch(error => { console.error(error.stack); app.exit(1) })
`
await build({ stdin: { contents: code, resolveDir: process.cwd(), loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(createRequire(import.meta.url)('electron'), [entry, '--disable-gpu'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
child.stdout.on('data', buffer => { logs += buffer; process.stdout.write(buffer) })
child.stderr.on('data', buffer => { logs += buffer; process.stderr.write(buffer) })
const timer = setTimeout(() => child.kill(), live ? 600_000 : 60_000)
const exit = await new Promise<number | null>((done, reject) => { child.on('exit', done); child.on('error', reject) })
clearTimeout(timer)
await writeFile(join(output, live ? 'live-log.txt' : 'render-log.txt'), logs)
assert.equal(exit, 0, '隔离 Electron 验收未通过')
console.log(await readFile(join(output, live ? 'live-result.json' : 'render-result.json'), 'utf8'))
