import WebSocket from 'ws'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9350'
const screenshotDirectory = join(process.cwd(), 'tmp', 'chat-source-list-e2e', 'screenshots')
mkdirSync(screenshotDirectory, { recursive: true })

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const target = targets.find((item) => item.type === 'page' && item.title === 'VISSLM Agent')
if (!target) throw new Error('VISSLM Agent CDP target not found')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let sequence = 0
const pending = new Map()
socket.on('message', (raw) => {
  const response = JSON.parse(raw.toString('utf8'))
  if (!response.id || !pending.has(response.id)) return
  pending.get(response.id)(response)
  pending.delete(response.id)
})

const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
  }
  return response.result?.result?.value
}

const capture = async (name) => {
  const response = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(screenshotDirectory, `${name}.png`)
  writeFileSync(path, Buffer.from(response.result.data, 'base64'))
  return path
}

await call('Emulation.setDeviceMetricsOverride', {
  width: 1360,
  height: 880,
  deviceScaleFactor: 1,
  mobile: false
})
await call('Page.bringToFront')
await call('Page.reload')

const collapsedChecks = await evaluate(`(async () => {
  const waitFor = async (predicate, label, timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for ' + label)
  }
  await waitFor(() => document.querySelector('.ant-menu-item'), 'application navigation')
  if (document.documentElement.dataset.theme !== 'dark') {
    document.querySelector('button[aria-label="切换到暗色主题"]')?.click()
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'dark theme')
  }
  [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('AI 助手'))?.click()
  const session = await waitFor(() => [...document.querySelectorAll('.chat-history-item')]
    .find((item) => item.textContent?.includes('回答依据分组验收')), 'seeded chat session')
  session.click()
  const details = await waitFor(() => document.querySelector('details.source-list'), 'answer source list')
  const markdown = document.querySelector('.message-row.assistant .chat-markdown')
  const summary = details.querySelector('summary.source-list-title')
  const count = details.querySelector('.source-list-count')
  const chips = details.querySelector('.source-chips')
  const openLabel = details.querySelector('.source-list-action-open')
  const sourceNames = ['设备接口规范.pdf', '接口测试记录.pdf', '接口验证任务']
  summary?.focus()
  return {
    theme: document.documentElement.dataset.theme,
    answerVisible: markdown?.textContent?.includes('设备接口协议用于描述系统边界') ?? false,
    repeatedSourceAbsent: !(markdown?.textContent ?? '').includes('来源：'),
    repeatedBasisAbsent: !(markdown?.textContent ?? '').includes('依据：'),
    repeatedSourceNamesAbsent: sourceNames.every((name) => !(markdown?.textContent ?? '').includes(name)),
    collapsedByDefault: !details.open,
    chipsHiddenWhenCollapsed: chips?.getClientRects().length === 0,
    summaryVisible: Boolean(summary?.textContent?.includes('回答依据')),
    uniqueDocumentCountVisible: Boolean(count?.textContent?.includes('2 份文档')),
    recordCountVisible: Boolean(count?.textContent?.includes('1 条记录')),
    countLabelVisible: Boolean(count?.getAttribute('aria-label')?.includes('2 份知识文档')),
    summaryFocusable: document.activeElement === summary,
    viewListVisible: openLabel ? getComputedStyle(openLabel).display !== 'none' : false,
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 &&
      document.body.scrollWidth <= window.innerWidth + 1
  }
})()`)

const collapsedScreenshot = await capture('chat-answer-basis-collapsed-dark')

const expandedChecks = await evaluate(`(async () => {
  const details = document.querySelector('details.source-list')
  details?.querySelector('summary')?.click()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const chips = details?.querySelector('.source-chips')
  const closeLabel = details?.querySelector('.source-list-action-close')
  const groups = details ? [...details.querySelectorAll('.source-group')] : []
  const references = details ? [...details.querySelectorAll('.source-reference')] : []
  const groupReferenceCounts = groups
    .map((group) => group.querySelectorAll('.source-reference').length)
    .sort((left, right) => left - right)
  const primaryGroupCount = groups.filter((group) => {
    const text = (group.textContent ?? '').replace(/\s+/gu, '')
    return text.includes('第19页') && text.includes('第20页')
  }).length
  const referenceLabels = references.map((reference) => reference.getAttribute('aria-label')?.trim() ?? '')
  const groupText = groups.map((group) => group.textContent ?? '').join(' ')
  const referenceText = references.map((reference) => reference.textContent ?? '').join(' ').replace(/\s+/gu, '')
  const focusableReferences = references.every((reference) =>
    reference.tagName === 'BUTTON' && !reference.disabled && reference.tabIndex >= 0
  )
  references[0]?.focus()
  return {
    expanded: Boolean(details?.open),
    chipsVisible: (chips?.getClientRects().length ?? 0) > 0,
    closeListVisible: closeLabel ? getComputedStyle(closeLabel).display !== 'none' : false,
    groupCount: groups.length === 3,
    referenceCount: references.length === 4,
    sameDocumentGrouped: primaryGroupCount === 1 && groupReferenceCounts.join(',') === '1,1,2',
    sourceNamesReadable: groupText.includes('设备接口规范.pdf') &&
      groupText.includes('接口测试记录.pdf') && groupText.includes('接口验证任务'),
    locationsReadable: referenceText.includes('第19页') &&
      referenceText.includes('第20页') && referenceText.includes('第4页'),
    referenceLabelsPresent: referenceLabels.every((label) => label.length > 0),
    referenceLabelsUnique: new Set(referenceLabels).size === referenceLabels.length,
    focusableReferences,
    firstReferenceFocused: document.activeElement === references[0],
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 &&
      document.body.scrollWidth <= window.innerWidth + 1
  }
})()`)

