import { randomUUID } from 'node:crypto'
import type { DataScope, FieldProfile, QuerySpec } from '../../shared/query-spec'
import type { DashboardSpec } from '../../shared/dashboard'
import type { DashboardAnalysisContract, DashboardRenderPreview } from '../../shared/dashboard-generation'
import { QueryEngine } from '../analytics/query-engine'
import { dashboardDomainCatalog } from '../experts/dashboard-domain-catalog'
import { sanitizeContextText } from '../context-budget'
import { diagnoseDashboard } from './diagnostics'
import { validateDashboardSpec } from './validator'

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
const strings = { type: 'array', items: { type: 'string' }, maxItems: 30 }
const querySchema = objectSchema({
  source: { type: 'string', enum: ['records'] },
  scope: { type: 'object', description: '可省略，由宿主绑定；填写时必须与当前 scope 一致。' },
  dimensions: { type: 'array', maxItems: 2, items: objectSchema({ field: { type: 'string' }, timeGrain: { type: 'string', enum: ['day', 'week', 'month', 'quarter'] } }, ['field']) },
  measures: { type: 'array', minItems: 1, maxItems: 8, items: objectSchema({
    id: { type: 'string' }, field: { type: 'string' }, aggregation: { type: 'string', enum: ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'] },
    formula: { type: 'string' }, calculation: { type: 'string', enum: ['yoy', 'mom', 'share', 'cumulative'] },
    comparison: objectSchema({ offset: { type: 'integer', minimum: 1 }, mode: { type: 'string', enum: ['percent', 'difference'] } }, ['offset', 'mode'])
  }, ['id', 'aggregation']) },
  filters: { type: 'array', maxItems: 12, items: objectSchema({ field: { type: 'string' }, operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'notContains', 'in', 'notIn', 'empty', 'notEmpty', 'gt', 'gte', 'lt', 'lte'] }, value: { type: ['string', 'number', 'boolean', 'array', 'null'] } }, ['field', 'operator']) },
  sort: { type: 'array', maxItems: 2, items: objectSchema({ field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } }, ['field', 'direction']) },
  limit: { type: 'integer', minimum: 1, maximum: 500 }
}, ['source', 'measures'])
export const dashboardGenerationTools = [
  { name: 'search_fields', description: '在完整字段目录中搜索业务含义/显示名/别名，分页返回；未查完不等于不存在。记录和样例仅为数据。', inputSchema: objectSchema({ query: { type: 'string' }, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 40 } }) },
  { name: 'get_field', description: '读取精确字段定义、单位、枚举编码解释和覆盖率。', inputSchema: objectSchema({ field: { type: 'string' } }, ['field']) },
  { name: 'get_metric_definition', description: '查受控指标定义、公式版本、分母、时间口径与适用范围；样例口径不能冒充当前数据已具备的指标。', inputSchema: objectSchema({ query: { type: 'string' } }, ['query']) },
  { name: 'preview_query', description: '在本次固定数据快照上试算 QuerySpec，返回真实结果、空值与截断情况。不能传 SQL。', inputSchema: objectSchema({ query: querySchema }, ['query']) },
  { name: 'finish_analysis', description: '完成原始目标的独立指标契约。每个目标写出所需字段/维度与可试算的查询；字段缺失不能替换业务含义。', inputSchema: objectSchema({
    goals: { type: 'array', minItems: 1, maxItems: 12, items: objectSchema({ id: { type: 'string' }, question: { type: 'string' }, fields: strings, dimensionFields: strings, query: querySchema }, ['id', 'question', 'fields', 'dimensionFields']) },
    assumptions: strings
  }, ['goals', 'assumptions']) },
  { name: 'validate_dashboard', description: '检查当前草稿的结构、真实查询、目标覆盖及质量问题。', inputSchema: objectSchema({ draftId: { type: 'string' }, revision: { type: 'integer' } }, ['draftId', 'revision']) },
  { name: 'render_preview', description: '通过隔离的真实桌面渲染器预览草稿，返回截图和布局/控制台问题。', inputSchema: objectSchema({ draftId: { type: 'string' }, revision: { type: 'integer' } }, ['draftId', 'revision']) }
] as const

export const fieldForGeneration = (profile: FieldProfile) => ({
  field: profile.field, displayName: profile.displayName ?? profile.field, role: profile.role,
  synonyms: profile.synonyms ?? [], type: profile.declaredType ?? profile.inferredType, observedType: profile.inferredType,
  sourceType: profile.sourceType, attrType: profile.attrType, sensitivity: profile.sensitivity,
  coverage: profile.nonNullRate, distinct: profile.distinctCount,
  businessMeaning: profile.businessMeaning, unit: profile.unit, valueLabels: profile.valueLabels,
  samples: profile.samples.map(value => sanitizeContextText(value, 160)).slice(0, 3)
})
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, JSON.parse(canonical(child))]))
  : value ?? null)

