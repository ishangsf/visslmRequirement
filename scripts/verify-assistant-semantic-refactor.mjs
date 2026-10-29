
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const files = [
 'tests/ai-assistant-agent-intent-regression.ts', 'tests/assistant-query-contract-regression.ts',
 'tests/assistant-orchestrator-regression.ts', 'tests/ai-assistant-global-orchestration-regression.ts',
 'tests/assistant-natural-language-delivery-regression.ts', 'tests/assistant-field-semantics-recovery-regression.ts',
 'tests/assistant-record-analysis-regression.ts', 'tests/assistant-regional-requirements-regression.ts',
 'tests/assistant-execution-log-regression.ts', 'tests/assistant-execution-insight-regression.ts',
 'tests/visualization-semantic-planner-regression.ts', 'tests/platform-mcp-analysis-regression.ts',
 'tests/chat-context-safety-regression.ts',
 'scripts/smoke-project-management.ts', 'scripts/smoke-visualization-regression.ts',
 'scripts/smoke-dashboard-ai-context.ts', 'scripts/smoke-dashboard-gjb5000b-chat.ts',
 'scripts/smoke-dashboard-gjb5000b-request.ts', 'scripts/smoke-dashboard-gjb5000b-main-route.ts',
 'scripts/smoke-dashboard-domain-platform-adapter.ts', 'scripts/smoke-dashboard-scenario-wizard-generation.ts',
 'scripts/smoke-dashboard-gjb5000b-quality-integration.ts', 'scripts/smoke-dashboard-gjb5000b-save-gate.ts',
 ...['compliance','configuration-change','requirements-delivery','plan-milestone','organization-improvement','test-validation','software-quality'].map(name => 'scripts/smoke-dashboard-gjb5000b-' + name + '.ts')
]
const selected = process.argv.slice(2)
const results = []
mkdirSync('artifacts/assistant-semantic-refactor', { recursive: true })
for (const file of selected.length ? files.filter(file => selected.some(name => file.includes(name))) : files) {
 const tsx = process.env.VISSLM_TEST_TSX
 const run = tsx
  ? spawnSync(process.execPath, [tsx, file], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  : spawnSync('npx', ['--no-install', 'tsx', file], { shell: process.platform === 'win32', encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
 const result = { file, ok: run.status === 0, exitCode: run.status, output: run.stdout + run.stderr, error: run.error?.message }
 results.push(result)
 console.log((result.ok ? 'PASS ' : 'FAIL ') + file)
 if (!result.ok) console.log(result.output.slice(-2000))
}
writeFileSync('artifacts/assistant-semantic-refactor/' + (selected.length ? 'recheck.json' : 'regression.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify({ passed: results.filter(item => item.ok).length, total: results.length }))
if (results.some(item => !item.ok)) process.exitCode = 1
