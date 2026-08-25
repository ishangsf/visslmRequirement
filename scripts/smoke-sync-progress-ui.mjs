import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const appSource = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const stylesSource = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
const rendererHtmlSource = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
const imgSrcDirective = rendererHtmlSource.match(/img-src\s+([^;\"]+)/i)?.[1] ?? ''

const cssRule = (selector) => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stylesSource.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`, 'm'))
  return match?.[1] ?? ''
}

const syncProgressRule = cssRule('.sync-progress')
const messageRule = cssRule('.sync-progress-message')
const messageTextRule = cssRule('.sync-progress-message-text')
const checks = {
  statefulProgressContainer: appSource.includes('className={`sync-progress sync-progress--${progressState}`}'),
  errorHasSemanticRole: appSource.includes("role={progressState === 'error' ? 'alert' : 'status'}"),
  liveAnnouncement: appSource.includes("aria-live={progressState === 'error' ? 'assertive' : 'polite'}"),
  atomicAnnouncement: appSource.includes('aria-atomic="true"'),
  progressAccessibleName: appSource.includes('aria-label={`${progressStateLabel}：${progressMessage}`}'),
  progressBarAccessibleName: appSource.includes('aria-label={`${progressStateLabel}，${progress?.current ?? 0} / ${progress?.total ?? 0}`}'),
  explicitErrorLabel: appSource.includes("? '采集失败'") && appSource.includes("progressState === 'error'"),
  messageHasDedicatedContainer: appSource.includes('className="sync-progress-message"'),
  messageHasVisibleStateText: appSource.includes('className="sync-progress-state"') && appSource.includes('aria-hidden="true"'),
  progressCanShrink: syncProgressRule.includes('min-width: 0'),
  messageCanShrink: messageRule.includes('min-width: 0'),
  messageCanWrap: messageRule.includes('flex-wrap: wrap'),
  textCanShrink: messageTextRule.includes('min-width: 0') && messageTextRule.includes('max-width: 100%'),
  textWrapsNormalText: messageTextRule.includes('white-space: normal'),
  textWrapsLongTokens: messageTextRule.includes('overflow-wrap: anywhere') && messageTextRule.includes('word-break: break-word'),
  messageTextDoesNotForceNoWrap: !messageTextRule.includes('white-space: nowrap'),
  themeSurfaceTokens: messageRule.includes('var(--surface-soft)') && messageRule.includes('var(--stroke)') && messageRule.includes('var(--text-main)'),
  semanticStateTokens: stylesSource.includes('.sync-progress--error') && stylesSource.includes('var(--state-error)') && stylesSource.includes('var(--state-success)'),
  noLocalLightBackground: !/\.sync-progress(?:-[^{\s]+)?(?:[^{}]*)\{[^{}]*background:\s*(?:#|rgb\(|white)/i.test(stylesSource),
  cspHasImgSrcDirective: imgSrcDirective.length > 0,
  cspAllowsVisslmAssetScheme: imgSrcDirective.split(/\s+/).includes('visslm-asset:'),
  cspImgSrcDisallowsWildcard: !imgSrcDirective.includes('*')
}

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `sync progress UI contract failed: ${name}`)
}

console.log(JSON.stringify({ ok: true, checks }, null, 2))
