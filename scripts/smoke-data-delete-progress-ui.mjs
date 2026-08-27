import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8')

const sharedSource = read('src/shared/types.ts')
const preloadSource = read('src/preload/index.ts')
const mainSource = read('src/main/index.ts')
const appSource = read('src/renderer/src/App.tsx')
const stylesSource = read('src/renderer/src/styles.css')

const between = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1
  return source.slice(start, end >= 0 ? end : undefined)
}

const around = (source, marker, before = 1200, after = 2600) => {
  const index = source.indexOf(marker)
  if (index < 0) return ''
  return source.slice(Math.max(0, index - before), index + after)
}

const hasEvery = (source, patterns) => patterns.every((pattern) =>
  typeof pattern === 'string' ? source.includes(pattern) : pattern.test(source)
)

const progressTypeIndex = sharedSource.indexOf('DataDeleteProgress')
const progressTypeSource = progressTypeIndex >= 0
  ? sharedSource.slice(Math.max(0, progressTypeIndex - 1600), progressTypeIndex + 3200)
  : ''
const appApiSource = between(sharedSource, 'export interface AppApi', '\n}\n')
const preloadProgressSource = around(preloadSource, 'onDataDeleteProgress', 400, 900)
const mainDeleteSource = between(mainSource, "ipcMain.handle('data:delete'", "ipcMain.handle('")
const mainProgressSource = mainDeleteSource || around(mainSource, 'data:delete-progress', 2600, 7000)
const deletingPhaseSource = around(mainProgressSource, "'deleting_records'", 900, 1200)
const rebuildingPhaseSource = around(mainProgressSource, "'rebuilding_index'", 500, 900)

const dataPageStart = appSource.indexOf('function DataPage(')
const knowledgeBasePageStart = appSource.indexOf('function KnowledgeBasePage(')
const dataPageSource = dataPageStart >= 0
  ? appSource.slice(dataPageStart, knowledgeBasePageStart > dataPageStart ? knowledgeBasePageStart : undefined)
  : ''
const deleteProgressMarker = [
  'data-delete-progress-panel',
  'asset-delete-progress-panel',
  'dataDeleteProgressVisible'
].find((marker) => appSource.includes(marker))
const deleteProgressSource = [
  deleteProgressMarker ? around(appSource, deleteProgressMarker, 2800, 5200) : '',
  around(appSource, 'onDataDeleteProgress', 1800, 2200),
  around(appSource, 'dataDeletePhaseLabels', 200, 1300),
  around(dataPageSource, 'Progress', 1800, 4200)
].join('\n')

