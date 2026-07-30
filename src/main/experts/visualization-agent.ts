import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type {
  DashboardComponentSpec,
  DashboardDataPoint,
  DashboardSpec,
  VisualizationRunInput
} from '../../shared/dashboard'
import { arrangeDashboardComponents } from '../../shared/dashboard-layout'
import type { DataScope, FieldProfile, QueryDataset } from '../../shared/query-spec'
import type { ModelSettings } from '../../shared/types'
import { QueryEngine } from '../analytics/query-engine'
import { validateDashboardSpec } from '../dashboards/validator'

interface OllamaJsonResponse {
  message?: { content?: string }
}

const dashboardJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'title',
    'subtitle',
    'businessContext',
    'viewport',
    'theme',
    'updatedAt',
    'components'
  ],
  properties: {
    schemaVersion: { type: 'string', enum: ['1.0'] },
    id: { type: 'string' },
    title: { type: 'string' },
    subtitle: { type: 'string' },
    businessContext: {
      type: 'object',
      additionalProperties: false,
      required: ['audience', 'objective', 'scopeDescription'],
      properties: {
        audience: { type: 'string' },
        objective: { type: 'string' },
        scopeDescription: { type: 'string' }
      }
    },
    viewport: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'columns', 'rowHeight'],
      properties: {
        width: { type: 'integer', enum: [1920] },
        height: { type: 'integer', enum: [1080] },
        columns: { type: 'integer', enum: [24] },
        rowHeight: { type: 'integer', minimum: 20, maximum: 120 }
      }
    },
    theme: { type: 'string', enum: ['technology-dark', 'business-light'] },
    updatedAt: { type: 'string' },
    components: {
      type: 'array',
      minItems: 4,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'title', 'layout', 'data', 'query', 'encoding'],
        properties: {
          id: { type: 'string' },
          type: {
            type: 'string',
            enum: ['kpi', 'bar', 'line', 'pie', 'ranking', 'table', 'progress', 'insight']
          },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          layout: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y', 'w', 'h'],
            properties: {
              x: { type: 'integer', minimum: 0, maximum: 23 },
              y: { type: 'integer', minimum: 0, maximum: 19 },
              w: { type: 'integer', minimum: 2, maximum: 24 },
              h: { type: 'integer', minimum: 2, maximum: 20 }
            }
          },
          data: { type: 'array', maxItems: 0 },
          unit: { type: 'string' },
          accent: { type: 'string' },
          insight: { type: 'string' },
          query: {
            type: 'object',
            additionalProperties: false,
            required: ['source', 'scope', 'dimensions', 'measures', 'limit'],
            properties: {
              source: { type: 'string', enum: ['records'] },
              scope: { type: 'object' },
              dimensions: {
                type: 'array',
                maxItems: 2,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['field'],
                  properties: {
                    field: { type: 'string' },
                    timeGrain: {
                      type: 'string',
                      enum: ['day', 'week', 'month', 'quarter']
                    }
                  }
                }
              },
              measures: {
                type: 'array',
                minItems: 1,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'aggregation'],
                  properties: {
                    id: { type: 'string' },
                    field: { type: 'string' },
                    aggregation: {
                      type: 'string',
                      enum: ['count', 'countDistinct', 'sum', 'avg', 'min', 'max']
                    }
                  }
                }
              },
              sort: {
                type: 'array',
                maxItems: 2,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['field', 'direction'],
                  properties: {
                    field: { type: 'string' },
                    direction: { type: 'string', enum: ['asc', 'desc'] }
                  }
                }
              },
              limit: { type: 'integer', minimum: 1, maximum: 500 }
            }
          },
          encoding: {
            type: 'object',
            additionalProperties: false,
            required: ['value'],
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              secondaryValue: { type: 'string' }
            }
          }
        }
      }
    }
  }
} as const

const extractJson = (content: string): unknown => {
  const trimmed = content.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象')
  return JSON.parse(candidate.slice(start, end + 1))
}

const toDataPoints = (
  component: DashboardComponentSpec,
  dataset: QueryDataset
): DashboardDataPoint[] => {
  const labelField = component.encoding?.label
  const valueField = component.encoding?.value
  const secondaryField = component.encoding?.secondaryValue
  if (!valueField) return []
  return dataset.rows.map((row, index) => ({
    name: String(labelField ? row[labelField] ?? `数据 ${index + 1}` : row[labelField ?? ''] ?? component.title),
    value: Number(row[valueField] ?? 0),
    ...(secondaryField ? { secondaryValue: Number(row[secondaryField] ?? 0) } : {})
  }))
}

