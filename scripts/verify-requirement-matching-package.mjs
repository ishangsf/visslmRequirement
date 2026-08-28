import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const installer = resolve(argument('--installer') ?? 'release/VISSLM-Agent-Setup-1.5.0.exe')
const unpacked = resolve(argument('--unpacked') ?? 'release/win-unpacked')
const output = resolve(argument('--output') ?? 'release/requirement-matching-v1.5-package-report.json')
const smokeTimeoutMs = Math.max(3000, Number(argument('--smoke-timeout-ms') ?? 6000))

const sha256 = async (path) => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolveHash(hash.digest('hex')))
})

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
if (packageJson.version !== '1.5.0') throw new Error(`Unexpected source version: ${packageJson.version}`)
if (basename(installer) !== 'VISSLM-Agent-Setup-1.5.0.exe') throw new Error(`Unexpected installer name: ${basename(installer)}`)

const installerStat = await stat(installer)
const resources = join(unpacked, 'resources')
const manifestPath = join(resources, 'models', 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.id !== 'Xenova/bge-small-zh-v1.5') throw new Error(`Unexpected embedding model: ${manifest.id}`)
if (manifest.revision !== '75c43b069aac4d136ba6bc1122f995fedcfd2781') throw new Error(`Unexpected embedding revision: ${manifest.revision}`)
if (manifest.crossEncoder?.id !== 'Xenova/bge-reranker-base') throw new Error(`Unexpected reranker model: ${manifest.crossEncoder?.id}`)
if (manifest.crossEncoder?.revision !== '280bcc27a84e0b898c251e06fddb25171bd9b101') throw new Error(`Unexpected reranker revision: ${manifest.crossEncoder?.revision}`)

const verifiedFiles = []
for (const item of [...manifest.files, ...manifest.crossEncoder.files]) {
  const path = join(resources, 'models', ...String(item.file).split('/'))
  const fileStat = await stat(path)
  if (fileStat.size !== item.byteSize) throw new Error(`Model byte size mismatch: ${item.file}`)
  const actualHash = await sha256(path)
  if (actualHash !== item.sha256) throw new Error(`Model SHA-256 mismatch: ${item.file}`)
  verifiedFiles.push({ file: item.file, byteSize: fileStat.size, sha256: actualHash })
}

const executable = join(unpacked, 'VISSLM Agent.exe')
await stat(executable)
const isolatedUserData = await mkdtemp(join(tmpdir(), 'visslm-package-smoke-'))
const started = Date.now()
const child = spawn(executable, [`--user-data-dir=${isolatedUserData}`, '--disable-gpu'], {
  cwd: unpacked,
  windowsHide: true,
  stdio: 'ignore'
})

let exited = false
let exitCode = null
child.once('exit', (code) => {
  exited = true
  exitCode = code
})
await new Promise((resolveWait) => setTimeout(resolveWait, smokeTimeoutMs))
if (exited) throw new Error(`Packaged application exited before smoke window completed (code ${exitCode})`)
child.kill()
await new Promise((resolveWait) => {
  const timeout = setTimeout(resolveWait, 3000)
  child.once('exit', () => { clearTimeout(timeout); resolveWait() })
})
await rm(isolatedUserData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

const report = {
  ok: true,
  version: packageJson.version,
  installer: {
    path: installer,
    byteSize: installerStat.size,
    sha256: await sha256(installer)
  },
  unpacked,
  models: {
    embedding: { id: manifest.id, revision: manifest.revision },
    crossEncoder: { id: manifest.crossEncoder.id, revision: manifest.crossEncoder.revision },
    verifiedFiles
  },
  startup: { ok: true, smokeTimeoutMs, observedMs: Date.now() - started }
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  ok: true,
  output,
  installer: report.installer,
  modelFileCount: verifiedFiles.length,
  startup: report.startup
}, null, 2))
