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
    && stylesSource.includes('.settings-update-progress')
}

console.log(JSON.stringify(checks, null, 2))
if (!Object.values(checks).every(Boolean)) {
  throw new Error(`Updater smoke failed: ${JSON.stringify(checks)}`)
}