const catalogForPrompt = (profiles: FieldProfile[]): object[] =>
  profiles.slice(0, 100).map(({ field, inferredType, nonNullRate, distinctCount, samples }) => ({
    field,
    type: inferredType,
    coverage: nonNullRate,
    distinct: distinctCount,
    samples: samples.slice(0, 3)
  }))

const normalizeGeneratedSpec = (input: unknown, scope: DataScope): unknown => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const spec = input as Record<string, unknown>
  if (!Array.isArray(spec.components)) return input
  return {
    ...spec,
    components: spec.components.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const component = value as Record<string, unknown>
      const rawQuery = (
        component.query && typeof component.query === 'object'
          ? component.query
          : component.querySpec && typeof component.querySpec === 'object'
            ? component.querySpec
            : {}
      ) as Record<string, unknown>
      const rawMeasures = Array.isArray(rawQuery.measures)
        ? rawQuery.measures
        : Array.isArray(rawQuery.metrics)
          ? rawQuery.metrics
          : Array.isArray(component.measures)
            ? component.measures
            : Array.isArray(component.metrics)
              ? component.metrics
          : rawQuery.measure
            ? [rawQuery.measure]
            : rawQuery.metric
              ? [rawQuery.metric]
              : []
      const measures = rawMeasures.flatMap((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return []
        const measure = value as Record<string, unknown>
        const aggregationAliases: Record<string, string> = {
          distinctCount: 'countDistinct',
          distinct_count: 'countDistinct',
          count_distinct: 'countDistinct',
          average: 'avg'
        }
        const aggregation = String(measure.aggregation ?? measure.agg ?? 'count')
        return [{
          ...measure,
          id: String(measure.id ?? measure.name ?? measure.alias ?? `value_${index + 1}`),
          aggregation: aggregationAliases[aggregation] ?? aggregation
        }]
      })
      const encoding = (
        component.encoding && typeof component.encoding === 'object'
          ? component.encoding
          : {}
      ) as Record<string, unknown>
      if (!measures.length) {
        measures.push({
          id: String(encoding.value ?? 'recordCount'),
          aggregation: 'count'
        })
      }
      const dimensions = Array.isArray(rawQuery.dimensions)
        ? rawQuery.dimensions
        : Array.isArray(component.dimensions)
          ? component.dimensions
        : rawQuery.dimension
          ? [rawQuery.dimension]
          : rawQuery.groupBy
            ? (Array.isArray(rawQuery.groupBy) ? rawQuery.groupBy : [rawQuery.groupBy])
                .map((field) => typeof field === 'string' ? { field } : field)
            : []
      const singleValue = ['kpi', 'progress'].includes(String(component.type))
      const normalizedDimensions = singleValue ? [] : dimensions
      const defaultLimits: Record<string, number> = {
        kpi: 1,
        progress: 1,
        pie: 8,
        ranking: 10,
        bar: 10,
        line: 60,
        table: 100,
        insight: 20
      }
      const requestedLimit = Number(rawQuery.limit)
      const maximumLimit = defaultLimits[String(component.type)] ?? 100
      const normalizedEncoding: Record<string, unknown> = {
        ...encoding,
        value: String(encoding.value ?? measures[0].id)
      }
      if (singleValue) delete normalizedEncoding.label
      return {
        ...component,
        data: [],
        query: {
          ...rawQuery,
          source: 'records',
          scope,
          dimensions: normalizedDimensions,
          measures,
          limit: Number.isInteger(requestedLimit)
            ? Math.min(maximumLimit, Math.max(1, requestedLimit))
            : maximumLimit
        },
        encoding: normalizedEncoding
      }
    })
  }
}

export class VisualizationAgent {
  private readonly queryEngine: QueryEngine

  constructor(
    queryEngine: QueryEngine,
    private readonly settings: ModelSettings,
    private readonly onRun?: (run: VisualizationRunInput) => void
  ) {
    this.queryEngine = queryEngine
  }

