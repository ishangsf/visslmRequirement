import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

import { isUnsupportedWindowsVersion } from './platform-compat'

/**
 * The aka.ms URL is Microsoft's documented, stable redirect for the current
 * Visual C++ 2015-2022 x64 redistributable.  The installer is bundled with
 * the application; this URL is used only by the build-time preparation script.
 */
export const VC_REDIST_VERSION = '14.44.35211'
export const VC_REDIST_FILE_VERSION = '14.44.35211.0'
export const VC_REDIST_OFFICIAL_URL = `https://aka.ms/vs/17/release/${VC_REDIST_VERSION}/VC_redist.x64.exe`
export const VC_REDIST_FILE_NAME = 'vc_redist.x64.exe'
export const VC_RUNTIME_REGISTRY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
export const VC_RUNTIME_MINIMUM_VERSION = {
  major: 14,
  minor: 44,
  build: 35211,
  revision: 0
} as const
export const VC_RUNTIME_MINIMUM_VERSION_STRING = '14.44.35211.0'

const ONNX_RUNTIME_PACKAGE_PATH = join('node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64')
const ONNX_RUNTIME_REQUIRED_FILES = ['onnxruntime_binding.node', 'onnxruntime.dll'] as const
const ONNX_RUNTIME_OPTIONAL_FILES = ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll'] as const

type RuntimeIssueCode =
  | 'windows-version-unsupported'
  | 'windows-architecture-unsupported'
  | 'vc-runtime-missing'
  | 'vc-runtime-registry-unavailable'
  | 'onnx-runtime-root-missing'
  | 'onnx-binding-missing'
  | 'onnx-runtime-dll-missing'
  | 'onnx-companion-dll-missing'
  | 'onnx-native-load-failed'

export interface RuntimeIssue {
  code: RuntimeIssueCode
  message: string
  recovery: string
  details?: string
}

export interface VcRuntimeInfo {
  applicable: boolean
  installed: boolean
  version: string | null
  registryKey: string
  registryReadError: string | null
}

export interface OnnxRuntimeInfo {
  applicable: boolean
  root: string | null
  files: Record<string, boolean>
  bindingLoadable: boolean | null
  bindingLoadError: string | null
}

export interface RuntimeDependencyReport {
  platform: NodeJS.Platform
  architecture: string
  windowsVersion: string | null
  windowsSupported: boolean
  vcRuntime: VcRuntimeInfo
  onnxRuntime: OnnxRuntimeInfo
  issues: RuntimeIssue[]
  ok: boolean
}

export interface RuntimeDependencyOptions {
  platform?: NodeJS.Platform
  architecture?: string
  windowsVersion?: string
  /** Override the registry query in tests or in a host-specific integration. */
  readVcRuntimeRegistry?: () => string
  /** Override file existence checks in tests. */
  fileExists?: (path: string) => boolean
  /** Override native loading in tests. The default is a non-initializing require. */
  loadNativeBinding?: (path: string) => unknown
  /** Explicit unpacked onnxruntime-node binary directory. */
  onnxRuntimeRoot?: string
  /** Candidate roots used when onnxRuntimeRoot is not supplied. */
  onnxRuntimeRoots?: string[]
}

type RegistryNumber = number | null

const defaultFileExists = (path: string): boolean => existsSync(path)

const defaultNativeBindingLoader = (path: string): unknown => {
  const require = createRequire(import.meta.url)
  return require(path)
}

const getElectronSystemVersion = (): string => {
  const electronProcess = process as NodeJS.Process & { getSystemVersion?: () => string }
  try {
    return typeof electronProcess.getSystemVersion === 'function'
      ? electronProcess.getSystemVersion()
      : ''
  } catch {
    return ''
  }
}

const parseRegistryNumber = (value: string | undefined): RegistryNumber => {
  if (!value) return null
  const trimmed = value.trim()
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    const parsed = Number.parseInt(trimmed.slice(2), 16)
    return Number.isFinite(parsed) ? parsed : null
  }
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const readRegistryValue = (output: string, valueName: string): RegistryNumber => {
  const escapedName = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`^\\s*${escapedName}\\s+REG_\\w+\\s+(\\S+)\\s*$`, 'im'))
  return parseRegistryNumber(match?.[1])
}

