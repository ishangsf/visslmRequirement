import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { DashboardComponentSpec, DashboardSpec } from '../src/shared/dashboard'
import { dashboardGoldenScenarios } from '../src/main/experts/dashboard-golden'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { AppDatabase } from '../src/main/database'
import { comparePngBuffers } from '../src/main/experts/visual-pixel-diff'
import type { AnalyticsRecord } from '../src/main/database'

type CdpMessage = {
  id?: number
  result?: {
    result?: { value?: unknown }
    data?: string
    exceptionDetails?: {
      text?: string
      exception?: { description?: string; value?: unknown }
    }
  }
  error?: { message?: string }
}

type CdpPending = {
  resolve: (message: CdpMessage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type Viewport = { width: number; height: number }

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cdpPort = Number(process.env.VISSLM_VISUAL_CDP_PORT ?? 9227)
const rendererUrl = process.env.VISSLM_RENDERER_URL?.trim() || ''
const updateBaselines = process.env.VISSLM_UPDATE_VISUAL_BASELINES === '1'
const baselineDirectory = resolve(
  repoRoot,
  process.env.VISSLM_VISUAL_BASELINE_DIR ?? 'tests/visual-baselines/dashboard'
)
const artifactDirectory = mkdtempSync(join(tmpdir(), 'visslm-dashboard-visual-artifacts-'))
const userDataDirectory = mkdtempSync(join(tmpdir(), 'visslm-dashboard-visual-user-data-'))

const defaultViewport: Viewport = { width: 1920, height: 1080 }

const parseViewports = (value: string | undefined): Viewport[] => {
  const raw = value?.trim()
  if (!raw) return [defaultViewport]
  const seen = new Set<string>()
  const viewports = raw.split(/[\s,]+/).flatMap((token): Viewport[] => {
    const match = /^(\d+)x(\d+)$/i.exec(token)
    if (!match) throw new Error(`Invalid visual viewport: ${token}. Expected WIDTHxHEIGHT.`)
    const width = Number(match[1])
    const height = Number(match[2])
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || height < 480 || width > 8192 || height > 8192) {
      throw new Error(`Visual viewport is outside the supported range: ${token}`)
    }
    const key = `${width}x${height}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ width, height }]
  })
  return viewports.length ? viewports : [defaultViewport]
}

const viewports = parseViewports(process.env.VISSLM_VISUAL_VIEWPORTS)

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const fixtureRows = (records: AnalyticsRecord[]): Array<Record<string, unknown>> => records.map((record) => ({
  documentId: `${record.nodeType}:${record.uid}`,
  title: record.name,
  content: 'deterministic visual fixture',
  metadata: {
    projectId: record.projectId,
    recordType: record.nodeType,
    sourceId: record.uid,
    itemId: record.itemId,
    updatedAt: record.lastModifyTime
  },
  raw: record.raw
}))

const dataPointsFor = (
  component: DashboardComponentSpec,
  rows: Array<Record<string, string | number | boolean | null>>
): DashboardComponentSpec['data'] => {
  const valueField = component.encoding?.value
  if (!valueField) return []
  const labelField = component.encoding?.label
  const secondaryField = component.encoding?.secondaryValue
  return rows.map((row, index) => ({
    name: String(labelField ? row[labelField] ?? `Data ${index + 1}` : component.title),
    value: Number(row[valueField] ?? 0),
    ...(secondaryField
      ? { secondaryValue: Number(row[secondaryField] ?? 0) }
      : {})
  }))
}

const createFixtureSpecs = (): DashboardSpec[] => {
  const databasePath = join(userDataDirectory, 'visslm-agent.db')
  const assetDirectory = join(userDataDirectory, 'assets', 'base64')
  const database = new AppDatabase(databasePath, assetDirectory)
  try {
    const rows = dashboardGoldenScenarios.flatMap((scenario) => fixtureRows(scenario.records))
    const imported = database.importRows(rows)
    assert.equal(imported.recordCount, rows.length, 'golden fixture records should be imported')
    const queryEngine = new QueryEngine(database)
    return dashboardGoldenScenarios.map((scenario) => {
      const spec = clone(scenario.spec)
      spec.components = spec.components.map((component) => {
        const dataset = queryEngine.execute(component.query!)
        return {
          ...component,
          data: dataPointsFor(component, dataset.rows)
        }
      })
      return spec
    })
  } finally {
    database.close()
  }
}

const waitForCdp = async (
  process: ChildProcessWithoutNullStreams,
  port: number,
  timeoutMs = 30_000
): Promise<Array<{ type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string }>> => {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Electron exited before CDP started (${process.exitCode}): ${lastError}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json() as Array<{
          type?: string
          title?: string
          url?: string
          webSocketDebuggerUrl?: string
        }>
        if (targets.some((target) =>
          target.type === 'page' &&
          target.webSocketDebuggerUrl &&
          target.url &&
          target.url !== 'about:blank'
        )) {
          return targets
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for Electron CDP: ${lastError}`)
}

const connectCdp = async (
  targetUrl: string
): Promise<{
  call: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<CdpMessage>
  evaluate: <T = unknown>(expression: string, timeoutMs?: number) => Promise<T>
  close: () => void
}> => {
  const socket = new WebSocket(targetUrl)
  await new Promise<void>((resolvePromise, reject) => {
    socket.once('open', () => resolvePromise())
    socket.once('error', reject)
  })
  let sequence = 0
  const pending = new Map<number, CdpPending>()
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString('utf8')) as CdpMessage
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    request.resolve(message)
  })
  const call = (
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<CdpMessage> =>
    new Promise((resolvePromise, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        const detail = method === 'Runtime.evaluate'
          ? ` (${String(params.expression ?? '').slice(0, 140)})`
          : ''
        reject(new Error(`CDP call timed out: ${method}${detail}`))
      }, timeoutMs)
      pending.set(id, { resolve: resolvePromise, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async <T = unknown>(expression: string, timeoutMs = 30_000): Promise<T> => {
    const response = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs)
    if (response.error) throw new Error(response.error.message || 'CDP evaluation failed')
    const exceptionDetails = response.result?.exceptionDetails
    if (exceptionDetails) {
      throw new Error(
        exceptionDetails.exception?.description ||
        exceptionDetails.text ||
        String(exceptionDetails.exception?.value || 'Renderer evaluation failed')
      )
    }
    return response.result?.result?.value as T
  }
  return {
    call,
    evaluate,
    close: () => socket.close()
  }
}

const waitForRenderer = async (
  evaluate: <T = unknown>(expression: string) => Promise<T>,
  scenarioCount?: number,
  scenarioTitle?: string
): Promise<void> => {
  const ready = await evaluate<boolean>(`(async () => {
    const started = Date.now()
    while (Date.now() - started < 30000) {
      const studio = document.querySelector('.dashboard-studio')
      const widgets = document.querySelectorAll('.dashboard-widget').length
      const title = document.querySelector('.dashboard-preview-header h2')?.textContent?.trim() ?? ''
      if (
        studio &&
        (!${scenarioCount ?? 0} || widgets >= ${scenarioCount ?? 0}) &&
        (!${JSON.stringify(scenarioTitle ?? '')} || title === ${JSON.stringify(scenarioTitle ?? '')})
      ) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  })()`)
  assert.equal(ready, true, 'DashboardStudio should render within the timeout')
}

const selectDashboard = async (
  evaluate: <T = unknown>(expression: string) => Promise<T>,
  spec: DashboardSpec
): Promise<void> => {
  const opened = await evaluate<boolean>(`(() => {
    const root = document.querySelector('.dashboard-selector')
    const selector = root?.querySelector('.ant-select-selector')
    const input = root?.querySelector('input')
    selector?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
    selector?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    input?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
    input?.click()
    input?.focus()
    input?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      bubbles: true,
      cancelable: true
    }))
    return Boolean(root)
  })()`)
  assert.equal(opened, true, 'Dashboard selector should be available')
  const dropdownReady = await evaluate<boolean>(`(async () => {
    const started = Date.now()
    while (Date.now() - started < 5000) {
      if (document.querySelector('.ant-select-item')) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  })()`)
  if (!dropdownReady) {
    const state = await evaluate<Record<string, unknown>>(`(() => ({
      url: location.href,
      ready: document.readyState,
      studio: Boolean(document.querySelector('.dashboard-studio')),
      selector: Boolean(document.querySelector('.dashboard-selector')),
      dropdown: Boolean(document.querySelector('.ant-select-dropdown')),
      menuItems: document.querySelectorAll('.ant-menu-item').length,
      bodyText: document.body?.innerText?.slice(0, 240) ?? ''
    }))()`)
    throw new Error(`Dashboard selector options did not load: ${JSON.stringify(state)}`)
  }
  const selected = await evaluate<boolean>(`(() => {
    const id = ${JSON.stringify(spec.id)}
    const title = ${JSON.stringify(spec.title)}
    const option = [...document.querySelectorAll('.ant-select-item')]
      .find((item) => item.getAttribute('data-value') === id || item.textContent?.includes(title))
    option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
    option?.click()
    return Boolean(option)
  })()`)
  assert.equal(selected, true, `Dashboard option should exist: ${spec.id}`)
  await waitForRenderer(evaluate, spec.components.length, spec.title)
  const layoutStable = await evaluate<boolean>(`(async () => {
    const started = Date.now()
    let previous = ''
    let lastChange = Date.now()
    while (Date.now() - started < 10000) {
      const signature = [...document.querySelectorAll('.dashboard-widget')]
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return [rect.left, rect.top, rect.width, rect.height]
            .map((value) => Math.round(value))
            .join(',')
        })
        .join('|')
      if (signature !== previous) lastChange = Date.now()
      if (signature && Date.now() - lastChange >= 1_500) return true
      previous = signature
      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }
    return false
  })()`)
  assert.equal(layoutStable, true, `Dashboard layout should stabilize: ${spec.id}`)
  await sleep(2_500)
  await evaluate(`(() => {
    const header = document.querySelector('.dashboard-preview-header')
    header?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }))
  })()`)
  await sleep(120)
}

const captureDashboard = async (
  cdp: Awaited<ReturnType<typeof connectCdp>>,
  spec: DashboardSpec
): Promise<Buffer> => {
  await cdp.evaluate(`(() => {
    document.querySelector('.dashboard-studio')?.classList.add('dashboard-capture-mode')
  })()`)
  try {
    const layoutStable = await cdp.evaluate<boolean>(`(async () => {
      const started = Date.now()
      let previous = ''
      let lastChange = Date.now()
      while (Date.now() - started < 10000) {
        const signature = [...document.querySelectorAll('.dashboard-widget')]
          .map((element) => {
            const rect = element.getBoundingClientRect()
            return [rect.left, rect.top, rect.width, rect.height]
              .map((value) => Math.round(value))
              .join(',')
          })
          .join('|')
        if (signature !== previous) lastChange = Date.now()
        if (signature && Date.now() - lastChange >= 1_500) return true
        previous = signature
        await new Promise((resolve) => requestAnimationFrame(() => resolve()))
      }
      return false
    })()`)
    assert.equal(layoutStable, true, `Captured dashboard layout should stabilize: ${spec.id}`)
    await sleep(2_500)
    const rect = await cdp.evaluate<{ left: number; top: number; width: number; height: number }>(
      `(() => document.querySelector('.dashboard-preview')?.getBoundingClientRect().toJSON() ?? null)()`
    )
    assert.ok(rect && rect.width > 100 && rect.height > 100, `dashboard preview should be measurable: ${spec.id}`)
    const screenshot = await cdp.call('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: Math.max(0, Math.floor(rect.left)),
        y: Math.max(0, Math.floor(rect.top)),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
        scale: 1
      }
    })
    assert.ok(screenshot.result?.data, `Electron should return a PNG for ${spec.id}`)
    return Buffer.from(screenshot.result.data, 'base64')
  } finally {
    await cdp.evaluate(`(() => {
      document.querySelector('.dashboard-studio')?.classList.remove('dashboard-capture-mode')
    })()`)
  }
}

