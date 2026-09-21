import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf8')

const wizard = read('src/renderer/src/dashboard/DashboardScenarioWizard.tsx')
const studio = read('src/renderer/src/dashboard/DashboardStudio.tsx')
const styles = read('src/renderer/src/styles.css')
const preload = read('src/preload/index.ts')
const main = read('src/main/index.ts')

const escapeRegExp = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

const assertSourceContains = (source: string, needle: string, message: string): void => {
  assert.ok(source.includes(needle), message)
}

const assertSourceMatches = (source: string, pattern: RegExp, message: string): void => {
  assert.match(source, pattern, message)
}

const findClass = (source: string, candidates: readonly string[], message: string): string => {
  const className = candidates.find((candidate) => source.includes(candidate))
  assert.ok(className, message)
  return className
}

/** Return the content inside a CSS/JS brace pair, including nested pairs. */
const balancedBody = (source: string, openBraceIndex: number): string => {
  assert.equal(source[openBraceIndex], '{', 'expected an opening brace at ' + openBraceIndex)
  let depth = 0
  for (let index = openBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openBraceIndex + 1, index)
    }
  }
  throw new Error('unclosed brace at ' + openBraceIndex)
}

const cssRuleBodies = (source: string, selector: string): string[] => {
  const bodies: string[] = []
  const pattern = new RegExp(escapeRegExp(selector) + '\\s*\\{', 'g')
  for (const match of source.matchAll(pattern)) {
    const openBraceIndex = (match.index ?? 0) + match[0].length - 1
    bodies.push(balancedBody(source, openBraceIndex))
  }
  return bodies
}

const assertCssRule = (
  source: string,
  selectors: readonly string[],
  declaration: RegExp,
  message: string
): void => {
  const body = selectors.flatMap((selector) => cssRuleBodies(source, selector)).find((item) => declaration.test(item))
  assert.ok(body, message)
}

const scenarioIds = [
  'project-overview',
  'requirements-delivery',
  'plan-milestone',
  'software-quality',
  'test-validation',
  'configuration-change',
  'gjb5000b-compliance',
  'organization-improvement'
] as const

const stepTitles = ['选择场景', '数据范围', '准备度检查', '生成预览'] as const

