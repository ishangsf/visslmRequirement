import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')
const installerDirectory = join(projectRoot, 'buildResources', 'installer')
const executablePath = join(installerDirectory, 'vc_redist.x64.exe')
const metadataPath = join(installerDirectory, 'vc_redist.x64.exe.sha256.json')
const temporaryPath = `${executablePath}.download`

const officialVersion = '14.44.35211'
const expectedFileVersion = '14.44.35211.0'
const officialUrl = `https://aka.ms/vs/17/release/${officialVersion}/VC_redist.x64.exe`
const allowedFinalHosts = new Set([
  'aka.ms',
  'download.visualstudio.microsoft.com',
  'visualstudio.microsoft.com'
])
const maximumDownloadBytes = 80 * 1024 * 1024

const hasFlag = (name) => process.argv.slice(2).includes(name)
const shouldDownloadIfMissing = hasFlag('--download-if-missing')
const checkOnly = hasFlag('--check')

const print = (message) => process.stdout.write(`${message}\n`)

const sha256File = async (path) => {
  const hash = createHash('sha256')
  const content = await readFile(path)
  hash.update(content)
  return hash.digest('hex')
}

const getAuthenticodeSignature = (path) => {
  if (process.platform !== 'win32') {
    return {
      status: 'NotChecked',
      subject: null,
      thumbprint: null,
      reason: 'Authenticode 只能在 Windows 构建机上验证。'
    }
  }

  const escapedPath = path.replaceAll("'", "''")
  const command = [
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop;',
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}';`,
    '[PSCustomObject]@{',
    '  Status = [string]$signature.Status;',
    '  Subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null };',
    '  Thumbprint = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Thumbprint } else { $null }',
    '} | ConvertTo-Json -Compress'
  ].join(' ')

  let lastError = null
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    try {
      const output = execFileSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim()
      const parsed = JSON.parse(output)
      return {
        status: parsed.Status ?? 'Unknown',
        subject: parsed.Subject ?? null,
        thumbprint: parsed.Thumbprint ?? null,
        reason: null
      }
    } catch (error) {
      lastError = error
    }
  }
  return {
    status: 'VerificationError',
    subject: null,
    thumbprint: null,
    reason: lastError instanceof Error ? lastError.message : String(lastError)
  }
}