const expandedScreenshot = await capture('chat-answer-basis-expanded-dark')
await call('Emulation.setDeviceMetricsOverride', {
  width: 660,
  height: 760,
  deviceScaleFactor: 1,
  mobile: false
})
const responsiveChecks = await evaluate(`(async () => {
  const details = document.querySelector('details.source-list')
  if (details?.open) details.querySelector('summary')?.click()
  document.querySelector('button[aria-label="切换到亮色主题"]')?.click()
  const started = Date.now()
  while (document.documentElement.dataset.theme !== 'light' && Date.now() - started < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const summary = details?.querySelector('summary.source-list-title')
  if (!details?.open) summary?.click()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const chips = details?.querySelector('.source-chips')
  const groups = details ? [...details.querySelectorAll('.source-group')] : []
  const groupRects = groups.map((group) => group.getBoundingClientRect())
  const chipsStyle = chips ? getComputedStyle(chips) : null
  const count = details?.querySelector('.source-list-count')
  const countItems = count ? [...count.querySelectorAll('.source-kind-count')] : []
  const summaryRect = summary?.getBoundingClientRect()
  const sameColumn = groupRects.length <= 1 || groupRects.every((rect, index) => {
    const first = groupRects[0]
    const previous = groupRects[index - 1]
    return first && Math.abs(rect.left - first.left) <= 1 && (!previous || rect.top >= previous.bottom - 1)
  })
  const oneColumn = Boolean(chipsStyle && (
    (chipsStyle.display === 'grid' && chipsStyle.gridTemplateColumns.trim().split(/\s+/u).length === 1) ||
    (chipsStyle.display === 'flex' && chipsStyle.flexDirection === 'column') ||
    sameColumn
  ))
  const groupsWithinViewport = groupRects.every((rect) => rect.left >= -1 && rect.right <= window.innerWidth + 1)
  const countItemsNoWrap = countItems.length > 0 && countItems.every((item) => getComputedStyle(item).whiteSpace === 'nowrap')
  if (details?.open) summary?.click()
  return {
    theme: document.documentElement.dataset.theme,
    collapsed: !details?.open,
    summaryWithinViewport: Boolean(summaryRect && summaryRect.left >= 0 && summaryRect.right <= window.innerWidth + 1),
    oneColumn,
    groupsWithinViewport,
    countItemsNoWrap,
    viewListVisible: details?.querySelector('.source-list-action-open')
      ? getComputedStyle(details.querySelector('.source-list-action-open')).display !== 'none'
      : false,
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 &&
      document.body.scrollWidth <= window.innerWidth + 1
  }
})()`)
const responsiveScreenshot = await capture('chat-answer-basis-collapsed-light-660')
const failures = []
for (const [key, value] of Object.entries(collapsedChecks)) {
  if (key !== 'theme' && value !== true) failures.push(`collapsed check failed: ${key}=${String(value)}`)
}
for (const [key, value] of Object.entries(expandedChecks)) {
  if (value !== true) failures.push(`expanded check failed: ${key}=${String(value)}`)
}
for (const [key, value] of Object.entries(responsiveChecks)) {
  if (key !== 'theme' && value !== true) failures.push(`responsive check failed: ${key}=${String(value)}`)
}
if (collapsedChecks.theme !== 'dark') failures.push(`expected dark theme, got ${collapsedChecks.theme}`)
if (responsiveChecks.theme !== 'light') failures.push(`expected light theme, got ${responsiveChecks.theme}`)

socket.close()
if (failures.length) {
  throw new Error(`Chat source-list UI smoke failed: ${JSON.stringify({ failures, collapsedChecks, expandedChecks })}`)
}
console.log(JSON.stringify({
  ok: true,
  collapsedChecks,
  expandedChecks,
  responsiveChecks,
  screenshots: [collapsedScreenshot, expandedScreenshot, responsiveScreenshot]
}, null, 2))
