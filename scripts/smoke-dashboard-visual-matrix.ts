import { strict as assert } from 'node:assert'
import { dashboardGoldenScenarios } from '../src/main/experts/dashboard-golden'
import { dashboardVisualViewports, validateProjectedLayout } from '../src/shared/dashboard-visual-regression'
import { validateDashboardSpec } from '../src/main/dashboards/validator'

const allThemes = new Set(dashboardGoldenScenarios.map((scenario) => scenario.spec.theme))
assert.ok(allThemes.has('technology-dark'), '视觉矩阵缺少深色科技主题')
assert.ok(allThemes.has('minimal-light'), '视觉矩阵缺少明亮简洁主题')
assert.ok(allThemes.has('charcoal-dark'), '视觉矩阵缺少深色稳重主题')
const themeIds = ['technology-dark', 'business-light', 'charcoal-dark', 'minimal-light'] as const
for (const theme of themeIds) {
  const errors = validateDashboardSpec({ ...dashboardGoldenScenarios[0].spec, theme })
  assert.ok(!errors.some((error) => error.includes('主题')), `${theme} 主题未通过 DashboardSpec 校验`)
}
assert.equal(dashboardVisualViewports.map((viewport) => viewport.width).join(','), '1366,1920,3840')

const checks = dashboardGoldenScenarios.flatMap((scenario) =>
  dashboardVisualViewports.map((viewport) => {
    const errors = validateProjectedLayout(scenario.spec, viewport)
    assert.deepEqual(errors, [], `${scenario.id}/${viewport.id}: ${errors.join('；')}`)
    return {
      scenario: scenario.id,
      theme: scenario.spec.theme,
      viewport: `${viewport.width}x${viewport.height}`,
      status: 'ok'
    }
  })
)

console.log(JSON.stringify({ ok: true, viewports: dashboardVisualViewports, checks }, null, 2))
