import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path) => readFileSync(join(process.cwd(), path), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const updaterSource = read('src/main/updater.ts')
const sharedSource = read('src/shared/types.ts')
const preloadSource = read('src/preload/index.ts')
const mainSource = read('src/main/index.ts')
const appSource = read('src/renderer/src/App.tsx')
const stylesSource = read('src/renderer/src/styles.css')

const errorNormalizerMatch = updaterSource.match(
  /(?:const|function)\s+((?:normalize|sanitize)\w*(?:error|failure|exception|message)\w*)\s*(?:=|\()/i
)
const errorNormalizerName = errorNormalizerMatch?.[1] ?? ''
const errorNormalizerStart = errorNormalizerName
  ? updaterSource.indexOf(errorNormalizerName)
  : -1
const errorNormalizerSource = errorNormalizerStart >= 0
  ? updaterSource.slice(errorNormalizerStart, errorNormalizerStart + 3000)
  : ''
const errorStatusBlocks = [...updaterSource.matchAll(
  /phase:\s*['"]error['"][\s\S]{0,320}?message:\s*([^\n,}]+)/g
)].map((match) => match[0])
const normalizedErrorStatusBlocks = errorStatusBlocks.filter((block) =>
  errorNormalizerName && block.includes(errorNormalizerName)
)
const errorStatusMessages = normalizedErrorStatusBlocks.map((block) =>
  block.match(/message:\s*([^\n,}]+)/)?.[1]?.trim() ?? ''
)
const normalizerCall = errorNormalizerName
  ? new RegExp(`\\b${errorNormalizerName}\\s*\\(`)
  : null

const checks = {
  dependency: Boolean(packageJson.dependencies?.['electron-updater']),
  githubProvider: packageJson.build?.publish?.provider === 'github'
    && packageJson.build.publish.owner === 'ishangsf'
    && packageJson.build.publish.repo === 'visslmRequirement',
  commonJsInterop: updaterSource.includes("import electronUpdater from 'electron-updater'")
    && updaterSource.includes('const { autoUpdater } = electronUpdater'),
  stableArtifactName: packageJson.build?.artifactName === 'VISSLM-Agent-Setup-${version}.${ext}',
  manualDownload: updaterSource.includes('autoUpdater.autoDownload = false')
    && updaterSource.includes('autoUpdater.autoInstallOnAppQuit = false'),
  lifecycleEvents: ['update-available', 'update-not-available', 'download-progress', 'update-downloaded']
    .every((event) => updaterSource.includes(`autoUpdater.on('${event}'`)),
  packagedGuard: updaterSource.includes('return app.isPackaged && supportedPlatforms.has(process.platform)'),
  sharedContract: sharedSource.includes('export interface UpdateStatus')
    && sharedSource.includes("checkForUpdates(): Promise<UpdateStatus>"),
  ipcContract: mainSource.includes("ipcMain.handle('update:check'")
    && preloadSource.includes("ipcRenderer.invoke('update:download')"),
  settingsUi: appSource.includes('settings-update-section')
    && appSource.includes('重启并安装')
    && stylesSource.includes('.settings-update-progress'),
  errorMessageNormalizer: Boolean(errorNormalizerName),
  errorNormalizerHandlesNotFound: Boolean(errorNormalizerName)
    && /\b(?:statusCode|status|httpStatus|response\.status|code)\b[\s\S]{0,80}\b404\b|\b404\b[\s\S]{0,80}\b(?:statusCode|status|httpStatus|response\.status|code)\b/i.test(errorNormalizerSource)
    && /(?:no[-_]?releases?|no(?:[-_\s]+\w+){1,3}[-_\s]+releases?)/i.test(errorNormalizerSource)
    && errorNormalizerSource.includes('latest.yml'),
  releaseAccessErrorIsActionable: errorNormalizerSource.includes('isReleaseAccessError')
    && errorNormalizerSource.includes('无法读取 GitHub 正式 Release')
    && errorNormalizerSource.includes("code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === ''")
    && errorNormalizerSource.includes('statusCode === 404'),
  releaseNotesAreReadableText: updaterSource.includes('normalizeReleaseNoteText')
    && updaterSource.includes(".replace(/<[^>]*>/g, '')")
    && updaterSource.includes(".replace(/<\\s*li\\b[^>]*>/gi, '\\n- ')")
    && updaterSource.includes('decodeReleaseNoteEntities'),
  errorNormalizerSeparatesFailureCategories: errorNormalizerSource.includes('statusCode === 401')
    && errorNormalizerSource.includes('statusCode === 403')
    && errorNormalizerSource.includes('statusCode >= 500')
    && errorNormalizerSource.includes('isNetworkError'),
  errorNormalizerDoesNotReturnRawInput: !errorNormalizerSource.includes('return message')
    && !errorNormalizerSource.includes('return String(error)')
    && errorNormalizerSource.includes('当前没有可访问的正式 Release'),
  errorStatusUsesNormalizer: Boolean(normalizerCall)
    && normalizedErrorStatusBlocks.length >= 3
    && errorStatusMessages.every((message) => normalizerCall.test(message)),
  errorMessageDoesNotExposeResponseMetadata: normalizedErrorStatusBlocks.length >= 3
    && normalizedErrorStatusBlocks.every((block) => !/(?:responseHeaders|response\s*\.\s*headers?|set[-_]cookie|JSON\.stringify\s*\(\s*error\s*\))/i.test(block))
}

console.log(JSON.stringify(checks, null, 2))
if (!Object.values(checks).every(Boolean)) {
  throw new Error(`Updater smoke failed: ${JSON.stringify(checks)}`)
}