const setVisualViewport = async (
  cdp: Awaited<ReturnType<typeof connectCdp>>,
  viewport: Viewport
): Promise<void> => {
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  })
  const captureWidth = `${viewport.width}px`
  const captureHeight = `${viewport.height}px`
  const css = [
    '.dashboard-preview-meta time { visibility: hidden !important; }',
    '.dashboard-studio-body { height: 690px !important; min-height: 690px !important; max-height: 690px !important; }',
    '.dashboard-capture-mode .dashboard-preview-shell { left: 0 !important; z-index: 9999 !important; }',
    `.dashboard-capture-mode .dashboard-preview-shell { width: ${captureWidth} !important; height: ${captureHeight} !important; }`,
    `.dashboard-capture-mode .dashboard-preview { width: ${captureWidth} !important; height: ${captureHeight} !important; min-width: ${captureWidth} !important; min-height: ${captureHeight} !important; }`
  ].join('\n')
  const updated = await cdp.evaluate<boolean>(`(() => {
    const style = document.querySelector('style[data-visual-fixture]')
    if (!style) return false
    style.textContent = ${JSON.stringify(css)}
    return true
  })()`)
  assert.equal(updated, true, 'Visual fixture style should be available')
  await sleep(400)
}

const hasVisualContent = async (png: Buffer): Promise<boolean> => {
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height).data
  const base = [pixels[0], pixels[1], pixels[2]]
  let varied = 0
  for (let index = 0; index < pixels.length; index += 4) {
    const difference = Math.abs(pixels[index] - base[0]) +
      Math.abs(pixels[index + 1] - base[1]) +
      Math.abs(pixels[index + 2] - base[2])
    if (difference > 18) varied += 1
  }
  return varied / Math.max(1, image.width * image.height) > 0.01
}

