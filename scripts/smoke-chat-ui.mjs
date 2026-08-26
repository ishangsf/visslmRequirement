import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
  }
  return response.result?.result?.value
}

await call('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 500))

const checks = await evaluate(`(async () => {
  [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === 'AI 助手')
    ?.click();
  const started = Date.now();
  while (!document.querySelector('.chat-page') && Date.now() - started < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const chatPage = document.querySelector('.chat-page');
  const card = document.querySelector('.chat-card');
  const composer = document.querySelector('.composer');
  return {
    heading: Boolean(document.querySelector('.chat-heading')),
    knowledgeStatus: document.body.textContent?.includes('知识库已就绪'),
    promptCards: document.querySelectorAll('.prompt-card').length,
    projectFilterRemoved: !document.querySelector('.chat-project-filter'),
    scopeHintRemoved: !document.querySelector('.chat-scope-hint'),
    composer: Boolean(document.querySelector('.composer-input')),
    sendButton: Boolean(document.querySelector('.chat-send-button')),
    newConversationButton:
      document.querySelector('.new-conversation-button')?.textContent?.trim() === '新建会话',
    historyPanel: Boolean(document.querySelector('.chat-history-panel')),
    pageFitsViewport:
      Boolean(chatPage && chatPage.getBoundingClientRect().bottom <= window.innerHeight),
    composerVisible:
      Boolean(composer && composer.getBoundingClientRect().bottom <= window.innerHeight),
    cardHeight: card ? Math.round(card.getBoundingClientRect().height) : 0
  };
})()`)

await call('Page.enable')
const themeSetup = await evaluate(`(async () => {
  const originalTheme = document.documentElement.dataset.theme || 'dark';
  if (originalTheme !== 'dark') {
    document.querySelector('.window-theme-toggle')?.click();
    await new Promise((resolve) => setTimeout(resolve, 240));
  }
  return {
    originalTheme,
    darkApplied: document.documentElement.dataset.theme === 'dark'
  };
})()`)
const darkThemeChecks = await evaluate(`(() => {
  const surfaces = [
    document.querySelector('.chat-history-panel'),
    document.querySelector('.chat-card'),
    document.querySelector('.composer-input')
  ].filter(Boolean);
  const surfaceColors = surfaces.map((element) => getComputedStyle(element).backgroundColor);
  const textColor = getComputedStyle(
    document.querySelector('.chat-session-title') || document.body
  ).color;
  return {
    darkThemeApplied: document.documentElement.dataset.theme === 'dark',
    darkThemeSurfaces: surfaces.length === 3 && surfaceColors.every(
      (color) => color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)'
    ),
    darkThemeSurfaceColors: surfaceColors,
    darkThemeTextColor: textColor
  };
})()`)
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshot = join(process.env.TEMP, 'visslm-chat-redesign.png')
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
await evaluate(`(async () => {
  if (document.documentElement.dataset.theme !== 'light') {
    document.querySelector('.window-theme-toggle')?.click();
    await new Promise((resolve) => setTimeout(resolve, 240));
  }
})()`)
const lightThemeChecks = await evaluate(`(() => {
  const surfaces = [
    document.querySelector('.chat-history-panel'),
    document.querySelector('.chat-card'),
    document.querySelector('.composer-input')
  ].filter(Boolean);
  const surfaceColors = surfaces.map((element) => getComputedStyle(element).backgroundColor);
  const textColor = getComputedStyle(
    document.querySelector('.chat-session-title') || document.body
  ).color;
  return {
    lightThemeApplied: document.documentElement.dataset.theme === 'light',
    lightThemeSurfaces: surfaces.length === 3 && surfaceColors.every(
      (color) => color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)'
    ),
    lightThemeSurfaceColors: surfaceColors,
    lightThemeTextColor: textColor
  };
})()`)
const lightShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const lightScreenshot = join(process.env.TEMP, 'visslm-chat-light.png')
writeFileSync(lightScreenshot, Buffer.from(lightShot.result.data, 'base64'))
if (themeSetup.originalTheme !== 'light') {
  await evaluate(`(async () => {
    document.querySelector('.window-theme-toggle')?.click();
    await new Promise((resolve) => setTimeout(resolve, 240));
  })()`)
}
const historyChecks = await evaluate(`(async () => {
  const panel = document.querySelector('.chat-history-panel');
  const historyItem = panel?.querySelector('.chat-history-item');
  const historyDeleteButton = panel?.querySelector('.chat-history-delete');
  const listOrEmpty = Boolean(
    panel?.querySelector('.chat-history-item, .chat-history-empty')
  );
  const historyItemCount = panel?.querySelectorAll('.chat-history-item').length ?? 0;
  historyItem?.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    historyPanelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
    historyListOrEmpty: listOrEmpty,
    historyItemCount,
    historyDeleteButton: Boolean(historyDeleteButton),
    historyLoadedMessages: Boolean(document.querySelector('.message-row'))
  };
})()`)
const historyUiChecks = await evaluate(`(async () => {
  const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration))
  const isVisible = (element) => {
    if (!element) return false
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
      rect.width > 0 && rect.height > 0
  }
  const panel = document.querySelector('.chat-history-panel')
  const getSearchInput = () => panel?.querySelector(
    'input.chat-history-search, .chat-history-search input, input[aria-label*="搜索历史"], input[placeholder*="搜索历史"], input[placeholder*="搜索"]'
  )
  const getHistoryItems = () => [...(panel?.querySelectorAll('.chat-history-item') ?? [])]
    .filter(isVisible)
  const setSearch = async (value) => {
    const input = getSearchInput()
    if (!input) return false
    const prototype = input instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(120)
    return true
  }
  const searchInput = getSearchInput()
  const searchControl = Boolean(searchInput && isVisible(searchInput))

  // Wait briefly for the history request to settle, but do not require any
  // particular persisted session. Empty and one-item histories are valid.
  const historyStarted = Date.now()
  while (panel && !panel.querySelector('.chat-history-item, .chat-history-empty') &&
      Date.now() - historyStarted < 4000) {
    await sleep(100)
  }
  const historyItems = [...(panel?.querySelectorAll('.chat-history-item') ?? [])]
  const historyItemCount = historyItems.length
  const historyBody = panel?.querySelector('.chat-history-panel-body')
  const historyList = panel?.querySelector('.chat-history-list')
  const historyBodyStyle = historyBody ? getComputedStyle(historyBody) : null
  const historyListStyle = historyList ? getComputedStyle(historyList) : null
  const historyHintRemoved = !panel?.querySelector('.chat-history-hint')
  const historyRowsCompact = historyItems.length === 0 || historyItems.every(
    (item) => item.getBoundingClientRect().height <= 64
  )
  const inactiveHistoryItems = historyItems.filter((item) => !item.classList.contains('active'))
  const isTransparent = (color) => !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)'
  const historyRowsFlattened = inactiveHistoryItems.length === 0 || inactiveHistoryItems.every((item) => {
    const style = getComputedStyle(item)
    return isTransparent(style.backgroundColor) && isTransparent(style.borderTopColor)
  })
  const historyListOwnsScroll = !historyList || Boolean(
    historyBodyStyle?.overflowY === 'hidden' &&
    ['auto', 'scroll'].includes(historyListStyle?.overflowY ?? '')
  )
  const itemDetails = historyItems.map((item) => ({
    title: item.querySelector('.chat-history-item-main strong')?.textContent?.trim() ?? '',
    preview: item.querySelector('.chat-history-item-main small')?.textContent?.trim() ?? ''
  }))
  const usableToken = (value) => {
    const normalized = value?.trim()
    if (!normalized || normalized === '暂无消息预览') return ''
    return normalized.slice(0, 40)
  }
  const titleToken = usableToken(itemDetails.find((item) => item.title)?.title)
  const previewEntry = itemDetails.find((item) => {
    const token = usableToken(item.preview)
    return token && !item.title.toLocaleLowerCase().includes(token.toLocaleLowerCase())
  })
  const previewToken = usableToken(previewEntry?.preview)
  const titleSearchSkipped = !titleToken
  const previewSearchSkipped = !previewToken
  const visibleTextIncludes = (token) => {
    const normalizedToken = token.toLocaleLowerCase()
    const items = getHistoryItems()
    return items.length > 0 && items.every((item) =>
      (item.textContent ?? '').toLocaleLowerCase().includes(normalizedToken)
    )
  }
  const visibleNoMatch = () => getHistoryItems().length === 0
  let titleFilter = true
  let previewFilter = true
  let noMatchFilter = true
  if (searchControl && !titleSearchSkipped) {
    await setSearch(titleToken)
    titleFilter = visibleTextIncludes(titleToken)
    await setSearch('__visslm_smoke_no_history_match__')
    noMatchFilter = visibleNoMatch()
  } else if (searchControl && historyItemCount > 0) {
    await setSearch('__visslm_smoke_no_history_match__')
    noMatchFilter = visibleNoMatch()
  }
  if (searchControl && !previewSearchSkipped) {
    await setSearch(previewToken)
    previewFilter = visibleTextIncludes(previewToken)
  }
  await setSearch('')

  const getHistoryToggle = () => document.querySelector(
    '.chat-history-toggle:not(.chat-history-reopen), .chat-history-mobile-toggle, ' +
    '[data-chat-history-toggle], button[aria-label*="收起历史会话"], ' +
    'button[aria-label*="关闭历史会话"], button[aria-label*="历史侧栏"]'
  )
  const getHistoryReopen = () => document.querySelector(
    '.chat-history-reopen, button[aria-label*="展开历史会话"]'
  )
  const readPanelState = () => {
    const toggle = getHistoryToggle()
    const style = panel ? getComputedStyle(panel) : null
    return {
      ariaExpanded: toggle?.getAttribute('aria-expanded') ?? '',
      ariaLabel: toggle?.getAttribute('aria-label') ?? '',
      collapsed: Boolean(panel?.matches('.collapsed, .is-collapsed, [data-collapsed="true"]')),
      display: style?.display ?? '',
      width: panel ? Math.round(panel.getBoundingClientRect().width) : 0
    }
  }
  const historyToggle = getHistoryToggle()
  const beforePanelState = readPanelState()
  historyToggle?.click()
  await sleep(320)
  const collapsedPanelState = readPanelState()
  const collapseObserved = Boolean(
    historyToggle && (
      collapsedPanelState.ariaExpanded === 'false' ||
      collapsedPanelState.collapsed ||
      collapsedPanelState.display === 'none' ||
      collapsedPanelState.width < beforePanelState.width - 8 ||
      collapsedPanelState.ariaLabel !== beforePanelState.ariaLabel
    )
  )
  getHistoryReopen()?.click()
  await sleep(320)
  const restoredPanelState = readPanelState()
  const restoreObserved = Boolean(
    historyToggle && getHistoryReopen() && (
      (beforePanelState.ariaExpanded &&
        restoredPanelState.ariaExpanded === beforePanelState.ariaExpanded) ||
      restoredPanelState.collapsed === beforePanelState.collapsed &&
        restoredPanelState.display === beforePanelState.display &&
        restoredPanelState.width === beforePanelState.width
    )
  )

  const titleNode = document.querySelector(
    '.chat-session-title, [data-chat-session-title], .chat-session-label strong'
  )
  const sessionTitle = titleNode?.textContent?.trim() ?? ''
  const messageList = document.querySelector('.message-list')
  const messageRole = messageList?.getAttribute('role') ?? ''
  const labelledBy = messageList?.getAttribute('aria-labelledby')
  const labelledByText = labelledBy
    ? labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
    : ''
  const messageAccessibleName = messageList?.getAttribute('aria-label')?.trim() || labelledByText
  const messageContainerAccessible = Boolean(
    messageList && ['log', 'region'].includes(messageRole) && messageAccessibleName
  )

  const composerToolbar = document.querySelector('.composer-footer, .composer-input')
  const buttonName = (button) => (
    button?.getAttribute('aria-label')?.trim() ||
    button?.getAttribute('title')?.trim() ||
    button?.textContent?.trim() || ''
  )
  const expertButton = composerToolbar?.querySelector(
    '.chat-expert-button, button[aria-label*="选择专家"], button[title*="选择专家"]'
  ) || [...(composerToolbar?.querySelectorAll('button') ?? [])]
    .find((button) => buttonName(button).includes('选择专家'))
  const sendButton = composerToolbar?.querySelector('.chat-send-button') ||
    document.querySelector('.chat-send-button')
  const expertButtonName = buttonName(expertButton)
  const sendButtonName = buttonName(sendButton)
  const expertButtonAccessible = Boolean(
    expertButton && expertButton.tagName === 'BUTTON' && expertButtonName.includes('专家')
  )
  const sendButtonAccessible = Boolean(
    sendButton && sendButton.tagName === 'BUTTON' && sendButtonName.includes('发送')
  )
  const input = document.querySelector('.composer textarea')
  const inputBeforeExpert = input?.value ?? ''
  expertButton?.click()
  await sleep(120)
  const expertMenuOpened = Boolean(document.querySelector('.expert-mention-menu[role="listbox"]'))
  const expertInputChanged = (input?.value ?? '') !== inputBeforeExpert
  input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(60)

  return {
    historySearchControl: searchControl,
    historySearchFiltering: Boolean(
      searchControl && (historyItemCount === 0 || (titleFilter && previewFilter && noMatchFilter))
    ),
    historySearchTitleFilter: titleFilter,
    historySearchPreviewFilter: previewFilter,
    historySearchNoMatchFilter: noMatchFilter,
    historySearchTitleSkipped: titleSearchSkipped,
    historySearchPreviewSkipped: previewSearchSkipped,
    historyItemCount,
    historyHintRemoved,
    historyRowsCompact,
    historyRowsFlattened,
    historyListOwnsScroll,
    historyToggle: Boolean(historyToggle),
    historyPanelCollapseObserved: collapseObserved,
    historyPanelRestoreObserved: restoreObserved,
    sessionTitle,
    sessionTitlePresent: Boolean(sessionTitle),
    messageRole,
    messageAccessibleName: messageAccessibleName ?? '',
    messageContainerAccessible,
    expertButtonAccessible,
    sendButtonAccessible,
    expertMenuOpened,
    expertInputChanged,
    expertSelectionOperation: Boolean(expertButtonAccessible && (expertMenuOpened || expertInputChanged))
  }
})()`)
const taskDetailChecks = await evaluate(`(async () => {
  const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration))
  const disclosureSelector = 'details, .ant-collapse'
  const triggerSelector = [
    'summary',
    '.ant-collapse-header',
    '.agent-task-summary-toggle',
    '.agent-details-toggle',
    'button[aria-expanded]',
    '[role="button"][aria-expanded]'
  ].join(', ')
  const getDisclosure = (root) => {
    if (!root) return null
    if (root.matches(disclosureSelector)) return root
    return root.querySelector(disclosureSelector)
  }
  const getTrigger = (root, disclosure) => {
    if (!root) return null
    if (root.matches('summary, button, [role="button"]')) return root
    return disclosure?.querySelector(triggerSelector) || root.querySelector(triggerSelector)
  }
  const readState = (root) => {
    const disclosure = getDisclosure(root)
    const trigger = getTrigger(root, disclosure)
    const disclosureOpen = disclosure?.tagName === 'DETAILS'
      ? disclosure.open
      : disclosure?.getAttribute('aria-expanded') === 'true'
    const triggerExpanded = trigger?.getAttribute('aria-expanded')
    const rootExpanded = root.getAttribute('aria-expanded')
    const open = disclosure
      ? disclosureOpen
      : triggerExpanded === 'true' || rootExpanded === 'true'
    return {
      disclosure,
      trigger,
      open,
      collapsed: Boolean(disclosure || trigger || rootExpanded) && !open
    }
  }
  const hasExplicitEntry = (trigger) => {
    if (!trigger) return false
    const accessibleName = trigger.getAttribute('aria-label')?.trim() || trigger.textContent?.trim() || ''
    return Boolean(accessibleName) && (
      trigger.tagName === 'SUMMARY' ||
      trigger.tagName === 'BUTTON' ||
      trigger.getAttribute('role') === 'button' ||
      trigger.classList.contains('ant-collapse-header')
    )
  }
  const taskSummaries = [...document.querySelectorAll('.chat-answer-task-summary')]
    .filter((element) => !element.closest('.message-bubble.thinking'))
  if (!taskSummaries.length) {
    return {
      completedTaskSummaryCount: 0,
      completedTaskSummarySkipped: true,
      completedTaskDetailsCollapsed: true,
      completedTaskDetailsEntry: true,
      completedTaskDetailsExpandable: true,
      completedTaskDetailsExpandObserved: false,
      completedTaskDetailsRestoreObserved: false
    }
  }

  let collapsed = true
  let entry = true
  let expandObserved = true
  let restoreObserved = true
  for (const summary of taskSummaries) {
    const initial = readState(summary)
    collapsed = collapsed && initial.collapsed
    entry = entry && hasExplicitEntry(initial.trigger)
    if (!initial.trigger || !initial.collapsed) {
      expandObserved = false
      restoreObserved = false
      continue
    }
    initial.trigger.click()
    await sleep(100)
    const expanded = readState(summary)
    expandObserved = expandObserved && expanded.open
    expanded.trigger?.click()
    await sleep(100)
    const restored = readState(summary)
    restoreObserved = restoreObserved && restored.collapsed
  }
  return {
    completedTaskSummaryCount: taskSummaries.length,
    completedTaskSummarySkipped: false,
    completedTaskDetailsCollapsed: collapsed,
    completedTaskDetailsEntry: entry,
    completedTaskDetailsExpandable: expandObserved && restoreObserved,
    completedTaskDetailsExpandObserved: expandObserved,
    completedTaskDetailsRestoreObserved: restoreObserved
  }
})()`)

const messagePresentationChecks = await evaluate(`(() => {
  const assistantRow = document.querySelector('.message-row.assistant:not(:has(.message-bubble.thinking))')
  const userRow = document.querySelector('.message-row.user')
  const assistantBubble = assistantRow?.querySelector('.message-bubble')
  const userBubble = userRow?.querySelector('.message-bubble')
  const assistantAvatar = assistantRow?.querySelector('.message-avatar')
  const userAvatar = userRow?.querySelector('.message-avatar')
  const assistantMeta = assistantRow?.querySelector('.message-meta')
  const userMeta = userRow?.querySelector('.message-meta')
  const assistantMarkdown = assistantRow?.querySelector('.chat-markdown')
  const assistantRect = assistantRow?.getBoundingClientRect()
  const userRect = userRow?.getBoundingClientRect()
  const assistantBubbleRect = assistantBubble?.getBoundingClientRect()
  const userBubbleRect = userBubble?.getBoundingClientRect()
  const assistantAvatarRect = assistantAvatar?.getBoundingClientRect()
  const userAvatarRect = userAvatar?.getBoundingClientRect()
  const assistantMetaRect = assistantMeta?.getBoundingClientRect()
  const userMetaRect = userMeta?.getBoundingClientRect()
  const rolesPresent = Boolean(assistantRow && userRow && assistantBubble && userBubble)
  const roleAlignmentSeparated = !rolesPresent || Boolean(
    assistantRect && userRect && assistantBubbleRect && userBubbleRect &&
    assistantAvatarRect && userAvatarRect && assistantMetaRect && userMetaRect &&
    assistantBubbleRect.left < userBubbleRect.left &&
    assistantAvatarRect.left < userAvatarRect.left &&
    assistantMetaRect.left < userMetaRect.left
  )
  const visibleInlineHeadingMarker = /(?:^|\\s)#{2,4}\\s+\\S/.test(
    assistantMarkdown?.textContent ?? ''
  )
  const structuredMarkdownPresent = Boolean(
    assistantMarkdown?.querySelector('h1, h2, h3, h4, ol, ul, blockquote, table, pre')
  )

  return {
    messageRolesPresent: rolesPresent,
    messageRoleAlignmentSkipped: !rolesPresent,
    messageRoleAlignmentSeparated: roleAlignmentSeparated,
    assistantRowLeft: assistantRect?.left ?? null,
    assistantRowRight: assistantRect?.right ?? null,
    userRowLeft: userRect?.left ?? null,
    userRowRight: userRect?.right ?? null,
    assistantBubbleLeft: assistantBubbleRect?.left ?? null,
    userBubbleLeft: userBubbleRect?.left ?? null,
    assistantAvatarLeft: assistantAvatarRect?.left ?? null,
    userAvatarLeft: userAvatarRect?.left ?? null,
    legacyMarkdownMarkerHidden: !visibleInlineHeadingMarker,
    structuredMarkdownPresent
  }
})()`)
await evaluate(`(() => {
  const list = document.querySelector('.message-list')
  if (list) list.scrollTop = 0
})()`)
await new Promise((resolve) => setTimeout(resolve, 100))
const messageShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const messageScreenshot = join(process.env.TEMP, 'visslm-chat-message-layout.png')
writeFileSync(messageScreenshot, Buffer.from(messageShot.result.data, 'base64'))

await call('Emulation.setDeviceMetricsOverride', {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false,
  screenWidth: 1920,
  screenHeight: 1080
})
let wideTrackChecks
let wideScreenshot
try {
  wideTrackChecks = await evaluate(`(() => {
    const heading = document.querySelector('.content-page-heading')
    const chat = document.querySelector('.chat-page')
    const headingRect = heading?.getBoundingClientRect()
    const chatRect = chat?.getBoundingClientRect()
    const tolerance = 1
    return {
      wideViewportWidth: window.innerWidth,
      wideHeadingWidth: headingRect?.width ?? null,
      wideChatWidth: chatRect?.width ?? null,
      chatTrackMatchesPageTrack: Boolean(
        headingRect && chatRect &&
        Math.abs(headingRect.left - chatRect.left) <= tolerance &&
        Math.abs(headingRect.right - chatRect.right) <= tolerance &&
        Math.abs(headingRect.width - chatRect.width) <= tolerance
      )
    }
  })()`)
  const wideShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  wideScreenshot = join(process.env.TEMP, 'visslm-chat-wide-layout.png')
  writeFileSync(wideScreenshot, Buffer.from(wideShot.result.data, 'base64'))
} finally {
  await call('Emulation.clearDeviceMetricsOverride')
  await new Promise((resolve) => setTimeout(resolve, 180))
}

await call('Emulation.setDeviceMetricsOverride', {
  width: 680,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
  screenWidth: 680,
  screenHeight: 800
})
let narrowHistoryChecks
try {
  narrowHistoryChecks = await evaluate(`(() => {
    const isVisible = (element) => {
      if (!element) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
        rect.width > 0 && rect.height > 0
    }
    const panel = document.querySelector('.chat-history-panel')
    const historyEntry = panel?.querySelector('.chat-history-item, .chat-history-empty')
    const mobileToggle = [...document.querySelectorAll(
      '.chat-history-mobile-toggle, .chat-history-toggle, [data-chat-history-toggle], ' +
      'button[aria-label*="历史会话"], button[aria-label*="历史侧栏"]'
    )].find(isVisible)
    const panelVisible = isVisible(panel)
    const entryVisible = isVisible(historyEntry)
    const toggleVisible = isVisible(mobileToggle)
    return {
      viewportWidth: window.innerWidth,
      historyPanelVisible: panelVisible,
      historyEntryVisible: entryVisible,
      historyMobileToggleVisible: toggleVisible,
      narrowHistoryEntry: Boolean((panelVisible && entryVisible) || toggleVisible)
    }
  })()`)
} finally {
  await call('Emulation.clearDeviceMetricsOverride')
  await new Promise((resolve) => setTimeout(resolve, 180))
}
const newConversationChecks = await evaluate(`(async () => {
  const input = document.querySelector('.composer textarea');
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  valueSetter?.call(input, '待清空的会话草稿');
  input?.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.querySelector('.new-conversation-button')?.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const confirmation = [...document.querySelectorAll('.ant-modal-confirm-btns button')]
    .find((element) => element.textContent?.trim() === '开始新会话');
  const confirmationVisible = Boolean(confirmation);
  confirmation?.click();
  await new Promise((resolve) => setTimeout(resolve, 700));
  return {
    newConversationConfirmation: confirmationVisible,
    draftCleared: input?.value === '',
    emptyStateRestored: Boolean(document.querySelector('.chat-empty')),
    confirmationClosed: (() => {
      const button = document.querySelector('.ant-modal-confirm-btns button');
      if (!button) return true;
      const style = getComputedStyle(button);
      return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    })()
  };
})()`)
const simplificationChecks = await evaluate(`(() => {
  const oldEmptyStateSelectors = [
    '.chat-welcome-status-grid',
    '.chat-task-prompt-heading',
    '.chat-welcome-footnote'
  ]
  const oldEmptyStateClassesRemoved = oldEmptyStateSelectors.every(
    (selector) => !document.querySelector(selector)
  )
  const emptyState = document.querySelector('.chat-empty')
  const promptContainer = emptyState?.querySelector('.chat-minimal-prompts, .prompt-grid')
  const promptCards = [...(promptContainer?.querySelectorAll('.chat-minimal-prompt, .prompt-card') ?? [])]
  const promptDescriptionSelectors = [
    '.prompt-card-copy',
    '.prompt-card-description',
    '.prompt-card-arrow',
    '[data-prompt-arrow]',
    'small'
  ]
  const promptDescriptionCount = promptCards.reduce(
    (count, card) => count + promptDescriptionSelectors.reduce(
      (nestedCount, selector) => nestedCount + card.querySelectorAll(selector).length,
      0
    ),
    0
  )
  const promptArrowCount = promptCards.reduce((count, card) => {
    const text = card.textContent ?? ''
    return count + card.querySelectorAll('.prompt-card-arrow, [data-prompt-arrow]').length +
      (/[→⟶]|->/.test(text) ? 1 : 0)
  }, 0)
  const promptCheckSkipped = !emptyState
  const promptCompact = promptCheckSkipped || (
    Boolean(promptContainer) && promptCards.length <= 4 &&
      promptDescriptionCount === 0 && promptArrowCount === 0
  )

  const healthStrip = document.querySelector('.chat-health-strip')
  const healthItems = [...(healthStrip?.querySelectorAll('.chat-health-item') ?? [])]
  const dataStatusItems = healthItems.filter((item) => {
    const text = item.textContent?.trim() ?? ''
    return /数据|记录|资产|知识库/.test(text) ||
      item.matches('[data-status="data"], [data-status="records"], .chat-data-status')
  })
  const topDataStatusBadgeNotDuplicated = !healthStrip || dataStatusItems.length === 0

  const composerModelState = document.querySelector('.composer-model-state')
  const composerModelNote = composerModelState?.querySelector('.composer-model-note')?.textContent?.trim() ?? ''
  const modelOnline = composerModelState?.classList.contains('online')
  const fullModelExplanation = /自动判断|当前模型|模型名称|模型地址|API\\s*Key|API密钥|服务地址|配置模型/.test(
    composerModelNote
  )
  const onlineModelExplanationSkipped = !composerModelState || !modelOnline
  const onlineModelExplanationCompact = onlineModelExplanationSkipped || !fullModelExplanation

  return {
    oldEmptyStateClassesRemoved,
    oldEmptyStateSelectorCount: oldEmptyStateSelectors.length,
    emptyStatePresent: Boolean(emptyState),
    promptContainerPresent: Boolean(promptContainer),
    promptCount: promptCards.length,
    promptCheckSkipped,
    promptCompact,
    promptDescriptionCount,
    promptArrowCount,
    topHealthBadgeCount: healthItems.length,
    topDataStatusBadgeCount: dataStatusItems.length,
    topDataStatusBadgeNotDuplicated,
    composerModelStatePresent: Boolean(composerModelState),
    composerModelOnline: Boolean(modelOnline),
    onlineModelExplanationSkipped,
    onlineModelExplanationCompact,
    composerModelNote
  }
})()`)
const focusChecks = await evaluate(`(() => {
  const input = document.querySelector('.composer textarea');
  input?.focus();
  const style = input ? getComputedStyle(input) : null;
  const focusOwner = input?.closest('.composer-input');
  const focusOwnerStyle = focusOwner ? getComputedStyle(focusOwner) : null;
  const borderWidths = style
    ? [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    : [];
  const inputFocusBorderRemoved = borderWidths.length === 4 && borderWidths.every(
    (width) => Number.parseFloat(width) === 0
  );
  return {
    inputFocused: document.activeElement === input,
    inputFocusShadowRemoved: style?.boxShadow === 'none',
    inputFocusOutlineRemoved: style?.outlineStyle === 'none',
    inputFocusBorderRemoved,
    composerOwnsFocusBoundary: Boolean(
      focusOwner?.matches(':focus-within') &&
      focusOwnerStyle?.borderTopStyle !== 'none' &&
      inputFocusBorderRemoved &&
      style?.boxShadow === 'none' &&
      style?.outlineStyle === 'none'
    )
  };
})()`)
const focusShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const focusScreenshot = join(process.env.TEMP, 'visslm-chat-focus.png')
writeFileSync(focusScreenshot, Buffer.from(focusShot.result.data, 'base64'))
const conversationChecks = await evaluate(`(async () => {
  document.querySelector('.prompt-card')?.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.querySelector('.chat-send-button')?.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    userAvatar: Boolean(document.querySelector('.message-row.user .message-avatar')),
    messageMeta: document.querySelectorAll('.message-meta').length > 0,
    thinkingState: Boolean(document.querySelector('.message-bubble.thinking')),
    composerVisible:
      document.querySelector('.composer')?.getBoundingClientRect().bottom <= window.innerHeight
  };
})()`)
const conversationShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const conversationScreenshot = join(process.env.TEMP, 'visslm-chat-conversation.png')
writeFileSync(conversationScreenshot, Buffer.from(conversationShot.result.data, 'base64'))
const runningTaskChecks = await evaluate(`(() => {
  const disclosureSelector = 'details, .ant-collapse'
  const triggerSelector = [
    'summary',
    '.ant-collapse-header',
    '.agent-task-summary-toggle',
    '.agent-details-toggle',
    'button[aria-expanded]',
    '[role="button"][aria-expanded]'
  ].join(', ')
  const isVisible = (element) => {
    if (!element) return false
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
      rect.width > 0 && rect.height > 0
  }
  const getDisclosure = (root) => {
    if (!root) return null
    return root.closest(disclosureSelector) || root.querySelector(disclosureSelector)
  }
  const getTrigger = (root, disclosure) => {
    if (!root) return null
    if (root.matches('summary, button, [role="button"]')) return root
    return disclosure?.querySelector(triggerSelector) || root.querySelector(triggerSelector)
  }
  const readState = (root) => {
    const disclosure = getDisclosure(root)
    const trigger = getTrigger(root, disclosure)
    const disclosureOpen = disclosure?.tagName === 'DETAILS'
      ? disclosure.open
      : disclosure?.getAttribute('aria-expanded') === 'true'
    const triggerExpanded = trigger?.getAttribute('aria-expanded')
    const rootExpanded = root.getAttribute('aria-expanded')
    const open = disclosure
      ? disclosureOpen
      : triggerExpanded === 'true' || rootExpanded === 'true'
    return {
      trigger,
      collapsed: Boolean(disclosure || trigger || rootExpanded) && !open
    }
  }
  const hasExplicitEntry = (trigger) => {
    if (!trigger) return false
    const accessibleName = trigger.getAttribute('aria-label')?.trim() || trigger.textContent?.trim() || ''
    return Boolean(accessibleName) && (
      trigger.tagName === 'SUMMARY' ||
      trigger.tagName === 'BUTTON' ||
      trigger.getAttribute('role') === 'button' ||
      trigger.classList.contains('ant-collapse-header')
    )
  }
  const flows = [...document.querySelectorAll('.agent-control-flow')]
  const largeFlows = flows.filter((flow) => {
    const stepCount = flow.querySelectorAll('.agent-control-step').length
    const height = flow.getBoundingClientRect().height
    return stepCount >= 4 || height >= 160
  })
  const currentStatus = [...document.querySelectorAll('.agent-run-current')]
    .find((element) => isVisible(element) && Boolean(element.textContent?.trim()))
  const streamingAnswerVisible = [...document.querySelectorAll('.streaming-answer-row')].some(isVisible)
  const runningPanelVisible = [...document.querySelectorAll('.message-bubble.thinking')].some(isVisible)
  const runningSummaryVisible = [...document.querySelectorAll('.agent-run-task-summary')].some(isVisible)
  const streamingReplacesProgress = !(streamingAnswerVisible && runningPanelVisible)
  const runningSummaryNotDuplicated = !runningSummaryVisible
  if (!largeFlows.length) {
    return {
      runningControlFlowPresent: flows.length > 0,
      runningControlFlowLarge: false,
      runningControlFlowSkipped: true,
      runningControlFlowCollapsed: true,
      runningControlFlowEntry: true,
      runningCurrentStatusVisible: true,
      runningCurrentStatusObserved: Boolean(currentStatus),
      streamingAnswerVisible,
      runningPanelVisible,
      streamingReplacesProgress,
      runningSummaryNotDuplicated
    }
  }

  let collapsed = true
  let entry = true
  largeFlows.forEach((flow) => {
    const state = readState(flow)
    collapsed = collapsed && state.collapsed
    entry = entry && hasExplicitEntry(state.trigger)
  })
  return {
    runningControlFlowPresent: true,
    runningControlFlowLarge: true,
    runningControlFlowSkipped: false,
    runningControlFlowCollapsed: collapsed,
    runningControlFlowEntry: entry,
    runningCurrentStatusVisible: Boolean(currentStatus),
    runningCurrentStatusObserved: Boolean(currentStatus),
    streamingAnswerVisible,
    runningPanelVisible,
    streamingReplacesProgress,
    runningSummaryNotDuplicated
  }
})()`)
const latestChecks = await evaluate(`(async () => {
  const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration))
  const messageList = document.querySelector('.message-list')
  const getLatestButton = () => document.querySelector(
    '.chat-scroll-latest, [data-chat-scroll-latest], ' +
    'button[aria-label*="回到最新"], button[aria-label*="滚动到底部"], ' +
    'button[title*="回到最新"], button[title*="最新消息"]'
  )
  const atBottom = () => {
    if (!messageList) return false
    return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= 4
  }
  const previousScrollBehavior = messageList?.style.scrollBehavior ?? ''
  const spacer = messageList?.querySelector('.message-row')
  const previousSpacerMinHeight = spacer?.style.minHeight ?? ''
  let forcedScrollable = false
  if (messageList && spacer && messageList.scrollHeight <= messageList.clientHeight + 8) {
    spacer.style.minHeight = String(messageList.clientHeight + 320) + 'px'
    forcedScrollable = true
    await sleep(80)
  }
  if (messageList) {
    messageList.style.scrollBehavior = 'auto'
    messageList.scrollTop = 0
    messageList.dispatchEvent(new Event('scroll', { bubbles: true }))
    await sleep(120)
  }
  const latestButton = getLatestButton()
  const messageListScrollable = Boolean(
    messageList && messageList.scrollHeight > messageList.clientHeight + 8
  )
  const latestControlExpected = Boolean(spacer && (forcedScrollable || messageListScrollable))
  if (!latestButton) {
    if (messageList) messageList.style.scrollBehavior = previousScrollBehavior
    if (spacer) spacer.style.minHeight = previousSpacerMinHeight
    return {
      latestControlPresent: false,
      latestControlChecked: !latestControlExpected,
      latestControlSkipped: !latestControlExpected,
      latestControlAtBottom: !latestControlExpected,
      latestControlExpected,
      latestControlForcedScrollable: forcedScrollable,
      messageListScrollable
    }
  }
  latestButton.click()
  const started = Date.now()
  while (!atBottom() && Date.now() - started < 1200) await sleep(60)
  const result = {
    latestControlPresent: true,
    latestControlChecked: true,
    latestControlSkipped: false,
    latestControlVisibleAfterScroll: (() => {
      const style = getComputedStyle(latestButton)
      const rect = latestButton.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    })(),
    latestControlAtBottom: atBottom(),
    latestControlExpected,
    latestControlForcedScrollable: forcedScrollable,
    messageListScrollable
  }
  if (messageList) messageList.style.scrollBehavior = previousScrollBehavior
  if (spacer) spacer.style.minHeight = previousSpacerMinHeight
  return result
})()`)
const requiredChecks = {
  // Existing smoke fields remain in the output above; these are the new
  // interaction and accessibility gates for the redesign.
  historySearchControl: historyUiChecks.historySearchControl,
  historySearchFiltering: historyUiChecks.historySearchFiltering,
  historyHintRemoved: historyUiChecks.historyHintRemoved,
  historyRowsCompact: historyUiChecks.historyRowsCompact,
  historyRowsFlattened: historyUiChecks.historyRowsFlattened,
  historyListOwnsScroll: historyUiChecks.historyListOwnsScroll,
  historyToggle: historyUiChecks.historyToggle,
  historyPanelCollapseObserved: historyUiChecks.historyPanelCollapseObserved,
  historyPanelRestoreObserved: historyUiChecks.historyPanelRestoreObserved,
  sessionTitlePresent: historyUiChecks.sessionTitlePresent,
  messageContainerAccessible: historyUiChecks.messageContainerAccessible,
  expertButtonAccessible: historyUiChecks.expertButtonAccessible,
  sendButtonAccessible: historyUiChecks.sendButtonAccessible,
  completedTaskDetailsCollapsed: taskDetailChecks.completedTaskDetailsCollapsed,
  completedTaskDetailsEntry: taskDetailChecks.completedTaskDetailsEntry,
  completedTaskDetailsExpandable: taskDetailChecks.completedTaskDetailsExpandable,
  messageRoleAlignmentSeparated: messagePresentationChecks.messageRoleAlignmentSeparated,
  legacyMarkdownMarkerHidden: messagePresentationChecks.legacyMarkdownMarkerHidden,
  chatTrackMatchesPageTrack: wideTrackChecks.chatTrackMatchesPageTrack,
  oldEmptyStateClassesRemoved: simplificationChecks.oldEmptyStateClassesRemoved,
  promptCompact: simplificationChecks.promptCompact,
  topDataStatusBadgeNotDuplicated: simplificationChecks.topDataStatusBadgeNotDuplicated,
  onlineModelExplanationCompact: simplificationChecks.onlineModelExplanationCompact,
  streamingReplacesProgress: runningTaskChecks.streamingReplacesProgress,
  runningSummaryNotDuplicated: runningTaskChecks.runningSummaryNotDuplicated,
  composerOwnsFocusBoundary: focusChecks.composerOwnsFocusBoundary,
  narrowHistoryEntry: narrowHistoryChecks?.narrowHistoryEntry === true,
  darkThemeApplied: darkThemeChecks.darkThemeApplied,
  darkThemeSurfaces: darkThemeChecks.darkThemeSurfaces,
  lightThemeApplied: lightThemeChecks.lightThemeApplied,
  lightThemeSurfaces: lightThemeChecks.lightThemeSurfaces,
  ...(latestChecks.latestControlExpected || latestChecks.latestControlPresent ? {
    latestControlPresent: latestChecks.latestControlPresent,
    latestControlChecked: latestChecks.latestControlChecked,
    latestControlAtBottom: latestChecks.latestControlAtBottom
  } : {}),
  ...(runningTaskChecks.runningControlFlowLarge ? {
    runningControlFlowCollapsed: runningTaskChecks.runningControlFlowCollapsed,
    runningControlFlowEntry: runningTaskChecks.runningControlFlowEntry,
    runningCurrentStatusVisible: runningTaskChecks.runningCurrentStatusVisible
  } : {})
}
const failedChecks = Object.entries(requiredChecks)
  .filter(([, value]) => value !== true)
  .map(([key]) => key)
console.log(JSON.stringify({
  ...checks,
  ...historyChecks,
  ...historyUiChecks,
  ...narrowHistoryChecks,
  ...newConversationChecks,
  ...taskDetailChecks,
  ...simplificationChecks,
  ...focusChecks,
  ...conversationChecks,
  ...runningTaskChecks,
  ...latestChecks,
  ...messagePresentationChecks,
  ...wideTrackChecks,
  ...darkThemeChecks,
  ...lightThemeChecks,
  requiredChecks,
  ok: failedChecks.length === 0,
  screenshot,
  lightScreenshot,
  focusScreenshot,
  conversationScreenshot,
  messageScreenshot,
  wideScreenshot,
  failedChecks
}, null, 2))
socket.close()

if (failedChecks.length) {
  throw new Error(`Chat UI smoke checks failed: ${failedChecks.join(', ')}`)
}
