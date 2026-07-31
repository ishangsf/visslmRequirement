import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9223'
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
  const message = JSON.parse(raw.toString('utf8'))
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})

const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
  }
  return response.result?.result?.value
}

await call('Page.enable')
await call('Emulation.setDeviceMetricsOverride', {
  width: 1366,
  height: 768,
  deviceScaleFactor: 1,
  mobile: false
})

try {
  const checks = await evaluate(`(async () => {
    document.querySelector('.ant-modal-close')?.click()
    document.querySelector('.ant-drawer-close')?.click()
    ;[...document.querySelectorAll('.ant-menu-item')]
      .find((element) => element.textContent?.trim() === '可视化大屏')
      ?.click()
    const pageStarted = Date.now()
    while (!document.querySelector('.dashboard-studio') && Date.now() - pageStarted < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await new Promise((resolve) => setTimeout(resolve, 900))
    const exportButton = [...document.querySelectorAll('.dashboard-studio-actions button')]
      .find((element) => element.textContent?.trim() === '导出')
    exportButton?.click()
    const menuStarted = Date.now()
    while (![...document.querySelectorAll('.ant-dropdown-menu-item')]
      .some((element) => element.textContent?.includes('PNG 图片')) && Date.now() - menuStarted < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const pngOption = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((element) => element.textContent?.includes('PNG 图片'))
    pngOption?.click()
    const modalStarted = Date.now()
    while (!document.querySelector('.dashboard-export-review') && Date.now() - modalStarted < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, 450))
    const review = document.querySelector('.dashboard-export-review')
    const modal = review?.closest('.ant-modal')
    const alertText = review?.querySelector('.ant-alert')?.textContent?.trim() ?? ''
    const details = [...(review?.querySelectorAll('.ant-descriptions-row') ?? [])]
      .map((element) => element.textContent?.replace(/\s+/g, ' ').trim())
    const overflowElements = [...(review?.querySelectorAll('.ant-alert, .ant-descriptions') ?? [])]
      .filter((element) => element.scrollWidth > element.clientWidth + 1).length
    const dropdown = document.querySelector('.ant-dropdown')
    const dropdownStyle = dropdown ? getComputedStyle(dropdown) : null
    return {
      dashboardVisible: Boolean(document.querySelector('.dashboard-studio')),
      draftSaved: Boolean(window.localStorage.getItem('visslm:dashboard-draft:local-overview')),
      draftTagVisible: [...document.querySelectorAll('.dashboard-studio-heading .ant-tag')]
        .some((element) => element.textContent?.trim() === '草稿'),
      exportButtonFound: Boolean(exportButton),
      pngOptionFound: Boolean(pngOption),
      reviewVisible: Boolean(modal && getComputedStyle(modal).display !== 'none' &&
        modal.getBoundingClientRect().width > 0 && modal.getBoundingClientRect().height > 0),
      title: modal?.querySelector('.ant-modal-title')?.textContent?.trim(),
      alertText,
      details,
      dropdownStillVisible: Boolean(dropdown && dropdownStyle &&
        dropdownStyle.display !== 'none' &&
        dropdownStyle.visibility !== 'hidden' &&
        Number(dropdownStyle.opacity) > 0 &&
        dropdown.getBoundingClientRect().width > 0 &&
        dropdown.getBoundingClientRect().height > 0),
      dropdownState: dropdown && dropdownStyle ? {
        display: dropdownStyle.display,
        visibility: dropdownStyle.visibility,
        opacity: dropdownStyle.opacity,
        width: dropdown.getBoundingClientRect().width,
        height: dropdown.getBoundingClientRect().height
      } : null,
      overflowElements,
      modalFitsViewport: modal
        ? modal.getBoundingClientRect().left >= 0 && modal.getBoundingClientRect().right <= window.innerWidth
        : false
    }
  })()`)
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const screenshotPath = join(process.env.TEMP, 'visslm-dashboard-export-review.png')
  writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
  console.log(JSON.stringify({ ...checks, screenshotPath }, null, 2))

  if (
    !checks.dashboardVisible ||
    !checks.draftSaved ||
    !checks.draftTagVisible ||
    !checks.exportButtonFound ||
    !checks.pngOptionFound ||
    !checks.reviewVisible ||
    checks.title !== '确认导出大屏' ||
    !checks.alertText ||
    !checks.details.some((detail) => detail.includes('数据范围')) ||
    !checks.details.some((detail) => detail.includes('PNG')) ||
    !checks.modalFitsViewport ||
    checks.dropdownStillVisible ||
    checks.overflowElements > 0
  ) process.exitCode = 1
} finally {
  await call('Emulation.clearDeviceMetricsOverride')
  socket.close()
}