const defaultReadVcRuntimeRegistry = (): string => {
  let lastError: unknown = null
  for (const registryView of ['/reg:64', '/reg:32']) {
    try {
      return execFileSync(
        'reg.exe',
        ['query', VC_RUNTIME_REGISTRY_KEY, registryView],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const versionFromRegistry = (output: string): string | null => {
  const major = readRegistryValue(output, 'Major')
  const minor = readRegistryValue(output, 'Minor')
  const build = readRegistryValue(output, 'Bld')
  const revision = readRegistryValue(output, 'Rbld')
  if (major === null || minor === null || build === null) return null
  return `${major}.${minor}.${build}${revision === null ? '' : `.${revision}`}`
}

export const parseVcRuntimeRegistry = (output: string): VcRuntimeInfo => {
  const installed = readRegistryValue(output, 'Installed') === 1
  const major = readRegistryValue(output, 'Major')
  const minor = readRegistryValue(output, 'Minor')
  const build = readRegistryValue(output, 'Bld')
  const revision = readRegistryValue(output, 'Rbld') ?? 0
  const versionIsSufficient = (
    major !== null && minor !== null && build !== null &&
    (major > VC_RUNTIME_MINIMUM_VERSION.major ||
      (major === VC_RUNTIME_MINIMUM_VERSION.major && (
        minor > VC_RUNTIME_MINIMUM_VERSION.minor ||
        (minor === VC_RUNTIME_MINIMUM_VERSION.minor && (
          build > VC_RUNTIME_MINIMUM_VERSION.build ||
          (build === VC_RUNTIME_MINIMUM_VERSION.build && revision >= VC_RUNTIME_MINIMUM_VERSION.revision)
        ))
      )))
  )
  return {
    applicable: true,
    installed: installed && versionIsSufficient,
    version: versionFromRegistry(output),
    registryKey: VC_RUNTIME_REGISTRY_KEY,
    registryReadError: null
  }
}

export const inspectVcRuntime = (
  platform: NodeJS.Platform = process.platform,
  readRegistry: () => string = defaultReadVcRuntimeRegistry
): VcRuntimeInfo => {
  if (platform !== 'win32') {
    return {
      applicable: false,
      installed: true,
      version: null,
      registryKey: VC_RUNTIME_REGISTRY_KEY,
      registryReadError: null
    }
  }

  try {
    return parseVcRuntimeRegistry(readRegistry())
  } catch (error) {
    return {
      applicable: true,
      installed: false,
      version: null,
      registryKey: VC_RUNTIME_REGISTRY_KEY,
      registryReadError: error instanceof Error ? error.message : String(error)
    }
  }
}

const defaultOnnxRuntimeRoots = (): string[] => {
  const roots: string[] = []
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    roots.push(join(resourcesPath, 'app.asar.unpacked', ONNX_RUNTIME_PACKAGE_PATH))
    roots.push(join(resourcesPath, ONNX_RUNTIME_PACKAGE_PATH))
  }

  roots.push(join(process.cwd(), ONNX_RUNTIME_PACKAGE_PATH))

  // electron-vite bundles the main process under out/main.  This candidate is
  // useful in development and remains harmless when the app is packaged.
  try {
    const moduleDirectory = dirname(new URL(import.meta.url).pathname)
    roots.push(resolve(moduleDirectory, '..', '..', ONNX_RUNTIME_PACKAGE_PATH))
  } catch {
    // A host can provide onnxRuntimeRoot explicitly; no candidate is fatal.
  }

  return [...new Set(roots.map((candidate) => normalize(candidate)))]
}

const resolveOnnxRuntimeRoot = (
  options: RuntimeDependencyOptions,
  fileExists: (path: string) => boolean
): string | null => {
  const candidates = options.onnxRuntimeRoot
    ? [options.onnxRuntimeRoot]
    : options.onnxRuntimeRoots ?? defaultOnnxRuntimeRoots()

  for (const candidate of candidates) {
    if (ONNX_RUNTIME_REQUIRED_FILES.every((name) => fileExists(join(candidate, name)))) {
      return candidate
    }
  }

  // Return the first explicit/candidate root for useful per-file diagnostics.
  return candidates[0] ?? null
}

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

const classifyNativeLoadRecovery = (message: string): string => {
  const normalized = message.toLowerCase()
  if (normalized.includes('initialization routine failed') || normalized.includes('vcruntime') || normalized.includes('msvcp')) {
    return '请重新运行安装包以安装/修复 Microsoft Visual C++ 2015-2022 x64 运行库，然后重启 VISSLM Agent。'
  }
  if (normalized.includes('module could not be found') || normalized.includes('specified module')) {
    return '请确认安装目录中的 onnxruntime.dll 与 onnxruntime_binding.node 未被安全软件隔离；必要时修复或重新安装程序。'
  }
  if (normalized.includes('not a valid win32') || normalized.includes('wrong architecture')) {
    return '当前程序与原生推理组件的 CPU 架构不一致，请安装 x64 版本的 VISSLM Agent。'
  }
  return '请检查安装包完整性、Windows 安全软件隔离记录和 Visual C++ 运行库，然后重新安装程序。'
}

const createIssue = (
  code: RuntimeIssueCode,
  message: string,
  recovery: string,
  details?: string
): RuntimeIssue => ({ code, message, recovery, ...(details ? { details } : {}) })

export const resolveDefaultOnnxRuntimeRoot = (options: RuntimeDependencyOptions = {}): string | null => (
  resolveOnnxRuntimeRoot(options, options.fileExists ?? defaultFileExists)
)

export const diagnoseRuntimeDependencies = (
  options: RuntimeDependencyOptions = {}
): RuntimeDependencyReport => {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const windowsVersion = options.windowsVersion ?? (platform === 'win32' ? getElectronSystemVersion() : null)
  const fileExists = options.fileExists ?? defaultFileExists
  const loadNativeBinding = options.loadNativeBinding ?? defaultNativeBindingLoader
  const issues: RuntimeIssue[] = []
  const windowsSupported = platform !== 'win32' || !isUnsupportedWindowsVersion(windowsVersion ?? '')

  if (platform === 'win32' && !windowsSupported) {
    issues.push(createIssue(
      'windows-version-unsupported',
      `当前 Windows 版本 ${windowsVersion || '未知'} 不受 Electron 43 支持。`,
      '请升级到 Windows 10 或更高版本后再运行 VISSLM Agent。'
    ))
  }

  if (platform === 'win32' && architecture !== 'x64') {
    issues.push(createIssue(
      'windows-architecture-unsupported',
      `当前程序架构为 ${architecture}，安装包仅支持 Windows x64。`,
      '请下载并安装 VISSLM Agent x64 安装包。'
    ))
  }

  const vcRuntime = inspectVcRuntime(platform, options.readVcRuntimeRegistry ?? defaultReadVcRuntimeRegistry)
  if (platform === 'win32' && !vcRuntime.installed) {
    issues.push(createIssue(
      vcRuntime.registryReadError ? 'vc-runtime-registry-unavailable' : 'vc-runtime-missing',
      vcRuntime.registryReadError
        ? '无法读取 Microsoft Visual C++ 运行库注册信息。'
        : `未检测到满足最低版本 ${VC_RUNTIME_MINIMUM_VERSION_STRING} 的 Microsoft Visual C++ 2015-2022 x64 运行库${vcRuntime.version ? `（当前 ${vcRuntime.version}）` : ''}。`,
      '请重新运行安装包；安装器会使用内置的 vc_redist.x64.exe 离线安装运行库。',
      vcRuntime.registryReadError ?? undefined
    ))
  }

  const onnxApplicable = platform === 'win32' && architecture === 'x64'
  const onnxRoot = onnxApplicable ? resolveOnnxRuntimeRoot(options, fileExists) : null
  const files: Record<string, boolean> = {}
  let bindingLoadable: boolean | null = null
  let bindingLoadError: string | null = null

  if (onnxApplicable && onnxRoot) {
    for (const name of [...ONNX_RUNTIME_REQUIRED_FILES, ...ONNX_RUNTIME_OPTIONAL_FILES]) {
      files[name] = fileExists(join(onnxRoot, name))
    }

    if (!files['onnxruntime_binding.node']) {
      issues.push(createIssue(
        'onnx-binding-missing',
        '未找到 ONNX Runtime 原生绑定文件 onnxruntime_binding.node。',
        '请修复或重新安装程序，确保安装包未被安全软件隔离。',
        onnxRoot
      ))
    }
    if (!files['onnxruntime.dll']) {
      issues.push(createIssue(
        'onnx-runtime-dll-missing',
        '未找到 ONNX Runtime 伴随库 onnxruntime.dll。',
        '请修复或重新安装程序，确保安装目录中的原生推理组件完整。',
        onnxRoot
      ))
    }

    const missingOptional = ONNX_RUNTIME_OPTIONAL_FILES.filter((name) => !files[name])
    if (missingOptional.length > 0) {
      issues.push(createIssue(
        'onnx-companion-dll-missing',
        `ONNX Runtime 可选执行组件缺失：${missingOptional.join('、')}。`,
        '如需 DirectML/GPU 推理，请修复或重新安装程序；CPU 推理通常不受影响。',
        onnxRoot
      ))
    }

    if (files['onnxruntime_binding.node'] && files['onnxruntime.dll']) {
      try {
        loadNativeBinding(join(onnxRoot, 'onnxruntime_binding.node'))
        bindingLoadable = true
      } catch (error) {
        bindingLoadable = false
        bindingLoadError = asErrorMessage(error)
        issues.push(createIssue(
          'onnx-native-load-failed',
          'ONNX Runtime 原生绑定加载失败，向量模型无法初始化。',
          classifyNativeLoadRecovery(bindingLoadError),
          bindingLoadError
        ))
      }
    }
  } else if (onnxApplicable) {
    issues.push(createIssue(
      'onnx-runtime-root-missing',
      '未找到 ONNX Runtime 原生组件目录。',
      '请修复或重新安装程序，确保 onnxruntime-node 文件已随安装包解包。'
    ))
  }

  const onnxRuntime: OnnxRuntimeInfo = {
    applicable: onnxApplicable,
    root: onnxRoot,
    files,
    bindingLoadable,
    bindingLoadError
  }

  return {
    platform,
    architecture,
    windowsVersion,
    windowsSupported,
    vcRuntime,
    onnxRuntime,
    issues,
    ok: issues.length === 0
  }
}

export const formatRuntimeDependencyDiagnosis = (report: RuntimeDependencyReport): string => {
  if (report.ok) {
    return '运行环境检查通过：Windows、Visual C++ 运行库和 ONNX Runtime 原生组件均可用。'
  }

  const lines = ['运行环境检查未通过：']
  for (const issue of report.issues) {
    lines.push(`- ${issue.message}`)
    lines.push(`  恢复建议：${issue.recovery}`)
    if (issue.details) lines.push(`  诊断信息：${issue.details}`)
  }
  return lines.join('\n')
}
