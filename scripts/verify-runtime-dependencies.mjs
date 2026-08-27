import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const installerDirectory = join(projectRoot, 'buildResources', 'installer')
const executablePath = join(installerDirectory, 'vc_redist.x64.exe')
const metadataPath = join(installerDirectory, 'vc_redist.x64.exe.sha256.json')
const onnxRuntimeRoot = join(projectRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64')
const requiredOnnxFiles = ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll', 'dxil.dll']
const officialVersion = '14.44.35211'
const expectedFileVersion = '14.44.35211.0'
const officialUrl = `https://aka.ms/vs/17/release/${officialVersion}/VC_redist.x64.exe`
const allowedHosts = new Set(['aka.ms', 'download.visualstudio.microsoft.com', 'visualstudio.microsoft.com'])

const failures = []
const warnings = []

const check = (condition, failure, warning = false) => {
  if (condition) return
  if (warning) warnings.push(failure)
  else failures.push(failure)
}

const isOfficialResolvedUrl = (value) => {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && allowedHosts.has(parsed.hostname)
  } catch {
    return false
  }
}

const sha256File = async (path) => {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

const getAuthenticodeSignature = (path) => {
  if (process.platform !== 'win32') {
    return { status: 'NotChecked', subject: null, reason: '非 Windows 主机，跳过 Authenticode 实际调用。' }
  }
  const escapedPath = path.replaceAll("'", "''")
  const command = [
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop;',
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}';`,
    '[PSCustomObject]@{',
    '  Status = [string]$signature.Status;',
    '  Subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }',
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
      return { status: parsed.Status ?? 'Unknown', subject: parsed.Subject ?? null, reason: null }
    } catch (error) {
      lastError = error
    }
  }
  return { status: 'VerificationError', subject: null, reason: lastError instanceof Error ? lastError.message : String(lastError) }
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
  return null
}