// Keep the local gallery contract honest: exactly the original eight scenarios,
// with no accidental duplicate or silently omitted card.
const definitionsStart = wizard.indexOf('const scenarioDefinitions')
assert.ok(definitionsStart >= 0, 'wizard must declare the golden scenario definitions')
const definitionsEnd = wizard.indexOf('\n]\n', definitionsStart)
assert.ok(definitionsEnd > definitionsStart, 'wizard scenario definitions must be a closed array')
const definitionsSource = wizard.slice(definitionsStart, definitionsEnd)
const declaredScenarioIds = [...definitionsSource.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
assert.deepEqual(declaredScenarioIds, scenarioIds, 'golden scenario IDs/order must remain unchanged')
assert.equal(new Set(declaredScenarioIds).size, 8, 'golden scenario IDs must be unique')

// The Ant Steps contract remains four steps and is now hosted by the persistent
// left rail rather than being rendered as a transient task header.
const stepsStart = wizard.indexOf('<Steps')
assert.ok(stepsStart >= 0, 'wizard must keep the four-step progress indicator')
const stepsItemsStart = wizard.indexOf('items={[', stepsStart)
assert.ok(stepsItemsStart > stepsStart, 'wizard Steps must declare its item list')
const stepsItemsEnd = wizard.indexOf(']}', stepsItemsStart)
assert.ok(stepsItemsEnd > stepsItemsStart, 'wizard Steps item list must be closed')
const stepsSource = wizard.slice(stepsStart, stepsItemsEnd)
assertSourceContains(stepsSource, 'current={step}', 'wizard Steps must remain controlled by the current step')
for (const stepTitle of stepTitles) {
  assertSourceMatches(stepsSource, new RegExp("title:\\s*['\"]" + escapeRegExp(stepTitle) + "['\"]"), 'missing wizard step: ' + stepTitle)
}
assert.equal((stepsSource.match(/title:\s*['"]/g) ?? []).length, 4, 'wizard must expose exactly four step titles')

// Every step uses a semantic custom icon.  Keep the process state from
// collapsing into an opaque solid block: the icon host needs a softer themed
// surface and the glyph needs an explicit, contrasting theme-token color.
const customStepIcons = [...stepsSource.matchAll(/icon:\s*<([A-Za-z]+Outlined)(?:\s+[^>]*)?\s*\/>/g)].map((match) => match[1])
assert.equal(customStepIcons.length, 4, 'wizard steps must retain one custom icon per step')
assert.equal(new Set(customStepIcons).size, 4, 'wizard steps must keep distinct custom icons')

// Structural contract for the refactored shell. Candidate aliases keep the
// check tolerant of a layout-versus-shell naming choice while still requiring
// explicit, independently styleable regions.
const shellClass = findClass(
  wizard,
  ['dashboard-scenario-wizard-shell', 'dashboard-scenario-wizard-layout'],
  'wizard must provide a persistent two-pane shell'
)
const railClass = findClass(
  wizard,
  ['dashboard-scenario-wizard-rail', 'dashboard-scenario-wizard-sidebar'],
  'wizard must provide a left navigation rail'
)
const taskClass = findClass(
  wizard,
  ['dashboard-scenario-wizard-task-panel', 'dashboard-scenario-wizard-panel', 'dashboard-scenario-wizard-content'],
  'wizard must provide a right task panel'
)
const scrollClass = findClass(
  wizard,
  ['dashboard-scenario-wizard-task-scroll', 'dashboard-scenario-wizard-content-scroll', 'dashboard-scenario-wizard-content', 'dashboard-scenario-wizard-scroll'],
  'wizard task content must have an explicit internal scroll region'
)
const summaryClass = findClass(
  wizard,
  ['dashboard-scenario-wizard-current-scenario', 'dashboard-scenario-wizard-scenario-summary', 'dashboard-scenario-wizard-rail-context', 'dashboard-scenario-wizard-summary'],
  'wizard must provide a current-scenario summary in the rail'
)
const footerClass = findClass(
  wizard,
  ['dashboard-scenario-wizard-footer', 'dashboard-scenario-wizard-actions'],
  'wizard footer/actions must have an explicit layout hook'
)

const modalStart = wizard.indexOf('<Modal')
const modalEnd = wizard.indexOf('</Modal>', modalStart)
assert.ok(modalStart >= 0 && modalEnd > modalStart, 'wizard must render a complete Modal')
const modalSource = wizard.slice(modalStart, modalEnd)
const shellPosition = modalSource.indexOf(shellClass)
const firstStepRender = [...modalSource.matchAll(/\{\s*step\s*===/g)]
  .map((match) => match.index ?? -1)
  .find((position) => position > shellPosition) ?? -1
assert.ok(firstStepRender >= 0, 'wizard must retain step-specific task rendering')
assert.ok(shellPosition >= 0 && shellPosition < firstStepRender, 'two-pane shell must wrap all step-specific tasks')
const persistentShellSource = modalSource.slice(shellPosition, firstStepRender)
assertSourceContains(persistentShellSource, railClass, 'left rail must be persistent across all wizard steps')
assertSourceContains(persistentShellSource, '<Steps', 'left rail must own the four-step progress indicator')
assertSourceMatches(persistentShellSource, /当前(?:黄金)?场景/, 'left rail must label the current scenario')
assertSourceContains(persistentShellSource, 'scenario.name', 'left rail must show the selected scenario name')
assertSourceContains(persistentShellSource, summaryClass, 'current scenario summary must live in the persistent rail')

const taskPosition = modalSource.indexOf(taskClass)
assert.ok(taskPosition > shellPosition, 'right task panel must be a child region of the shell')
assertSourceContains(modalSource.slice(taskPosition), scrollClass, 'task panel must contain its internal scroll region')
const railWindow = modalSource.slice(Math.max(0, modalSource.indexOf(railClass) - 180), modalSource.indexOf(railClass) + 600)
assertSourceMatches(railWindow, /aria-(?:label|labelledby)=/, 'left rail must have an accessible name')
const taskWindow = modalSource.slice(Math.max(0, taskPosition - 180), taskPosition + 800)
assertSourceMatches(taskWindow, /(?:<section[^>]*aria-label=|role=[\"']region[\"'][^>]*aria-label=|aria-label=[\"'][^\"']+[\"'][^>]*role=[\"']region[\"'])/, 'right task panel must be an accessible region')

// The action footer must be supplied through Modal.footer (outside the body
// scroll region), and must remain in the shell-independent part of the modal.
const footerPropPosition = modalSource.indexOf('footer={')
assert.ok(footerPropPosition >= 0 && footerPropPosition < firstStepRender, 'wizard actions must remain in the Modal footer')
assertSourceContains(modalSource.slice(footerPropPosition, firstStepRender), footerClass, 'Modal footer must expose its fixed action-area hook')

// Read only the wizard CSS tail so unrelated app rules cannot satisfy these
// assertions. The viewport and body both need a dynamic vh bound; the task
// panel then owns the actual overflow while the footer stays visible.
const wizardStyleStart = styles.indexOf('.dashboard-scenario-wizard-modal')
assert.ok(wizardStyleStart >= 0, 'wizard styles must be present')
const wizardStyles = styles.slice(wizardStyleStart)
const dynamicViewport = /(?:max-height|height)\s*:\s*[^;]*(?:100vh|\d+vh)/
assertCssRule(
  wizardStyles,
  ['.dashboard-scenario-wizard-modal .ant-modal', '.dashboard-scenario-wizard-modal .ant-modal-content'],
  /max-height\s*:\s*[^;]*(?:100vh|\d+vh)/,
  'wizard modal viewport must have a responsive max-height'
)
assertCssRule(
  wizardStyles,
  ['.dashboard-scenario-wizard-modal .ant-modal-body'],
  dynamicViewport,
  'wizard modal body must be bounded by the available viewport height'
)
assertCssRule(
  wizardStyles,
  ['.' + scrollClass],
  /overflow(?:-y)?\s*:\s*(?:auto|scroll)/,
  'wizard task panel must scroll internally instead of stretching the page'
)
assertCssRule(
  wizardStyles,
  ['.' + scrollClass, '.' + taskClass],
  /min-height\s*:\s*0/,
  'wizard scroll layout must permit flex children to shrink'
)
assertCssRule(
  wizardStyles,
  ['.' + footerClass, '.dashboard-scenario-wizard-modal .ant-modal-footer'],
  /(?:flex\s*:\s*0\s+0\s+auto|position\s*:\s*sticky)/,
  'wizard footer/actions must remain fixed while task content scrolls'
)

const processIconSelector = '.dashboard-scenario-wizard-steps .ant-steps-item-process .ant-steps-item-icon'
const processIconBody = cssRuleBodies(wizardStyles, processIconSelector).find((body) => body.trim())
assert.ok(processIconBody, 'current wizard step icon must have a scoped style rule')
assert.doesNotMatch(
  processIconBody ?? '',
  /background(?:-color)?\s*:\s*var\(\s*--accent\s*\)\s*;/,
  'current step icon must not be an opaque unqualified accent block'
)
assert.match(
  processIconBody ?? '',
  /background(?:-color)?\s*:\s*(?:var\(\s*--(?:accent-soft|surface-soft|surface-raised)\s*\)|color-mix\(|linear-gradient\()/,
  'current step icon host must retain a layered themed background'
)
const processGlyphSelector = '.dashboard-scenario-wizard-steps .ant-steps-item-process .ant-steps-icon'
const processGlyphBody = cssRuleBodies(wizardStyles, processGlyphSelector).find((body) => body.trim())
assert.ok(processGlyphBody, 'current wizard step glyph must have a scoped style rule')
assert.match(
  processGlyphBody ?? '',
  /color\s*:\s*var\(\s*--(?:text-main|surface-base|surface-raised|accent)\s*\)/,
  'current step glyph must declare a visible theme-token foreground color'
)

// A narrow-window rule must collapse the shell (and keep the task region
// usable), not merely resize the old scenario card grid.
const mediaBlocks: Array<{ maxWidth: number; body: string }> = []
const mediaPattern = /@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g
for (const match of styles.matchAll(mediaPattern)) {
  const openBraceIndex = (match.index ?? 0) + match[0].length - 1
  mediaBlocks.push({ maxWidth: Number(match[1]), body: balancedBody(styles, openBraceIndex) })
}
const responsiveWizardMedia = mediaBlocks.filter(({ body }) => body.includes(shellClass) || body.includes(railClass) || body.includes(taskClass))
assert.ok(responsiveWizardMedia.length > 0, 'wizard shell must have an explicit responsive breakpoint')
assert.ok(
  responsiveWizardMedia.some(({ maxWidth, body }) => maxWidth <= 840 && /(?:grid-template-columns\s*:\s*1fr|grid-template-areas|flex-direction\s*:\s*column|display\s*:\s*block)/.test(body)),
  'wizard breakpoint must collapse/reflow the two-pane layout on narrow windows'
)
assert.ok(
  /max-width\s*:\s*calc\(\s*100vw\s*-\s*32px\s*\)/.test(wizardStyles) || /100vw\s*-\s*32px/.test(modalSource),
  'wizard modal must reserve a 32px viewport gutter on narrow windows'
)

for (const token of [
  '--surface-raised',
  '--surface-soft',
  '--stroke',
  '--accent',
  '--accent-soft',
  '--text-main',
  '--text-muted',
  '--focus-ring'
] as const) {
  assert.match(wizardStyles, new RegExp('var\\(' + escapeRegExp(token)), 'wizard styles must use theme token ' + token)
}
assert.doesNotMatch(
  wizardStyles,
  /background(?:-color)?\s*:\s*(?:white|#fff(?:fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i,
  'wizard must not introduce a white local background in the dark theme'
)

// Keyboard and screen-reader semantics for scenario/step actions must survive
// the layout refactor, and focus-visible must remain visible in the scoped CSS.
assertSourceMatches(wizard, /tabIndex=\{0\}/, 'scenario cards/rail actions must be keyboard reachable')
assertSourceMatches(wizard, /onKeyDown=\{/, 'scenario selection must support keyboard activation')
assertSourceMatches(wizard, /aria-(?:pressed|current|selected)=/, 'selected scenario/step state must be exposed semantically')
assertSourceMatches(wizard, /aria-label=/, 'wizard controls must provide accessible names')
assert.match(wizardStyles, /\.dashboard-scenario-wizard-[^,{]+:focus-visible/, 'wizard controls must have focus-visible styling')

// Existing integration contracts: gallery entry and both domain IPC calls must
// remain intact while the renderer shell changes.
for (const scenarioId of scenarioIds) {
  assertSourceContains(wizard, "id: '" + scenarioId + "'", scenarioId)
}
for (const apiName of ['getDashboardScenarioReadiness', 'generateDashboardFromScenario'] as const) {
  assertSourceContains(wizard, 'window.visslm.' + apiName, apiName)
  assertSourceContains(preload, apiName + ':', 'preload ' + apiName)
  assertSourceContains(
    main,
    'dashboard-domain:' + (apiName === 'getDashboardScenarioReadiness' ? 'readiness' : 'generate-from-scenario'),
    'main ' + apiName
  )
}
assertSourceContains(studio, 'DashboardScenarioWizard', 'DashboardStudio must mount DashboardScenarioWizard')
assertSourceContains(studio, '从黄金场景创建大屏', 'DashboardStudio must retain the golden-scenario entry')
assertSourceMatches(studio, /aria-label=[\"']从黄金场景创建大屏[\"']/, 'golden-scenario entry must have an accessible name')

// Generation can pause for an explicit user decision.  The wizard must render
// that result as an in-context, visible message instead of silently leaving the
// user on the preview step (or treating clarification as rejection).
const clarificationStatusMatch = wizard.match(/generation(?:\?\.)?status\s*===\s*['\"]clarification['\"]/)
assert.ok(clarificationStatusMatch?.index !== undefined, 'wizard must branch explicitly on clarification generation status')
const clarificationRenderWindow = wizard.slice(
  clarificationStatusMatch?.index ?? 0,
  (clarificationStatusMatch?.index ?? 0) + 1800
)
assert.match(clarificationRenderWindow, /<Alert\b/, 'clarification status must render a visible Alert in the wizard')
assert.match(
  clarificationRenderWindow,
  /(?:clarification|澄清|补充|等待|generation\.(?:answer|reason)|generation\?\.(?:answer|reason))/i,
  'clarification Alert must expose actionable status text'
)

// Keep the alternate platform-adapter source selectable and carried through
// the draft; this guards the structured controlled-sample UI fix from dropping
// the existing adapter path.
assertSourceContains(wizard, "'platform-adapter'", 'wizard must retain the platform-adapter data mode')
assertSourceContains(wizard, 'selectedAdapter', 'wizard must resolve a selected platform adapter')
assertSourceContains(wizard, 'adapter: selectedAdapter', 'wizard must carry the selected adapter into the draft')

console.log(JSON.stringify({
  ok: true,
  scenarios: scenarioIds.length,
  steps: stepTitles.length,
  shell: { shellClass, railClass, taskClass, scrollClass, summaryClass, footerClass },
  checks: [
    'golden-scenario-contract',
    'persistent-two-pane-shell',
    'bounded-modal-internal-scroll',
    'fixed-action-footer',
    'responsive-breakpoint',
    'theme-tokens',
    'current-step-icon-contrast',
    'clarification-visible-state',
    'keyboard-accessibility',
    'readiness-api',
    'generation-api',
    'platform-adapter-path'
  ]
}, null, 2))
