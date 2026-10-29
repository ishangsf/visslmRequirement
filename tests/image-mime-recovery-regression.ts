import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { AppDatabase } from '../src/main/database'
import { exportVisslmPack, importVisslmPack } from '../src/main/transfer-pack'
import { SyncService, VisslmClient } from '../src/main/visslm'

const root = mkdtempSync(join(tmpdir(), 'visslm-image-mime-recovery-'))
const database = new AppDatabase(join(root, 'source.db'), join(root, 'assets'))
const target = new AppDatabase(join(root, 'target.db'), join(root, 'target-assets'))
const baseUrl = 'https://alm.example.test'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=', 'base64')
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])
const truncatedPng = png.subarray(0, png.length - 12)
const source = 'FileCenterImg/Index/actually-png.jpg'
const record = {
  _valm_Uid: 'mime-recovery',
  _valm_NodeType: 'Task',
  _valm_ItemID: 'TASK-MIME-RECOVERY',
  _valm_Name: '错误 JPEG 响应头下的 PNG',
  _valm_ProjectId: 'project-1',
  _valm_LastModifyTime: 'unchanged',
  _valm_Description: `<p>保留正文<img src="${source}"></p>`,
  CustomImage: `data:image/jpeg;base64,${png.toString('base64')}`
}
const calls = new Map<string, number>()
let serveCompleteImage = false
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
  assert.equal(url.origin, baseUrl, '回归测试不得访问真实平台')
  const path = url.pathname
  calls.set(path, (calls.get(path) ?? 0) + 1)
  if (path === '/rest/items') return Response.json({ ErrorCode: 0, propList: [record] })
  if (path === '/rest/application/Version' || path === '/rest/application/DBVersion') {
    return Response.json({ ErrorCode: 0, Version: 'test', DBVersion: 'test' })
  }
  if (path === '/Admin/Virtualization_ReadMember') return Response.json({ ErrorCode: 0, propList: [] })
  const fixtures: Record<string, { bytes: Buffer; mime: string; status?: number }> = {
    [`/rest/file/DownloadFile/${source}`]: { bytes: serveCompleteImage ? png : truncatedPng, mime: 'image/jpeg' },
    '/mislabeled.jpg': { bytes: png, mime: 'image/jpeg' },
    '/generic.jpg': { bytes: png, mime: 'application/octet-stream' },
    '/reverse.png': { bytes: jpeg, mime: 'image/png' },
    '/fake.jpg': { bytes: Buffer.from('<html>login page</html>'), mime: 'image/jpeg' },
    '/truncated.jpg': { bytes: truncatedPng, mime: 'image/jpeg' },
    '/forbidden.jpg': { bytes: png, mime: 'image/jpeg', status: 403 }
  }
  const fixture = fixtures[path]
  assert.ok(fixture, `未预期的测试请求：${path}`)
  return new Response(fixture.bytes, { status: fixture.status ?? 200, headers: { 'content-type': fixture.mime } })
}) as typeof fetch

try {
  const client = new VisslmClient({ baseUrl, username: 'test', token: 'test-secret' })
  // HTTP labels and filename extensions must not override validated bytes.
  const mislabeled = await client.download(`${baseUrl}/mislabeled.jpg`)
  assert.equal(mislabeled.mimeType, 'image/png')
  assert.deepEqual(mislabeled.bytes, png)
  assert.equal(calls.get('/mislabeled.jpg'), 1)
  const generic = await client.download(`${baseUrl}/generic.jpg`)
  assert.equal(generic.mimeType, 'image/png')
  assert.deepEqual(generic.bytes, png)
  const reverse = await client.download(`${baseUrl}/reverse.png`)
  assert.equal(reverse.mimeType, 'image/jpeg')
  assert.deepEqual(reverse.bytes, jpeg)
  for (const path of ['/fake.jpg', '/truncated.jpg', '/forbidden.jpg']) {
    await assert.rejects(client.download(`${baseUrl}${path}`), (error: Error) => {
      assert.doesNotMatch(error.message, /test-secret|login page/)
      return true
    })
    assert.equal(calls.get(path), path === '/forbidden.jpg' ? 1 : 3)
  }

  const service = new SyncService(database, () => client, () => {})
  const config = { selectedTypes: ['Task'], rules: [{ nodeType: 'Task', filters: [] }] }
  const first = await service.run(config)
  assert.equal(first.ok, true)
  const initial = database.getRecord(record._valm_Uid)!
  assert.equal(initial.images.filter((image) => image.state === 'unresolved').length, 1)
  assert.equal(initial.images.filter((image) => image.state === 'ready').length, 1, '内嵌图片也必须使用真实 MIME')

  serveCompleteImage = true
  const recovered = await service.run(config)
  assert.equal(recovered.ok, true)
  const detail = database.getRecord(record._valm_Uid)!
  assert.equal(detail.images.length, 1, '恢复时清除旧失败标记，并按内容去重')
  assert.equal(detail.images[0].state, 'ready')
  assert.equal(detail.images[0].mimeType, 'image/png')
  assert.equal(detail.lastModifyTime, 'unchanged')
  assert.deepEqual(database.readAssetBytes(detail.images[0].sha256), png)
  assert.match(detail.description, /保留正文.*visslm-asset:\/\//)
  assert.equal(database.listRecordImageReferences(record._valm_Uid).length, 2)
  assert.equal(calls.get(`/rest/file/DownloadFile/${source}`), 4, '合法 PNG 不应因错误 JPEG 头重复下载')

  const path = join(root, 'recovered.visslmpack')
  const exported = await exportVisslmPack(database, path)
  assert.equal(exported.ok, true)
  assert.equal(exported.assetCount, 1)
  assert.doesNotMatch(exported.message, /跳过|无法恢复/)
  const archive = unzipSync(readFileSync(path))
  const exportedRow = JSON.parse(Buffer.from(archive['records.jsonl']).toString('utf8'))
  assert.equal(exportedRow.images[0].mimeType, 'image/png')
  const imported = await importVisslmPack(target, path)
  assert.equal(imported.ok, true)
  assert.deepEqual(target.readAssetBytes(detail.images[0].sha256), png)
  assert.equal(target.getRecord(record._valm_Uid)?.images[0].mimeType, 'image/png')
  console.log('Image MIME recovery: download, invalid payload rejection, retry recovery and pack round-trip passed.')
} finally {
  globalThis.fetch = originalFetch
  database.close()
  target.close()
}
