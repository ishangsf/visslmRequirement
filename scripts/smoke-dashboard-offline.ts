import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type { DashboardSpec } from '../src/shared/dashboard'
import { createDashboardOfflineArchive } from '../src/main/dashboards/offline-export'
import { dashboardSpecHash } from '../src/main/dashboards/spec-hash'

const outputRoot = join(process.cwd(), 'out', 'offline')
const readAsset = (name: string): Buffer => readFileSync(join(outputRoot, name))

const spec: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'offline-smoke-dashboard',
  title: '离线预览 </script><script>window.__OFFLINE_INJECTION__=1</script>',
  subtitle: '固定快照，不重新查询',
  theme: 'technology-dark',
  updatedAt: '2026-08-03T00:00:00.000Z',
  globalFilters: [],
  components: [
    {
      id: 'kpi-total',
      type: 'kpi',
      title: '总量',
      layout: { x: 0, y: 0, w: 6, h: 3 },
      data: [{ name: '总量', value: 123 }],
      unit: '条',
      accent: '#64dbff'
    },
    {
      id: 'bar-category',
      type: 'bar',
      title: '分类构成',
      layout: { x: 6, y: 0, w: 9, h: 5 },
      data: [
        { name: '甲类', value: 42 },
        { name: '乙类', value: 37 },
        { name: '丙类', value: 18 }
      ],
      encoding: { label: 'category', value: 'count' }
    },
    {
      id: 'pie-category',
      type: 'pie',
      title: '占比',
      layout: { x: 15, y: 0, w: 9, h: 5 },
      data: [
        { name: '甲类', value: 42 },
        { name: '乙类', value: 37 },
        { name: '丙类', value: 18 }
      ],
      encoding: { label: 'category', value: 'count' }
    }
  ]
}

const assets = {
  indexHtml: readAsset('index.html').toString('utf8'),
  viewerScript: new Uint8Array(readAsset('dashboard-viewer.js')),
  viewerStyle: new Uint8Array(readAsset('dashboard-viewer.css'))
}
const archive = createDashboardOfflineArchive(spec, 7, assets, '2026-08-03T01:02:03.000Z')
const files = unzipSync(archive)
const expectedFiles = [
  'dashboard-data.js',
  'dashboard-viewer.css',
  'dashboard-viewer.js',
  'index.html',
  'manifest.json'
]

assert.deepEqual(Object.keys(files).sort(), expectedFiles)
for (const name of expectedFiles) assert.ok(files[name].byteLength > 0, `${name} 不能为空`)

const html = strFromU8(files['index.html'])
const dataScript = strFromU8(files['dashboard-data.js'])
const viewerScript = strFromU8(files['dashboard-viewer.js'])
const viewerStyle = strFromU8(files['dashboard-viewer.css'])
const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>

assert.match(html, /<script src="\.\/dashboard-data\.js"><\/script>/)
assert.match(html, /<script src="\.\/dashboard-viewer\.js"><\/script>/)
assert.match(html, /<link rel="stylesheet" href="\.\/dashboard-viewer\.css"\s*\/>/)
const rootPosition = html.indexOf('<div id="root"></div>')
const dataScriptPosition = html.indexOf('<script src="./dashboard-data.js"></script>')
const viewerScriptPosition = html.indexOf('<script src="./dashboard-viewer.js"></script>')
assert.ok(rootPosition >= 0, '离线 viewer 缺少 root 节点')
assert.ok(rootPosition < dataScriptPosition, '离线数据脚本必须在 root 节点之后执行')
assert.ok(dataScriptPosition < viewerScriptPosition, '离线 viewer 脚本必须在数据脚本之后执行')
assert.doesNotMatch(html, /<script type="module"/i)
assert.doesNotMatch(html, /(?:src|href)="(?:https?:|\/\/)/i)
assert.match(html, /connect-src 'none'/)
assert.match(dataScript, /window\.__VISSLM_DASHBOARD_EXPORT__\s*=/)
assert.doesNotMatch(dataScript, /<\/script>/i)
assert.doesNotMatch(viewerScript, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/)
assert.doesNotMatch(viewerScript, /window\.print|打印大屏/)
assert.match(viewerScript, /is-fullscreen/)
assert.match(viewerStyle, /\.offline-app\.is-fullscreen \.offline-toolbar/)
assert.doesNotMatch(viewerStyle, /@import\s|url\(\s*["']?https?:/i)
assert.equal(manifest.format, 'visslm-dashboard-offline')
assert.equal(manifest.networkAccess, 'none')
assert.equal(manifest.dataMode, 'snapshot')
assert.equal(manifest.dashboardVersion, 7)
assert.equal(manifest.specHash, dashboardSpecHash(spec))
assert.equal(manifest.componentCount, spec.components.length)

const smokeDirectory = mkdtempSync(join(tmpdir(), 'visslm-dashboard-offline-'))
for (const name of expectedFiles) {
  writeFileSync(join(smokeDirectory, name), Buffer.from(files[name]))
}

console.log(JSON.stringify({ ok: true, archiveBytes: archive.byteLength, smokeDirectory }, null, 2))