const readRegistry = () => {
  if (process.platform !== 'win32') return { status: 'NotChecked', version: null }
  try {
    const output = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/reg:64'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const installed = /^\s*Installed\s+REG_\w+\s+0x1\s*$/im.test(output)
    const registryNumber = (name) => {
      const value = output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(0x[0-9a-f]+|\\d+)\\s*$`, 'im'))?.[1]
      if (!value) return null
      const parsed = value.toLowerCase().startsWith('0x')
        ? Number.parseInt(value.slice(2), 16)
        : Number.parseInt(value, 10)
      return Number.isFinite(parsed) ? parsed : null
    }
    const version = [
      registryNumber('Major'),
      registryNumber('Minor'),
      registryNumber('Bld'),
      registryNumber('Rbld') ?? 0
    ]
    const comparable = version.slice(0, 3).every((part) => part !== null)
    const minimum = [14, 44, 35211, 0]
    let comparison = 0
    if (comparable) {
      for (let index = 0; index < minimum.length; index += 1) {
        if (version[index] === minimum[index]) continue
        comparison = Number(version[index]) > minimum[index] ? 1 : -1
        break
      }
    }
    const sufficient = comparable && comparison >= 0
    return {
      status: installed && sufficient ? 'Ready' : 'MissingOrOld',
      version: comparable ? version.join('.') : null
    }
  } catch (error) {
    return { status: 'ReadError', version: error instanceof Error ? error.message : String(error) }
  }
}

const verify = async () => {
  let metadata = null
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  } catch (error) {
    failures.push(`缺少或无法解析 VC++ 运行库元数据：${error instanceof Error ? error.message : String(error)}`)
  }

  let fileStats = null
  try {
    await access(executablePath)
    fileStats = await stat(executablePath)
    check(fileStats.isFile() && fileStats.size > 1024 * 1024, '内置 vc_redist.x64.exe 文件不存在或大小异常。')
  } catch {
    failures.push(`缺少内置 VC++ 运行库：${executablePath}`)
  }

  if (metadata) {
    check(metadata.schemaVersion === 1 && metadata.file === 'vc_redist.x64.exe', 'VC++ 运行库元数据 schema/file 不正确。')
    check(metadata.product === 'Microsoft Visual C++ 2015-2022 Redistributable (x64)', 'VC++ 运行库产品标识不正确。')
    check(metadata.fileVersion === expectedFileVersion, `VC++ 运行库文件版本不是固定的 ${expectedFileVersion}。`)
    check(metadata.source === officialUrl, `VC++ 运行库来源不是微软官方永久地址：${metadata.source ?? '未提供'}`)
    check(typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(metadata.sha256), 'VC++ 运行库元数据缺少有效 SHA-256。')
    check(isOfficialResolvedUrl(metadata.resolvedUrl), 'VC++ 运行库最终下载主机不在微软官方允许列表。')
    check(metadata.authenticode?.status === 'Valid', '元数据未记录有效的 Microsoft Authenticode 签名。')
    check(typeof metadata.authenticode?.subject === 'string' && /Microsoft Corporation/i.test(metadata.authenticode.subject), '元数据签名者不是 Microsoft Corporation。')
  }

  if (fileStats?.isFile() && metadata?.sha256) {
    const sha256 = await sha256File(executablePath)
    check(sha256.toLowerCase() === metadata.sha256.toLowerCase(), `VC++ 运行库 SHA-256 校验失败：实际 ${sha256}。`)
    check(!metadata.size || Number(metadata.size) === fileStats.size, 'VC++ 运行库文件大小与元数据不一致。')
    const fileVersion = getFileVersion(executablePath)
    if (process.platform === 'win32') {
      check(fileVersion === expectedFileVersion, `VC++ 运行库实际 FileVersion 为 ${fileVersion ?? '未知'}，要求 ${expectedFileVersion}。`)
    }
    const signature = getAuthenticodeSignature(executablePath)
    if (process.platform === 'win32') {
      check(signature.status === 'Valid', `VC++ 运行库 Authenticode 校验失败：${signature.status}${signature.reason ? `：${signature.reason}` : ''}。`)
      check(typeof signature.subject === 'string' && /Microsoft Corporation/i.test(signature.subject), `VC++ 运行库签名者异常：${signature.subject ?? '未知'}。`)
    } else {
      warnings.push(`跳过本机 Authenticode 校验：${signature.reason}`)
    }
  }

  for (const fileName of requiredOnnxFiles) {
    try {
      const fileStats = await stat(join(onnxRuntimeRoot, fileName))
      check(fileStats.isFile() && fileStats.size > 0, `ONNX Runtime 文件为空：${fileName}`)
    } catch {
      failures.push(`缺少 ONNX Runtime 原生文件：${join(onnxRuntimeRoot, fileName)}`)
    }
  }

  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  const asarUnpack = packageJson.build?.asarUnpack ?? []
  check(asarUnpack.some((entry) => String(entry).includes('onnxruntime-node')), 'electron-builder 未配置解包 onnxruntime-node 原生文件。')
  const extraResources = packageJson.build?.extraResources ?? []
  check(extraResources.some((entry) => entry.from === 'buildResources/installer/vc_redist.x64.exe' && entry.to === 'installer/vc_redist.x64.exe'), 'electron-builder 未配置内置 VC++ 安装包 extraResources。')
  check(packageJson.build?.nsis?.include === 'build/installer.nsh', 'electron-builder 未配置 VC++ NSIS 安装器检测脚本。')

  const hostVcRuntime = readRegistry()
  const output = {
    ok: failures.length === 0,
    failures,
    warnings,
    host: {
      platform: process.platform,
      architecture: process.arch,
      vcRuntime: hostVcRuntime
    },
    checked: {
      vcRedist: executablePath,
      onnxRuntime: onnxRuntimeRoot,
      mode: 'read-only'
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  if (failures.length > 0) process.exitCode = 1
}

verify().catch((error) => {
  process.stderr.write(`runtime dependency verification failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
