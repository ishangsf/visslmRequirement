import assert from 'node:assert/strict'

import {
  diagnoseRuntimeDependencies,
  formatRuntimeDependencyDiagnosis,
  VC_RUNTIME_MINIMUM_VERSION
} from '../src/main/runtime-dependencies'

/**
 * Runtime dependency contract for the offline Windows installer/startup path.
 *
 * The production checker is intentionally called through an injectable probe
 * rather than reading this machine's registry/filesystem.  This keeps the
 * regression deterministic and makes it possible to exercise the same
 * diagnostics in CI and in an offline deployment smoke test.
 *
 * Expected production export:
 *   diagnoseRuntimeDependencies(options)
 *
 * Probe shape is deliberately data-only.  The checker may add real probes at
 * its boundary, but must keep this pure decision function independently
 * testable.
 */
type RuntimeReport = ReturnType<typeof diagnoseRuntimeDependencies>

const requiredOnnxFiles = [
  'onnxruntime.dll',
  'onnxruntime_binding.node',
  'DirectML.dll',
  'dxcompiler.dll',
  'dxil.dll'
]

const runtimeRoot = 'C:\\offline-probe\\onnxruntime'

const vcRegistry = (input: {
  installed: boolean
  major: number
  minor: number
  build: number
  revision?: number
}): string => [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
  `    Installed    REG_DWORD    ${input.installed ? '0x1' : '0x0'}`,
  `    Major        REG_DWORD    0x${input.major.toString(16)}`,
  `    Minor        REG_DWORD    0x${input.minor.toString(16)}`,
  `    Bld          REG_DWORD    0x${input.build.toString(16)}`,
  `    Rbld         REG_DWORD    0x${(input.revision ?? 0).toString(16)}`
].join('\n')

const healthyProbe = (): Parameters<typeof diagnoseRuntimeDependencies>[0] => ({
  platform: 'win32',
  windowsVersion: '10.0.19045',
  architecture: 'x64',
  readVcRuntimeRegistry: () => vcRegistry({
    installed: true,
    ...VC_RUNTIME_MINIMUM_VERSION
  }),
  onnxRuntimeRoot: runtimeRoot,
  fileExists: (path: string): boolean => requiredOnnxFiles.some((name) => path.endsWith(`\\${name}`)),
  loadNativeBinding: () => ({ loaded: true })
})

const reportText = (report: RuntimeReport): string => JSON.stringify(report, null, 2)

const assertRuntimeFailure = (
  probe: Parameters<typeof diagnoseRuntimeDependencies>[0],
  messagePattern: RegExp,
  label: string
): void => {
  const report = diagnoseRuntimeDependencies(probe)
  assert.equal(report.ok, false, `${label}: runtime failure must not be reported as healthy`)
  assert.match(
    reportText(report),
    messagePattern,
    `${label}: diagnostics must explain the failed prerequisite in Chinese`
  )
}

const testHealthyRuntime = (): void => {
  const report = diagnoseRuntimeDependencies(healthyProbe())
  assert.equal(report.ok, true, 'supported Windows x64 with all dependencies should be healthy')
}

const testUnsupportedWindows = (): void => {
  const probe = healthyProbe()
  probe.windowsVersion = '6.1.7601'
  assertRuntimeFailure(probe, /Windows|系统|不支持|最低/, 'Windows 7')
}

const testNonX64 = (): void => {
  const probe = healthyProbe()
  probe.architecture = 'ia32'
  assertRuntimeFailure(probe, /x64|架构|64 位|不支持/, '非 x64')
}

const testMissingAndOldVcRuntime = (): void => {
  const missing = healthyProbe()
  missing.readVcRuntimeRegistry = () => vcRegistry({
    installed: false,
    major: 14,
    minor: 40,
    build: 33810
  })
  assertRuntimeFailure(missing, /VC\+\+|Visual C|运行库|运行时/, 'VC++ 运行库缺失')

  const old = healthyProbe()
  old.readVcRuntimeRegistry = () => vcRegistry({
    installed: true,
    major: 14,
    minor: 20,
    build: 27508
  })
  assertRuntimeFailure(old, /VC\+\+|Visual C|运行库|版本|过旧/, 'VC++ 运行库版本过旧')

  const unreadable = healthyProbe()
  unreadable.readVcRuntimeRegistry = () => {
    throw new Error('reg.exe 查询失败')
  }
  assertRuntimeFailure(unreadable, /VC\+\+|Visual C|运行库|注册|读取|查询/, 'VC++ 运行库注册表不可读')
}

const testMissingOnnxFiles = (): void => {
  const probe = healthyProbe()
  probe.fileExists = (path: string): boolean => path.endsWith('\\onnxruntime.dll')
  assertRuntimeFailure(probe, /ONNX|onnx|文件|缺失|依赖/, 'ONNX Runtime 文件缺失')
}

const testNativeBindingLoadError = (): void => {
  const probe = healthyProbe()
  probe.loadNativeBinding = () => {
    throw new Error('A dynamic link library (DLL) initialization routine failed.')
  }
  assertRuntimeFailure(probe, /DLL|动态链接库|初始化|onnxruntime/, 'native binding 加载失败')

  const report = diagnoseRuntimeDependencies(probe)
  assert.match(
    formatRuntimeDependencyDiagnosis(report),
    /VC\+\+|运行库|安装包|onnxruntime/i,
    'native binding recovery text must point to an actionable offline repair path'
  )
}

testHealthyRuntime()
testUnsupportedWindows()
testNonX64()
testMissingAndOldVcRuntime()
testMissingOnnxFiles()
testNativeBindingLoadError()

console.log(JSON.stringify({
  ok: true,
  contract: 'runtime-dependencies',
  checks: [
    'healthy Windows x64 runtime',
    'Windows version below 10 diagnostic',
    'non-x64 architecture diagnostic',
    'missing and outdated VC++ 2015-2022 x64 runtime diagnostics',
    'missing ONNX Runtime file diagnostic',
    'native ONNX binding load-error diagnostic'
  ]
}, null, 2))