const getFileVersion = (path) => {
  if (process.platform !== 'win32') return null
  const escapedPath = path.replaceAll("'", "''")
  const command = [
    `$version = (Get-Item -LiteralPath '${escapedPath}').VersionInfo.FileVersion;`,
    '[PSCustomObject]@{ FileVersion = [string]$version } | ConvertTo-Json -Compress'
  ].join(' ')
  let lastError = null
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    try {
      const output = execFileSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim()
      const parsed = JSON.parse(output)
      return parsed.FileVersion ?? null
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const verifyAuthenticode = (signature) => {
  if (process.platform !== 'win32') return true
  if (signature.status !== 'Valid') return false
  return typeof signature.subject === 'string' && /Microsoft Corporation/i.test(signature.subject)
}

const readMetadata = async () => {
  try {
    const text = await readFile(metadataPath, 'utf8')
    const metadata = JSON.parse(text)
    if (!metadata || metadata.schemaVersion !== 1 || metadata.file !== 'vc_redist.x64.exe') {
      throw new Error('元数据版本或文件名不正确。')
    }
    return metadata
  } catch {
    return null
  }
}

const validateLocalResource = async () => {
  try {
    await access(executablePath)
    const fileStats = await stat(executablePath)
    if (!fileStats.isFile() || fileStats.size < 1024 * 1024 || fileStats.size > maximumDownloadBytes) {
      return { ok: false, reason: `文件大小异常（${fileStats.size} bytes）。` }
    }

    const metadata = await readMetadata()
    if (!metadata || metadata.source !== officialUrl || metadata.fileVersion !== expectedFileVersion || typeof metadata.sha256 !== 'string') {
      return { ok: false, reason: '缺少有效的官方来源/ SHA-256 元数据。' }
    }

    const sha256 = await sha256File(executablePath)
    if (sha256.toLowerCase() !== metadata.sha256.toLowerCase()) {
      return { ok: false, reason: `SHA-256 不匹配（实际 ${sha256}）。` }
    }

    const fileVersion = getFileVersion(executablePath)
    if (process.platform === 'win32' && fileVersion !== expectedFileVersion) {
      return { ok: false, reason: `文件版本不匹配（实际 ${fileVersion ?? '未知'}，要求 ${expectedFileVersion}）。` }
    }

    const signature = getAuthenticodeSignature(executablePath)
    if (!verifyAuthenticode(signature)) {
      return {
        ok: false,
        reason: `Authenticode 验证失败（${signature.status}${signature.reason ? `：${signature.reason}` : ''}）。`,
        metadata,
        signature
      }
    }

    return { ok: true, metadata, signature, sha256, size: fileStats.size }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

const downloadOfficialResource = (url, redirectsRemaining = 5) => new Promise((resolvePromise, reject) => {
  const parsedUrl = new URL(url)
  if (parsedUrl.protocol !== 'https:') {
    reject(new Error(`拒绝非 HTTPS 下载地址：${url}`))
    return
  }
  if (!allowedFinalHosts.has(parsedUrl.hostname)) {
    reject(new Error(`官方下载重定向到未允许的主机：${parsedUrl.hostname}`))
    return
  }

  const request = https.get(parsedUrl, (response) => {
    const statusCode = response.statusCode ?? 0
    if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
      response.resume()
      if (redirectsRemaining <= 0) {
        reject(new Error('官方下载地址重定向次数过多。'))
        return
      }
      const redirectedUrl = new URL(response.headers.location, parsedUrl).toString()
      downloadOfficialResource(redirectedUrl, redirectsRemaining - 1).then(resolvePromise, reject)
      return
    }
    if (statusCode !== 200) {
      response.resume()
      reject(new Error(`官方下载地址返回 HTTP ${statusCode}。`))
      return
    }

    const contentLength = Number.parseInt(response.headers['content-length'] ?? '', 10)
    if (Number.isFinite(contentLength) && (contentLength < 1024 * 1024 || contentLength > maximumDownloadBytes)) {
      response.resume()
      reject(new Error(`官方安装包大小异常（${contentLength} bytes）。`))
      return
    }

    const output = createWriteStream(temporaryPath, { flags: 'w' })
    let byteCount = 0
    response.on('data', (chunk) => {
      byteCount += chunk.length
      if (byteCount > maximumDownloadBytes) {
        request.destroy(new Error('下载文件超过大小上限。'))
      }
    })
    response.on('error', (error) => output.destroy(error))
    output.on('error', reject)
    output.on('finish', async () => {
      try {
        await rename(temporaryPath, executablePath)
        resolvePromise({ size: byteCount, finalUrl: parsedUrl.toString() })
      } catch (error) {
        reject(error)
      }
    })
    response.pipe(output)
  })
  request.on('error', reject)
})

const main = async () => {
  await mkdir(installerDirectory, { recursive: true })
  const local = await validateLocalResource()
  if (local.ok) {
    print(`VC++ 运行库资源已就绪：${local.size} bytes，SHA-256 ${local.sha256}`)
    return
  }

  if (checkOnly || !shouldDownloadIfMissing) {
    throw new Error(`VC++ 运行库资源校验失败：${local.reason}。请执行 npm run prepare:runtime-dependencies（网络可用时）准备官方安装包。`)
  }

  print(`本地 VC++ 运行库资源不可用（${local.reason}），正在从微软官方地址下载...`)
  await rm(temporaryPath, { force: true })
  const download = await downloadOfficialResource(officialUrl)
  const signature = getAuthenticodeSignature(executablePath)
  if (!verifyAuthenticode(signature)) {
    await rm(executablePath, { force: true })
    throw new Error(`下载的 VC++ 运行库未通过 Microsoft Authenticode 验证（${signature.status}${signature.reason ? `：${signature.reason}` : ''}）。`)
  }
  const fileVersion = getFileVersion(executablePath)
  if (process.platform === 'win32' && fileVersion !== expectedFileVersion) {
    await rm(executablePath, { force: true })
    throw new Error(`下载的 VC++ 运行库文件版本为 ${fileVersion ?? '未知'}，要求 ${expectedFileVersion}。`)
  }
  const sha256 = await sha256File(executablePath)
  const fileStats = await stat(executablePath)
  const metadata = {
    schemaVersion: 1,
    file: 'vc_redist.x64.exe',
    product: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
    fileVersion: fileVersion ?? expectedFileVersion,
    source: officialUrl,
    resolvedUrl: download.finalUrl,
    size: fileStats.size,
    sha256,
    authenticode: {
      status: signature.status,
      subject: signature.subject,
      thumbprint: signature.thumbprint
    }
  }
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  const verified = await validateLocalResource()
  if (!verified.ok) {
    throw new Error(`下载后校验失败：${verified.reason}`)
  }
  print(`已准备官方 VC++ 运行库：${fileStats.size} bytes，SHA-256 ${sha256}`)
}

main().catch((error) => {
  process.stderr.write(`runtime dependency preparation failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
