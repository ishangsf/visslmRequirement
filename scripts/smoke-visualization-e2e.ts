import { join } from 'node:path'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { AppDatabase } from '../src/main/database'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'

const appData = join(process.env.APPDATA ?? '', 'visslm-agent-desktop')
const db = new AppDatabase(
  join(appData, 'visslm-agent.db'),
  join(appData, 'assets', 'base64')
)

try {
  const queryEngine = new QueryEngine(db)
  const agent = new VisualizationAgent(queryEngine, {
    baseUrl: db.getSetting('model.baseUrl') ?? 'http://127.0.0.1:11434',
    model: db.getSetting('model.model') ?? 'qwen3:8b',
    thinking: false
  })
  const dashboard = await agent.generate(
    '生成一个面向项目经理的数据质量大屏，关注记录规模、类型分布和最近修改趋势',
    {}
  )
  if (!dashboard.components.length) throw new Error('模型没有生成组件')
  if (dashboard.components.some((component) => !component.query || !component.data)) {
    throw new Error('存在未物化 QuerySpec 的组件')
  }
  console.log(JSON.stringify({
    ok: true,
    id: dashboard.id,
    title: dashboard.title,
    theme: dashboard.theme,
    components: dashboard.components.map((component) => ({
      id: component.id,
      type: component.type,
      rows: component.data.length,
      query: component.query
    }))
  }, null, 2))
} finally {
  db.close()
}