const progressStyleSource = (() => {
  const firstMatch = stylesSource.match(/\.(?:data|asset)-delete-progress[^{,\s]*/i)
  return firstMatch ? around(stylesSource, firstMatch[0], 0, 2800) : ''
})()

const dataDeleteBatchLiterals = [...mainSource.matchAll(
  /(?:data|delete|record)[A-Za-z0-9_-]*(?:batch|chunk)(?:Size|Limit)?\s*[:=]\s*(\d+)/gi
)].map((match) => Number(match[1]))
const hasAbout200BatchSize = dataDeleteBatchLiterals.some((size) => Number.isInteger(size) && size >= 50 && size <= 512)

const checks = {
  sharedProgressSnapshot: /(?:export\s+)?(?:interface|type)\s+DataDeleteProgress\b/.test(sharedSource),
  sharedProgressFields: hasEvery(progressTypeSource, [
    /\btaskId\s*:/,
    /\bstatus\s*:/,
    /\bphase\s*:/,
    /\bcurrent\s*:/,
    /\btotal\s*:/,
    /\bpercent\s*:/
  ]),
  sharedStatusValues: hasEvery(progressTypeSource, ["'running'", "'completed'", "'failed'"]),
  sharedPhaseValues: hasEvery(progressTypeSource, [
    "'preparing'",
    "'deleting_records'",
    "'rebuilding_index'",
    "'completed'",
    "'failed'"
  ]),
  appApiProgressListener: /onDataDeleteProgress[\s\S]{0,260}DataDeleteProgress[\s\S]{0,260}\(\)\s*=>\s*void/.test(appApiSource),
  preloadDeleteInvoke: /deleteData\s*:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]data:delete['"]/.test(preloadSource),
  preloadProgressChannel: /onDataDeleteProgress[\s\S]{0,900}ipcRenderer\.on\(\s*['"]data:delete-progress['"]/.test(preloadProgressSource),
  preloadProgressCleanup: /onDataDeleteProgress[\s\S]{0,1100}removeListener\(\s*['"]data:delete-progress['"]/.test(preloadProgressSource),
  mainDeleteIpcHandler: /ipcMain\.handle\(\s*['"]data:delete['"]/.test(mainSource),
  mainProgressChannel: /['"]data:delete-progress['"]/.test(mainSource),
  mainProgressSend: /(?:webContents|mainWindow|window)[^.\n]*\.?(?:webContents)?\.send\(\s*['"]data:delete-progress['"]/.test(mainSource) ||
    /\.send\(\s*['"]data:delete-progress['"]/.test(mainSource),
  mainDeleteBatchesTargets: hasEvery(mainSource, [
    /(?:uids|targetUids|recordUids|selected)[\s\S]{0,1800}(?:slice|chunk|batch)/i,
    /(?:slice|chunk|batch)[\s\S]{0,1800}(?:uids|targetUids|recordUids|selected)/i
  ]),
  mainAbout200BatchSize: hasAbout200BatchSize,
  mainYieldsBetweenBatches: /(?:for|while)\s*\([\s\S]{0,1200}(?:batch|chunk|offset|index)[\s\S]{0,2400}\)\s*\{[\s\S]{0,3600}await\s+(?:new\s+Promise|Promise\.resolve|setImmediate|setTimeout|sleep|delay)/i.test(mainSource) ||
    /(?:batch|chunk)[\s\S]{0,2600}await\s+(?:new\s+Promise|Promise\.resolve|setImmediate|setTimeout|sleep|delay)/i.test(mainDeleteSource),
  mainPercentClampedBeforeCompletion: /Math\.min\(\s*99\s*,[\s\S]{0,280}(?:percent|current|total)/i.test(mainProgressSource) ||
    /(?:percent|current|total)[\s\S]{0,280}Math\.min\(\s*99\s*,/i.test(mainProgressSource),
  mainPercentMonotonic: /Math\.max\([\s\S]{0,220}(?:previous|last|prior|emitted|percent)[\s\S]{0,220}\)/i.test(mainProgressSource) ||
    /(?:previous|last|prior|emitted)[A-Za-z0-9_]*\s*=\s*Math\.max\(/i.test(mainProgressSource),
  mainIntermediatePercentBelow100: /Math\.min\(\s*(?:[1-9]\d?)\s*,/i.test(deletingPhaseSource) &&
    /(?:\b9\d\b|Math\.min\(\s*(?:[1-9]\d?)\s*,)/i.test(rebuildingPhaseSource),
  mainFinalCompletionIs100: /status\s*:\s*['"]completed['"][\s\S]{0,600}percent\s*:\s*100/i.test(mainProgressSource) ||
    /percent\s*:\s*100[\s\S]{0,600}status\s*:\s*['"]completed['"]/i.test(mainProgressSource) ||
    /emit\(\s*['"]completed['"]\s*,\s*['"]completed['"][\s\S]{0,500},\s*100\s*\)/i.test(mainProgressSource),
  mainFailureEmittedBeforeRethrow: /catch\s*\([^)]*\)[\s\S]{0,2600}(?:status\s*:\s*['"]failed['"]|phase\s*:\s*['"]failed['"]|emit\(\s*['"]failed['"])[\s\S]{0,2600}throw\s+error/i.test(mainProgressSource),
  uiSubscribesToProgress: /window\.visslm\.onDataDeleteProgress\s*\(/.test(appSource),
  uiProgressPanel: /className\s*=\s*[`"'][^`"']*(?:data|asset)[-_]delete[-_]progress[^`"']*[`"']/i.test(appSource),
  uiAccessibleProgress: /(?:data[-_]delete[-_]progress|deleteProgress)[\s\S]{0,3500}(?:aria-live|role\s*=|aria-label)/i.test(deleteProgressSource),
  uiCurrentTotalCount: /(?:data[-_]delete[-_]progress|deleteProgress)[\s\S]{0,4200}\bcurrent\b[\s\S]{0,4200}\btotal\b/i.test(deleteProgressSource),
  uiIndexStage: /(?:rebuilding_index|重建索引|索引重建|索引)/i.test(deleteProgressSource),
  uiFailureState: /(?:dataDeleteProgressFailed|status\s*===?\s*['"]failed['"]|status\s*==\s*['"]failed['"]|['"]failed['"])[\s\S]{0,1800}(?:删除失败|失败|error|alert)/i.test(deleteProgressSource),
  uiProgressHidesBuiltInPercentage: /<Progress\b[\s\S]{0,500}showInfo\s*=\s*\{false\}/.test(deleteProgressSource),
  uiNoDuplicatePercentageText: !/>\s*(?:\{[\s\S]{0,260}\b(?:progress|snapshot|deleteProgress)[\s\S]{0,120}\bpercent\b[\s\S]{0,80}%[\s\S]{0,30}\}|\$\{[\s\S]{0,260}\bpercent\b[\s\S]{0,80}%[\s\S]{0,30}\})\s*</i.test(deleteProgressSource),
  themedProgressPanel: hasEvery(progressStyleSource, [
    /background\s*:[^;]*(?:var\(--surface-(?:raised|soft|elevated)\)|color-mix)/i,
    /border[^:]*:\s*[^;]*var\(--stroke/i,
    /color\s*:\s*[^;]*var\(--text-(?:main|muted)/i,
    /var\(--accent\)/i
  ]),
  progressPanelHasNoLightBackground: progressStyleSource.length > 0 &&
    !/background(?:-color)?\s*:\s*(?:white|#fff(?:fff)?\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i.test(progressStyleSource)
}

const failures = Object.entries(checks)
  .filter(([, passed]) => passed !== true)
  .map(([name]) => name)

if (failures.length) {
  throw new Error(`Data delete progress smoke failed: ${JSON.stringify({ failures, checks, dataDeleteBatchLiterals })}`)
}

console.log(JSON.stringify({ ok: true, checks, dataDeleteBatchLiterals }, null, 2))
