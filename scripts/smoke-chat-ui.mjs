import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json()
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
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshot = join(process.env.TEMP, 'visslm-chat-redesign.png')
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
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
const focusChecks = await evaluate(`(() => {
  const input = document.querySelector('.composer textarea');
  input?.focus();
  const style = input ? getComputedStyle(input) : null;
  return {
    inputFocused: document.activeElement === input,
    inputFocusShadowRemoved: style?.boxShadow === 'none',
    inputFocusOutlineRemoved: style?.outlineStyle === 'none'
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
console.log(JSON.stringify({
  ...checks,
  ...historyChecks,
  ...newConversationChecks,
  ...focusChecks,
  ...conversationChecks,
  screenshot,
  focusScreenshot,
  conversationScreenshot
}, null, 2))
socket.close()
