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

const cssRulesForClass = (className) => {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rulePattern = new RegExp(
    `\\.${escapedClassName}(?=[\\s,.:>+~{])[^{}]*\\{([^{}]*)\\}`,
    'gm'
  )
  return [...stylesSource.matchAll(rulePattern)].map((match) => match[1]).join('\n')
}

const syncPageStart = appSource.indexOf('function SyncPage(')
const pushPageStart = syncPageStart >= 0 ? appSource.indexOf('\nfunction PushPage(', syncPageStart) : -1
const syncPageSource = syncPageStart >= 0
  ? appSource.slice(syncPageStart, pushPageStart >= 0 ? pushPageStart : undefined)
  : ''
const syncProgressCardStart = syncPageSource.indexOf('className="sync-progress-card"')
const syncProgressCardEnd = syncProgressCardStart >= 0
  ? syncPageSource.indexOf('</Card>', syncProgressCardStart)
  : -1
const syncProgressCardSource = syncProgressCardStart >= 0
  ? syncPageSource.slice(
    syncProgressCardStart,
    syncProgressCardEnd >= 0 ? syncProgressCardEnd + '</Card>'.length : undefined
  )
  : ''

const hasProgressField = (field) => new RegExp(`progress(?:\\?\\.|\\.)${field}`).test(syncPageSource)
const hasCountIdentifier = (field) => new RegExp(`\\b${field}\\b`).test(syncProgressCardSource)
const progressClassNames = [...syncProgressCardSource.matchAll(/className="([^"]*sync-progress[^\"]*)"/g)]
  .flatMap((match) => match[1].split(/\s+/))
const progressStatsClassNames = [...new Set(progressClassNames)].filter((className) =>
  /(?:^|[-_])(?:stats?|counts?|summary|metrics|outcome|results?)(?:[-_]|$)/i.test(className)
)
const progressStatsRules = progressStatsClassNames
  .map((className) => cssRulesForClass(className))
  .filter(Boolean)
  .join('\n')
const ariaLabelAttributes = [...syncProgressCardSource.matchAll(
  /aria-label\s*=\s*(?:\{`[\s\S]*?`\}|\{[^{}]*\}|["'][^"']*["'])/g
)].map((match) => match[0])
const hasAccessibleCount = (field) => ariaLabelAttributes.some((attribute) =>
  new RegExp(`(?:progress(?:\\?\\.|\\.)|\\b)${field}`).test(attribute)
)
const syncPageToolbarStart = syncPageSource.indexOf('<div className="page-toolbar">')
const syncPageToolbarEnd = syncPageToolbarStart >= 0
  ? syncPageSource.indexOf('</div>', syncPageToolbarStart)
  : -1
const syncPageTabsStart = syncPageSource.search(/<Tabs\b/)

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
  progressCardAfterToolbarBeforeTabs: syncPageToolbarEnd >= 0 && syncProgressCardStart > syncPageToolbarEnd && syncPageTabsStart >= 0 && syncProgressCardStart < syncPageTabsStart,
  progressStatsContainer: progressStatsClassNames.length > 0,
  successfulCountReference: hasProgressField('successfulCount'),
  failedCountReference: hasProgressField('failedCount'),
  progressStatsHaveVisibleLabelsAndUnit: /成功/.test(syncProgressCardSource) && /失败/.test(syncProgressCardSource) && /条/.test(syncProgressCardSource) && hasCountIdentifier('successfulCount') && hasCountIdentifier('failedCount'),
  successfulCountHasAccessibleName: hasAccessibleCount('successfulCount'),
  failedCountHasAccessibleName: hasAccessibleCount('failedCount'),
  progressStatsUseThemeTokens: /var\(--(?:surface-soft|surface-raised|stroke|text-main|text-muted)\)/.test(progressStatsRules),
  progressStatsUseSemanticStateTokens: /var\(--state-(?:success|error)\)/.test(progressStatsRules),
  progressStatsKeepCountAndUnitTogether: progressStatsRules.includes('white-space: nowrap'),
  noLocalLightBackground: !/\.sync-progress(?:-[^{\s]+)?(?:[^{}]*)\{[^{}]*background:\s*(?:#|rgb\(|white)/i.test(stylesSource),
  cspHasImgSrcDirective: imgSrcDirective.length > 0,
  cspAllowsVisslmAssetScheme: imgSrcDirective.split(/\s+/).includes('visslm-asset:'),
  cspImgSrcDisallowsWildcard: !imgSrcDirective.includes('*')
}

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `sync progress UI contract failed: ${name}`)
}

console.log(JSON.stringify({ ok: true, checks }, null, 2))
