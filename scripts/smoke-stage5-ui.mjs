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

const call = (method, params = {}) =>
  new Promise((resolve) => {
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
    throw new Error(
      response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed'
    )
  }
  return response.result?.result?.value
}

const capture = async (name) => {
  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(process.env.TEMP, name)
  writeFileSync(path, Buffer.from(shot.result.data, 'base64'))
  return path
}

const openPage = async (label, selector) =>
  evaluate(`(async () => {
    [...document.querySelectorAll('.ant-menu-item')]
      .find((element) => element.textContent?.trim() === ${JSON.stringify(label)})
      ?.click();
    const started = Date.now();
    while (!document.querySelector(${JSON.stringify(selector)}) && Date.now() - started < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!document.querySelector(${JSON.stringify(selector)})) {
      throw new Error(${JSON.stringify(`${label} 页面未出现`)});
    }
  })()`)

await call('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false
})
await call('Page.enable')

try {
  await evaluate(`(async () => {
    document.querySelector('.ant-modal-close')?.click();
    document.querySelector('.ant-drawer-close')?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
  })()`)
  await openPage('可视化大屏', '.dashboard-studio')
  const qualityChecks = await evaluate(`(async () => {
    const qualityButton = [...document.querySelectorAll('.dashboard-studio-actions button')]
      .find((element) => element.textContent?.trim() === '检查');
    qualityButton?.click();
    const started = Date.now();
    while (!document.querySelector('.dashboard-quality') && Date.now() - started < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const drawer = document.querySelector(
      '.dashboard-quality'
    )?.closest('.ant-drawer-content-wrapper');
    const score = document.querySelector('.dashboard-quality-score strong')?.textContent?.trim();
    const queryRows = document.querySelectorAll('.dashboard-quality-queries > div').length;
    const sections = [...document.querySelectorAll('.dashboard-quality .ant-divider')]
      .map((element) => element.textContent?.trim());
    const overflowElements = [...document.querySelectorAll(
      '.dashboard-quality-score, .dashboard-quality .ant-list-item-meta, ' +
      '.dashboard-quality-queries > div'
    )].filter((element) => element.scrollWidth > element.clientWidth + 1).length;
    return {
      buttonFound: Boolean(qualityButton),
      drawerVisible: Boolean(drawer),
      score,
      queryRows,
      sections,
      drawerFitsViewport: drawer
        ? drawer.getBoundingClientRect().left >= 0 &&
          drawer.getBoundingClientRect().right <= window.innerWidth
        : false,
      overflowElements
    };
  })()`)
  const qualityScreenshot = await capture('visslm-stage5-quality.png')

  await evaluate(`(async () => {
    document.querySelector('.ant-drawer-close')?.click();
    const started = Date.now();
    while (document.querySelector('.ant-drawer-open') && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })()`)

  await openPage('AI 助手', '.chat-card')
  const dataChecks = await evaluate(`(async () => {
    let button = [...document.querySelectorAll('.chat-data-action button')]
      .find((element) => element.textContent?.includes('查看查询数据'));
    if (!button) {
      const input = document.querySelector('.composer textarea');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(input, '帮我统计 Source 前3名的单位');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.querySelector('.chat-send-button')?.click();
      const responseStarted = Date.now();
      while (
        ![...document.querySelectorAll('.chat-data-action button')]
          .some((element) => element.textContent?.includes('查看查询数据')) &&
        Date.now() - responseStarted < 180000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      button = [...document.querySelectorAll('.chat-data-action button')]
        .find((element) => element.textContent?.includes('查看查询数据'));
    }
    button?.click();
    const started = Date.now();
    while (!document.querySelector('.chat-data-modal') && Date.now() - started < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const modal = document.querySelector('.chat-data-modal');
    const table = document.querySelector('.chat-data-modal .ant-table-container');
    const rowCount = document.querySelectorAll('.chat-data-modal .ant-table-tbody tr').length;
    const summary = document.querySelector('.chat-data-summary')?.textContent?.trim();
    const nameButton = document.querySelector('.chat-data-name-button');
    nameButton?.click();
    const detailStarted = Date.now();
    while (!document.querySelector('.chat-record-detail') && Date.now() - detailStarted < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const detail = document.querySelector('.chat-record-detail');
    return {
      buttonFound: Boolean(button),
      modalVisible: Boolean(modal),
      rowCount,
      summary,
      tableFits: table ? table.scrollWidth <= table.clientWidth + 1 : false,
      modalFitsViewport: modal
        ? modal.getBoundingClientRect().left >= 0 &&
          modal.getBoundingClientRect().right <= window.innerWidth
        : false,
      detailVisible: Boolean(detail),
      detailFits: detail ? detail.scrollWidth <= detail.clientWidth + 1 : false
    };
  })()`)
  const dataScreenshot = await capture('visslm-stage5-chat-data.png')

  console.log(JSON.stringify({
    viewport: { width: 1280, height: 800 },
    qualityChecks,
    dataChecks,
    qualityScreenshot,
    dataScreenshot
  }, null, 2))

  if (
    !qualityChecks.buttonFound ||
    !qualityChecks.drawerVisible ||
    !qualityChecks.score ||
    !qualityChecks.sections.includes('查询性能') ||
    !qualityChecks.sections.includes('最近生成运行') ||
    !qualityChecks.drawerFitsViewport ||
    qualityChecks.overflowElements > 0 ||
    !dataChecks.buttonFound ||
    !dataChecks.modalVisible ||
    dataChecks.rowCount < 1 ||
    !dataChecks.tableFits ||
    !dataChecks.modalFitsViewport ||
    !dataChecks.detailVisible ||
    !dataChecks.detailFits
  ) {
    process.exitCode = 1
  }
} finally {
  await call('Emulation.clearDeviceMetricsOverride')
  socket.close()
}