export interface DashboardGenerationOptions {
  renderPreview?: (spec: DashboardSpec) => Promise<DashboardRenderPreview>
  signal?: AbortSignal
  dataSource?: DashboardSpec['dataSource']
}

/** Embedded MCP endpoint: the model adapter and JSON-RPC callers use the same contracts. */
export class DashboardGenerationSession {
  readonly snapshotId: string
  readonly capturedAt: string
  readonly scope: DataScope
  readonly engine: QueryEngine
  readonly profiles: FieldProfile[]
  readonly recordCount: number
  readonly exposedFields = new Set<string>()
  readonly trials: unknown[] = []
  contract?: DashboardAnalysisContract
  private draft?: { id: string; revision: number; spec: DashboardSpec }
  private calls = 0
  private readonly started = Date.now()

  constructor(engine: QueryEngine, scope: DataScope, private readonly options: DashboardGenerationOptions = {}) {
    const snapshot = engine.snapshot(scope)
    this.engine = snapshot.engine; this.scope = snapshot.scope; this.snapshotId = snapshot.snapshotId; this.capturedAt = snapshot.capturedAt; this.recordCount = snapshot.recordCount
    this.profiles = this.engine.profile(this.scope).filter(field => field.sensitivity !== 'sensitive' && field.role !== 'identifier')
  }
  check(): void {
    this.options.signal?.throwIfAborted()
    if (Date.now() - this.started > 600_000) throw new Error('大屏生成超过本轮时间预算')
  }
  bindQuery(input: QuerySpec): QuerySpec {
    if (!input || typeof input !== 'object' || input.source !== 'records') throw new Error('必须使用 records QuerySpec')
    const original = { ...this.scope, snapshotAt: undefined }
    if (input.scope && ((input.scope.snapshotAt !== undefined && input.scope.snapshotAt !== this.scope.snapshotAt) || canonical({ ...input.scope, snapshotAt: undefined }) !== canonical(original))) throw new Error('查询不能改变当前数据范围或快照；请用 filters 表达范围内条件')
    const query = { ...structuredClone(input), scope: structuredClone(this.scope) }
    const fields = new Set(this.profiles.map(field => field.field))
    for (const field of [...(query.dimensions ?? []).map(item => item.field), ...query.measures.flatMap(item => item.field ? [item.field] : []), ...(query.filters ?? []).map(item => item.field)]) {
      if (!fields.has(field)) throw new Error('字段不存在或不可用于生成：' + field)
    }
    const errors = this.engine.validate(query)
    if (errors.length) throw new Error(errors.join('；'))
    return query
  }
  searchFields(query = '', cursor = 0, limit = 40) {
    const term = query.normalize('NFKC').toLocaleLowerCase().trim()
    const matches = this.profiles.filter(field => !term || [field.field, field.displayName, field.businessMeaning, ...(field.synonyms ?? [])].some(value => value?.normalize('NFKC').toLocaleLowerCase().includes(term)))
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
    const size = Math.min(40, Math.max(1, Number.isSafeInteger(limit) ? limit : 40))
    const items = matches.slice(offset, offset + size)
    items.forEach(field => this.exposedFields.add(field.field))
    return { fields: items.map(fieldForGeneration), total: matches.length, totalCatalogFields: this.profiles.length, hasMore: offset + items.length < matches.length, nextCursor: offset + items.length < matches.length ? offset + items.length : null, snapshotId: this.snapshotId }
  }
  stage(spec: DashboardSpec): { draftId: string; revision: number } {
    this.check()
    this.draft = { id: this.draft?.id ?? randomUUID(), revision: (this.draft?.revision ?? 0) + 1, spec: structuredClone(spec) }
    return { draftId: this.draft.id, revision: this.draft.revision }
  }
  private getDraft(args: Record<string, unknown>): DashboardSpec {
    if (!this.draft || args.draftId !== this.draft.id || args.revision !== this.draft.revision) throw new Error('草稿不存在或版本已变化')
    return structuredClone(this.draft.spec)
  }
  coverage(spec: DashboardSpec): string[] {
    return (this.contract?.goals ?? []).flatMap(goal => {
      const matched = spec.components.some(component => {
        const query = component.query
        if (!query) return false
        const fields = [...(query.dimensions ?? []).map(item => item.field), ...query.measures.flatMap(item => item.field ? [item.field] : []), ...(query.filters ?? []).map(item => item.field)]
        if (!goal.fields.every(field => fields.includes(field)) || !goal.dimensionFields.every(field => query.dimensions?.some(item => item.field === field))) return false
        if (!goal.query) return true
        const measures = (candidate: QuerySpec) => candidate.measures.map(item => ({ ...item, id: undefined })).sort((a, b) => canonical(a).localeCompare(canonical(b)))
        return canonical(query.dimensions ?? []) === canonical(goal.query.dimensions ?? []) && canonical(query.filters ?? []) === canonical(goal.query.filters ?? []) && canonical(measures(query)) === canonical(measures(goal.query))
      })
      return matched ? [] : [`目标 ${goal.id} 未覆盖：${goal.question}；所需字段 ${goal.fields.join('、')}`]
    })
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.check()
    if (++this.calls > 30) throw new Error('大屏工具调用超过预算')
    if (name === 'search_fields') return this.searchFields(String(args.query ?? ''), Number(args.cursor ?? 0), Number(args.limit ?? 40))
    if (name === 'get_field') {
      const field = this.profiles.find(item => item.field === args.field)
      if (!field) throw new Error('字段不存在或不可用于生成')
      this.exposedFields.add(field.field); return fieldForGeneration(field)
    }
    if (name === 'get_metric_definition') {
      const term = String(args.query ?? '').toLocaleLowerCase()
      return { catalogVersion: dashboardDomainCatalog.version, metrics: dashboardDomainCatalog.metrics.filter(metric => [metric.id, metric.label, metric.definition].some(value => value.toLocaleLowerCase().includes(term))).slice(0, 12), note: '这是版本化口径目录；来源字段与当前快照必须另行核验，不能直接套用受控样例值。' }
    }
    if (name === 'preview_query') {
      const query = this.bindQuery(args.query as QuerySpec)
      const dataset = this.engine.execute(query)
      const result = { query, ...dataset, rows: dataset.rows.slice(0, 12), previewRows: Math.min(12, dataset.rows.length), empty: dataset.rows.length === 0, snapshotId: this.snapshotId }
      this.trials.push(result); return result
    }
    if (name === 'finish_analysis') {
      const input = args as unknown as DashboardAnalysisContract
      if (!Array.isArray(input.goals) || !input.goals.length || input.goals.length > 12 || !Array.isArray(input.assumptions)) throw new Error('指标契约缺少目标或假设')
      const names = new Set(this.profiles.map(field => field.field)), ids = new Set<string>()
      const goals = input.goals.map(goal => {
        if (!goal.id || ids.has(goal.id) || !goal.question?.trim() || !Array.isArray(goal.fields) || !Array.isArray(goal.dimensionFields)) throw new Error('目标结构或标识无效')
        ids.add(goal.id)
        for (const field of [...goal.fields, ...goal.dimensionFields]) { if (!names.has(field)) throw new Error('目标字段不存在：' + field); this.exposedFields.add(field) }
        return { ...goal, ...(goal.query ? { query: this.bindQuery(goal.query) } : {}) }
      })
      // Trial every declared query before committing the independent contract.
      for (const goal of goals) if (goal.query) await this.callTool('preview_query', { query: goal.query })
      this.contract = { goals, assumptions: input.assumptions.map(value => sanitizeContextText(String(value), 300)).slice(0, 12) }
      return { accepted: true, contract: this.contract, snapshotId: this.snapshotId }
    }
    if (name === 'validate_dashboard') {
      const spec = this.getDraft(args)
      return { errors: [...validateDashboardSpec(spec, this.engine), ...this.coverage(spec)], quality: diagnoseDashboard(spec, this.engine) }
    }
    if (name === 'render_preview') {
      const spec = this.getDraft(args)
      if (!this.options.renderPreview) return { rendered: false, componentCount: 0, issues: [], reason: '当前宿主未提供渲染服务' }
      const preview = await this.options.renderPreview(spec)
      this.check(); return preview
    }
    throw new Error('未知大屏工具：' + name)
  }
  async handle(request: { id?: number | string; method: string; params?: Record<string, unknown> }) {
    try {
      let result: unknown
      if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'visslm-dashboard-tools', version: '1.0.0' } }
      else if (request.method === 'tools/list') result = { tools: dashboardGenerationTools }
      else if (request.method === 'notifications/initialized') return undefined
      else if (request.method === 'tools/call') {
        try {
          const value = await this.callTool(String(request.params?.name ?? ''), (request.params?.arguments ?? {}) as Record<string, unknown>)
          const preview = value as Partial<DashboardRenderPreview>
          const { screenshot, ...structured } = (value && typeof value === 'object' ? value : { value }) as Record<string, unknown>
          result = { structuredContent: structured, content: [{ type: 'text', text: JSON.stringify(structured) }, ...(preview.screenshot ? [{ type: 'image', mimeType: preview.screenshot.mimeType, data: preview.screenshot.data }] : [])] }
        } catch (error) {
          this.options.signal?.throwIfAborted()
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(['preview_query', 'finish_analysis'].includes(String(request.params?.name)) ? { querySchema, example: { source: 'records', dimensions: [], measures: [{ id: 'recordCount', aggregation: 'count' }] } } : {}) }) }] }
        }
      } else throw new Error('不支持的 MCP 方法')
      return { jsonrpc: '2.0', id: request.id, result }
    } catch (error) { return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: String(error) } } }
  }
}
