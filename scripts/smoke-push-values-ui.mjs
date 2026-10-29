import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'

// Run after electron-vite build. Uses a disposable profile and preview only.
const root = resolve(import.meta.dirname, '..')
const profile = await mkdtemp(join(tmpdir(), 'visslm-push-values-ui-'))
const artifacts = join(root, 'artifacts', 'push-values-ui')
await mkdir(artifacts, { recursive: true })
const chunk = (await readdir(join(root, 'out/main/chunks'))).find((name) => /^database-.*\.js$/.test(name))
const module = await import(pathToFileURL(join(root, 'out/main/chunks', chunk)).href)
const Database = Object.values(module).find((value) => typeof value === 'function' && value.name === 'AppDatabase')
const db = new Database(join(profile, 'visslm-agent.db'), join(profile, 'assets'))
db.setSetting('platform.baseUrl', 'http://127.0.0.1:1/alm')
for (const feature of ['dashboard', 'data', 'chat', 'sync', 'push', 'projects']) db.setSetting(`feature.${feature}`, 'true')
db.upsertRecord({ uid: 'push-ui', projectId: 'source', nodeType: 'Task', itemId: 'UI-1', parentId: '', name: '用户映射验证',
  lastModifyTime: '', normalizedText: '用户映射验证', raw: { RAO: 'alice.ext;bob.ext', _valm_Name: '用户映射验证' } })