const stopElectron = async (process: ChildProcessWithoutNullStreams): Promise<void> => {
  if (process.exitCode !== null) return
  process.kill()
  await Promise.race([
    new Promise<void>((resolvePromise) => process.once('exit', () => resolvePromise())),
    sleep(5_000)
  ])
}

const run = async (): Promise<void> => {
  mkdirSync(baselineDirectory, { recursive: true })
  const specs = createFixtureSpecs()
  const electron = spawn(
    electronPath,
    ['.', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDirectory}`],
    {
      cwd: repoRoot,
      env: (() => {
        const environment = { ...process.env }
        if (rendererUrl) environment.ELECTRON_RENDERER_URL = rendererUrl
        else delete environment.ELECTRON_RENDERER_URL
        return environment
      })(),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let electronLogs = ''
  electron.stdout.on('data', (chunk) => { electronLogs += chunk.toString() })
  electron.stderr.on('data', (chunk) => { electronLogs += chunk.toString() })
  let cdp: Awaited<ReturnType<typeof connectCdp>> | null = null
  const results: Array<Record<string, unknown>> = []
  try {
    const targets = await waitForCdp(electron, cdpPort)
    const target = targets.find((item) =>
      item.type === 'page' &&
      item.webSocketDebuggerUrl &&
      item.url &&
      item.url !== 'about:blank'
    )
    assert.ok(target?.webSocketDebuggerUrl, 'Electron page target should expose a WebSocket URL')
    cdp = await connectCdp(target.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')
    await cdp.call('Page.enable')
    let preloadReady = false
    const preloadStarted = Date.now()
    while (!preloadReady && Date.now() - preloadStarted < 30_000) {
      try {
        preloadReady = await cdp.evaluate<boolean>('Boolean(window.visslm)', 1_000)
      } catch {
        // The initial about:blank target has no execution context yet.
      }
      if (!preloadReady) await sleep(100)
    }
    assert.equal(preloadReady, true, 'Electron preload API should be ready')
    await cdp.evaluate(`(async () => {
      const specs = ${JSON.stringify(specs)}
      for (const spec of specs) {
        await window.visslm.saveDashboard({ spec, changeSummary: 'deterministic visual fixture' })
      }
      return true
    })()`)
    const menuReady = await cdp.evaluate<boolean>(`(async () => {
      const started = Date.now()
      while (Date.now() - started < 20000) {
        if ([...document.querySelectorAll('.ant-menu-item')]
          .some((element) => element.querySelector('.anticon-fund-projection-screen'))) return true
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return false
    })()`)
    assert.equal(menuReady, true, 'Visualization menu item should render')
    await cdp.evaluate(`(() => {
      const item = [...document.querySelectorAll('.ant-menu-item')]
        .find((element) => element.querySelector('.anticon-fund-projection-screen'))
      item?.click()
    })()`)
    await waitForRenderer(cdp.evaluate)
    await cdp.evaluate(`(() => {
      const style = document.createElement('style')
      style.dataset.visualFixture = 'true'
      style.textContent = ''
      document.head.append(style)
    })()`)
    for (const viewport of viewports) {
      await setVisualViewport(cdp, viewport)
      for (const spec of specs) {
        await selectDashboard(cdp.evaluate, spec)
        const actual = await captureDashboard(cdp, spec)
        const actualPath = join(artifactDirectory, `${spec.id}-${viewport.width}x${viewport.height}.png`)
        writeFileSync(actualPath, actual)
        assert.equal(await hasVisualContent(actual), true, `captured dashboard should not be blank: ${spec.id} @ ${viewport.width}x${viewport.height}`)
        const baselinePath = join(
          baselineDirectory,
          `${spec.id}-${viewport.width}x${viewport.height}.png`
        )
        if (updateBaselines) writeFileSync(baselinePath, actual)
        if (!existsSync(baselinePath)) {
          throw new Error(`Missing visual baseline: ${baselinePath}. Set VISSLM_UPDATE_VISUAL_BASELINES=1 to create it.`)
        }
        const diff = await comparePngBuffers(readFileSync(baselinePath), actual, {
          channelThreshold: 8,
          // Native canvas text and ECharts anti-aliasing can vary by a few pixels
          // between Electron launches; larger layout/content changes still fail.
          maxChangedRatio: 0.01
        })
        results.push({
          scenario: spec.id,
          viewport,
          baselinePath,
          actualPath,
          ...diff,
          status: diff.passed ? 'passed' : 'failed'
        })
      }
    }
  } finally {
    cdp?.close()
    await stopElectron(electron)
    rmSync(userDataDirectory, { recursive: true, force: true })
  }
  const failed = results.filter((result) => result.status !== 'passed')
  console.log(JSON.stringify({
    ok: failed.length === 0,
    mode: updateBaselines ? 'update-and-check' : 'check',
    rendererUrl: rendererUrl || 'built renderer (out/renderer)',
    viewports,
    baselineDirectory,
    artifactDirectory,
    results,
    ...(failed.length ? { electronLogs: electronLogs.slice(-4000) } : {})
  }, null, 2))
  assert.equal(failed.length, 0, `Electron visual regression failed for ${failed.map((item) => item.scenario).join(', ')}`)
}

await run()