  async generate(question: string, scope: DataScope): Promise<DashboardSpec> {
    const startedAt = performance.now()
    let attemptCount = 0
    let dashboard: DashboardSpec | undefined
    let finalError: unknown
    const record = (status: VisualizationRunInput['status']): void => {
      try {
        this.onRun?.({
          dashboardId: dashboard?.id,
          requestSummary: question.replace(/\s+/g, ' ').trim(),
          modelName: this.settings.model,
          promptVersion: 'visualization-v1',
          status,
          attemptCount,
          componentCount: dashboard?.components.length ?? 0,
          queryCount: dashboard?.components.filter((component) => component.query).length ?? 0,
          durationMs: Number((performance.now() - startedAt).toFixed(2)),
          errorMessage: finalError instanceof Error ? finalError.message : finalError ? String(finalError) : undefined
        })
      } catch {
        // Diagnostics must never change the generation result.
      }
    }
    const profiles = this.queryEngine.profile(scope)
    if (!profiles.length) {
      finalError = new Error('当前数据范围没有可用字段，请先采集数据')
      record('failed')
      throw finalError
    }
    let validationFeedback = ''
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      attemptCount = attempt + 1
      try {
        const raw = await this.generateSpec(question, scope, profiles, validationFeedback)
        const normalized = normalizeGeneratedSpec(raw, scope) as DashboardSpec
        const spec: DashboardSpec = {
          ...normalized,
          viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
          components: arrangeDashboardComponents(normalized.components)
        }
        const errors = validateDashboardSpec(spec, this.queryEngine)
        if (errors.length) {
          validationFeedback = errors.join('\n')
          throw new Error(validationFeedback)
        }
        dashboard = {
          ...spec,
          id: spec.id || randomUUID(),
          updatedAt: new Date().toISOString(),
          components: spec.components.map((component) => {
            const dataset = this.queryEngine.execute(component.query!)
            return { ...component, data: toDataPoints(component, dataset) }
          })
        }
        record('success')
        return dashboard
      } catch (error) {
        lastError = error
        if (!validationFeedback) {
          validationFeedback = error instanceof Error ? error.message : String(error)
        }
      }
    }
    finalError = new Error(
      `DashboardSpec 生成失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    )
    record('failed')
    throw finalError
  }

  private async generateSpec(
    question: string,
    scope: DataScope,
    profiles: FieldProfile[],
    validationFeedback: string
  ): Promise<unknown> {
    const response = await fetch(`${this.settings.baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.model,
        stream: false,
        format: dashboardJsonSchema,
        think: false,
        options: { temperature: 0.1, num_ctx: 32768, num_predict: 6000 },
        messages: [
          {
            role: 'system',
            content: [
              '你是 VISSLM 数据可视化专家。只输出一个合法 JSON 对象，不输出 Markdown。',
              '你只能使用给定字段目录，禁止输出 SQL、JavaScript、HTML 或 CSS。',
              '输出 DashboardSpec schemaVersion=1.0，theme 只能是 technology-dark 或 business-light。',
              '生成 4 到 8 个不重叠组件，组件 type 只能是 kpi/bar/line/pie/ranking/table/progress/insight。',
              '画布为 24 列；layout 会由系统按组件内容自动编排，你仍需返回合法整数占位值。',
              '每个组件必须包含 id,type,title,layout,data:[],query,encoding。',
              'query 必须符合 QuerySpec：source=records、scope 使用给定值、1-2 个 dimensions、至少一个 measures，limit<=500。',
              '注意字段名必须精确写成 measures（不能写 metrics、measure 或 metric）。示例：{"measures":[{"id":"recordCount","aggregation":"count"}]}。',
              'aggregation 只能是 count/countDistinct/sum/avg/min/max；非 count 聚合必须有 field。',
              'encoding.value 必须引用 measure.id；有维度时 encoding.label 引用第一个 dimension.field。',
              '日期趋势只能对 date 字段使用 timeGrain；sum/avg/min/max 只能用于 number 字段。',
              '优先生成记录总量 KPI、一个分类分布、一个时间趋势（存在日期字段时）和一个排行榜。',
              'insight 也必须有 query 和 encoding，insight 文本只能概括查询含义，不能编造数字。',
              '返回字段：schemaVersion,id,title,subtitle,businessContext,viewport,theme,updatedAt,components。'
            ].join('\n')
          },
          {
            role: 'user',
            content: JSON.stringify({
              request: question,
              scope,
              fieldCatalog: catalogForPrompt(profiles),
              previousValidationErrors: validationFeedback || undefined
            })
          }
        ]
      }),
      signal: AbortSignal.timeout(180_000)
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Ollama HTTP ${response.status}: ${body.slice(0, 300)}`)
    }
    const payload = await response.json() as OllamaJsonResponse
    return extractJson(payload.message?.content ?? '')
  }
}