db.close()
const portServer = createServer()
await new Promise((done) => portServer.listen(0, '127.0.0.1', done))
const port = portServer.address().port
await new Promise((done) => portServer.close(done))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const electron = spawn(createRequire(import.meta.url)('electron'), ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--disable-gpu'], {
  cwd: root, env, windowsHide: true, stdio: 'ignore'
})
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let socket
let sequence = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((done, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 20000)
  pending.set(id, (result) => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : done(result.result) })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
  return result.result?.value
}
const waitFor = async (expression) => {
  for (let i = 0; i < 100; i++) {
    try { if (await evaluate(expression)) return } catch { /* startup reload */ }
    await sleep(150)
  }
  throw new Error(`UI condition not met: ${expression}`)
}
const navigate = async (label) => {
  assert.equal(await evaluate(`(() => { const item = [...document.querySelectorAll('.ant-menu-item')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); item?.click(); return !!item })()`), true, label)
  await sleep(350)
}
const openOptions = async () => {
  await navigate('数据推送')
  await waitFor(`!!document.querySelector('.push-value-options')`)
  for (let index = 0; index < 2; index++) {
    await evaluate(`document.querySelectorAll('.push-value-options > .ant-collapse-item')[${index}]?.querySelector('.ant-collapse-header[aria-expanded="false"]')?.click()`)
    await sleep(100)
  }
  await sleep(250)
}
try {
  let target
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page') } catch { /* startup */ }
    if (target) break
    await sleep(200)
  }
  assert.ok(target, 'Electron target ready')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done) => socket.once('open', done))
  socket.on('message', (raw) => { const message = JSON.parse(String(raw)); pending.get(message.id)?.(message); pending.delete(message.id) })
  await waitFor(`!!document.querySelector('.ant-menu-item') && !!window.visslm`)
  await evaluate(`window.visslm.savePlatformSettings({ baseUrl: 'http://127.0.0.1:1/alm', username: 'smoke-user', token: 'smoke-token' })`)
  const draft = {
    version: 3, formValues: { nodeType: 'Task', projectId: 'internal' },
    fieldMappings: [{ id: 'dev', sourceField: 'RAO', targetField: 'Devs' }], mappingInitialized: true,
    selectedRowKeys: ['push-ui'], search: '', page: 1, pageSize: 20,
    valueOptions: { userMappingFields: ['Devs'], userMappings: [
      { id: 'alice', sourceLogin: 'alice.ext', targetLogin: 'alice.internal' },
      { id: 'bob', sourceLogin: 'bob.ext', targetLogin: 'bob.internal' }
    ], fixedParameters: [
      { id: 'fixed', location: 'body', key: 'Priority', valueType: 'json', value: '3' },
      { id: 'query', location: 'query', key: 'workflow', valueType: 'text', value: 'internal' }
    ] }
  }
  await evaluate(`localStorage.setItem('visslm:push-config-draft:v3', ${JSON.stringify(JSON.stringify(draft))})`)
  await openOptions()
  assert.equal(await evaluate(`document.querySelectorAll('input[aria-label="源平台登录名"]').length`), 2)
  // Exercise controlled editor updates and restore them after a full reload.
  await evaluate(`(() => { const input = document.querySelector('input[aria-label="内网登录名或能力名"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'alice.changed'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await waitFor(`JSON.parse(localStorage.getItem('visslm:push-config-draft:v3')).valueOptions.userMappings[0].targetLogin === 'alice.changed'`)
  const widthBefore = await evaluate(`Number(document.querySelector('.push-value-options .project-table-resize-handle').getAttribute('aria-valuenow'))`)
  await evaluate(`(() => { const handle = document.querySelector('.push-value-options .project-table-resize-handle'); handle.focus(); handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); })()`)
  await sleep(100)
  assert.equal(await evaluate(`Number(document.querySelector('.push-value-options .project-table-resize-handle').getAttribute('aria-valuenow'))`), widthBefore + 12)
  await evaluate(`(() => { const handle = document.querySelector('.push-value-options .project-table-resize-handle'); handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: 100 })); window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 124 })); window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: 124 })); })()`)
  await sleep(150)
  const expectedWidth = widthBefore + 36
  assert.equal(await evaluate(`Number(document.querySelector('.push-value-options .project-table-resize-handle').getAttribute('aria-valuenow'))`), expectedWidth)
  await call('Page.reload')
  await sleep(600)
  await waitFor(`!!document.querySelector('.ant-menu-item') && !!window.visslm`)
  await openOptions()
  assert.equal(await evaluate(`document.querySelector('input[aria-label="内网登录名或能力名"]').value`), 'alice.changed')
  assert.equal(await evaluate(`Number(document.querySelector('.push-value-options .project-table-resize-handle').getAttribute('aria-valuenow'))`), expectedWidth)
  await evaluate(`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === '测试预览').click()`)
  await waitFor(`!!document.querySelector('.push-request-collapse .ant-collapse-header')`)
  await evaluate(`document.querySelector('.push-request-collapse .ant-collapse-header').click()`)
  await waitFor(`document.body.textContent.includes('alice.changed;bob.internal')`)
  const preview = await evaluate(`window.visslm.previewPush({ ...JSON.parse(localStorage.getItem('visslm:push-config-draft:v3')).formValues, ...JSON.parse(localStorage.getItem('visslm:push-config-draft:v3')).valueOptions, recordUids: ['push-ui'], fieldMappings: [{ id: 'dev', sourceField: 'RAO', targetField: 'Devs' }] })`)
  assert.equal(preview.requests[0].body.Devs, 'alice.changed;bob.internal')
  assert.equal(preview.requests[0].body.Priority, 3)
  assert.equal(preview.requests[0].params.workflow, 'internal')
  await navigate('资产中心')
  await openOptions()
  const matrix = []
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.querySelector('[aria-label="切换到${theme === 'dark' ? '暗' : '亮'}色主题"]')?.click()`)
    for (const [width, height] of [[1440, 1000], [1200, 800], [1000, 700]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await sleep(200)
      await evaluate(`document.querySelector('.push-value-options').scrollIntoView({ block: 'start' })`)
      const state = await evaluate(`(() => {
        const tables = [...document.querySelectorAll('.push-value-options .ant-table-body')];
        return { handles: document.querySelectorAll('.push-value-options .project-table-resize-handle').length,
          maxHeights: tables.map(el => getComputedStyle(el).maxHeight),
          background: getComputedStyle(document.querySelector('.push-value-options')).backgroundColor,
          overflow: document.documentElement.scrollWidth > innerWidth };
      })()`)
      assert.equal(state.handles, 8)
      assert.ok(state.maxHeights.every((height) => height !== 'none' && parseFloat(height) > 0))
      assert.equal(state.overflow, false)
      matrix.push({ theme, width, height, ...state })
      if (width === 1440) {
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        await writeFile(join(artifacts, `${theme}.png`), Buffer.from(shot.data, 'base64'))
      }
    }
    for (const page of ['数据概览', '资产中心', 'AI 助手', '数据采集', '项目管理', '系统配置']) {
      await navigate(page)
      assert.ok(await evaluate(`document.querySelector('#root').textContent.length > 50`), `${theme}: ${page}`)
    }
    await openOptions()
  }
  await writeFile(join(artifacts, 'checks.json'), JSON.stringify({ ok: true, matrix, preview: preview.requests[0] }, null, 2))
  // Overflow belongs to each table body, even with many mapping rows.
  for (let index = 0; index < 10; index++) {
    await evaluate(`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === '新增用户映射').click()`)
    await sleep(30)
  }
  const scrolling = await evaluate(`(() => { const body = document.querySelector('.push-value-options .ant-table-body'); body.scrollTop = 100; return { height: body.clientHeight, scrollHeight: body.scrollHeight, scrollTop: body.scrollTop, overflowY: getComputedStyle(body).overflowY } })()`)
  assert.ok(scrolling.scrollHeight > scrolling.height && scrolling.scrollTop > 0)
  assert.ok(['auto', 'scroll'].includes(scrolling.overflowY))
  console.log(JSON.stringify({ ok: true, checks: ['editor persistence', 'keyboard and pointer resizing', 'width restoration', 'IPC preview', 'dark/light desktop matrix', 'six-page navigation'], artifacts }))
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    console.error(await evaluate(`({ text: document.querySelector('.push-value-options')?.textContent.slice(0, 1200), messages: [...document.querySelectorAll('.ant-message-notice')].map(el => el.textContent) })`))
  }
  throw error
} finally {
  socket?.close()
  if (electron.exitCode === null && electron.pid) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(electron.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else electron.kill()
  }
  await sleep(300)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
