import {
  BarChartOutlined,
  BorderOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  ClearOutlined,
  CloudDownloadOutlined,
  CloseOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  EyeOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FilterOutlined,
  FileWordOutlined,
  FundProjectionScreenOutlined,
  FullscreenExitOutlined,
  HistoryOutlined,
  HolderOutlined,
  InfoCircleOutlined,
  ImportOutlined,
  LeftOutlined,
  MessageOutlined,
  MoonOutlined,
  MinusOutlined,
  PictureOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ProjectOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined,
  SunOutlined,
  ThunderboltOutlined,
  UserOutlined
} from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Image,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Pagination,
  Progress,
  Row,
  Select,
  Segmented,
  Space,
  Spin,
  Statistic,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { TablePaginationConfig } from 'antd'
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import remarkGfm from 'remark-gfm'
import appIconDark from './assets/visslm-icon.png'
import appIconLight from './assets/visslm-icon-light.png'
import { RichDescription } from './RichDescription'
import { ResizableTable } from './ResizableTable'
import {
  ArtifactExportPanel,
  assistantSkillPresentation
} from './assistant/ArtifactExportPanel'
import type {
  ArtifactExportFormat,
  ArtifactExportGenerationStatus
} from './assistant/ArtifactExportPanel'
import {
  buildDefaultPushFieldMappings,
  isLegacyDefaultPushFieldMappings,
  pushForbiddenSourceFields,
  pushForbiddenTargetFields,
  pushMappingIdentifierPattern,
  readPushConfigDraft,
  writePushConfigDraft
} from './push-config-draft'
import type { PushConfigDraft, PushFormValues } from './push-config-draft'
import type { AppThemeMode } from './theme'
import type { DashboardSpec } from '../../shared/dashboard'
import type {
  DataScope,
  FieldProfile,
  FieldProfileRole,
  FieldSensitivity
} from '../../shared/query-spec'
import {
  restoreLegacyAssistantMarkdown,
  stripRedundantAssistantCitationSections
} from '../../shared/chat-message-format'
import { deriveAssistantWorkspaceReadiness } from '../../shared/assistant-readiness'
import type { AgentEvent, AgentMatchProgress, AgentProgress, AssistantExecutionSummary, ExpertId } from '../../shared/expert-types'
import {
  DEFAULT_PROJECT_MATCHING_SETTINGS,
  DEFAULT_FEATURE_MODULE_SETTINGS,
  DEFAULT_FEATURE_NAVIGATION_ORDER
} from '../../shared/types'
import type {
  AppSettings,
  AssistantArtifact,
  AssistantArtifactOutputFormat,
  AssistantArtifactPreview,
  AssistantArtifactType,
  AssistantPlanFilter,
  AssistantPlanFilterOperator,
  AssistantPlanPatch,
  AssistantRunHistory,
  AssistantRunHistoryStats,
  AssistantExecutionAgentId,
  AssistantTaskTrace,
  ConfirmAgentPlanResult,
  ChatDataGroup,
  ChatDataRow,
  ChatDataView,
  ChatDataViewPage,
  ChatMessage,
  ChatSessionSummary,
  CollectionRequestLogRow,
  ConnectionResult,
  DataImportResult,
  DataImportRunSnapshot,
  DataReviewApplyResult,
  DataReviewItem,
  DataReviewSource,
  DashboardStats,
  FeatureNavigationOrder,
  FeatureModuleKey,
  FeatureModuleSettings,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  KnowledgeDocumentPreview,
  KnowledgeChunk,
  KnowledgeIndexProgress,
  KnowledgeStats,
  ModelCapabilityEvidence,
  ModelCapabilityItem,
  ModelCapabilityReport,
  ModelCapabilityStatus,
  ModelSettings,
  ModelProvider,
  ModelSource,
  PlatformSettingsInput,
  ProjectMatchingSettings,
  ProjectRow,
  PushConfig,
  PushFieldMapping,
  PushLogRow,
  PushResult,
  RecordExportQuery,
  RecordDetail,
  RecordImagePage,
  RecordMaintenanceIndexStatus,
  RecordMaintenanceOperation,
  RecordMaintenanceScope,
  RecordMaintenanceStage,
  RecordMaintenanceTaskSnapshot,
  RecordMaintenanceTaskStatus,
  RecordMaintenanceState,
  RecordMaintenancePreview,
  RecordReleaseValue,
  RecordRow,
  RequirementSemanticizationControl as SemanticizationControlAction,
  RequirementSemanticizationStage as SemanticizationTaskStage,
  RequirementSemanticizationStartInput as SemanticizationStartInput,
  RequirementSemanticizationStatus,
  RequirementSemanticizationTaskSnapshot as SemanticizationTaskSnapshot,
  RequirementSemanticizationTaskStatus as SemanticizationTaskStatus,
  SystemSettingsInput,
  SyncFieldFilter,
  SyncPreviewResult,
  SyncProgress,
  SyncResult,
  SyncScopeConfig,
  UpdateStatus
} from '../../shared/types'

const { Content, Sider } = Layout
const { Title, Text, Paragraph } = Typography
const MAX_CHAT_DETAIL_IMAGES = 12

// Keep the two largest route modules out of the shell's initial chunk. The
// remaining legacy page components currently live in this module, so these
// route boundaries are also the safe seam for progressively extracting them.
const DashboardStudio = lazy(() => import('./dashboard/DashboardStudio').then(({ DashboardStudio: Component }) => ({ default: Component })))
const ProjectManagementPage = lazy(() => import('./project-management/ProjectManagementPage').then(({ ProjectManagementPage: Component }) => ({ default: Component })))
const ReactECharts = lazy(() => import('./components/LightweightECharts').then(({ LightweightECharts: Component }) => ({ default: Component })))
const ReactMarkdown = lazy(() => import('react-markdown'))
const KnowledgeDocumentPreviewer = lazy(() => import('./knowledge/KnowledgeDocumentPreviewer').then(({ KnowledgeDocumentPreviewer: Component }) => ({ default: Component })))

type PageKey = 'dashboard' | 'visualization' | 'projects' | 'data' | 'semanticization' | 'chat' | 'sync' | 'push' | 'settings'
type AppProps = {
  themeMode: AppThemeMode
  onThemeModeChange: (next: AppThemeMode) => void
}

type SyncProgressListener = () => void

let syncProgressSnapshot: SyncProgress | null = null
let syncProgressPending: SyncProgress | null = null
let syncProgressTimer: number | null = null
let syncProgressCleanup: (() => void) | null = null
const syncProgressListeners = new Set<SyncProgressListener>()

const notifySyncProgress = (next: SyncProgress): void => {
  syncProgressSnapshot = next
  syncProgressListeners.forEach((listener) => listener())
}

const publishSyncProgress = (next: SyncProgress, immediate = false): void => {
  syncProgressPending = next
  const terminal = next.phase === 'done' || next.phase === 'error'
  if (immediate || terminal) {
    if (syncProgressTimer !== null) {
      window.clearTimeout(syncProgressTimer)
      syncProgressTimer = null
    }
    const current = syncProgressPending
    syncProgressPending = null
    if (current) notifySyncProgress(current)
    return
  }
  if (syncProgressTimer !== null) return
  syncProgressTimer = window.setTimeout(() => {
    syncProgressTimer = null
    const current = syncProgressPending
    syncProgressPending = null
    if (current) notifySyncProgress(current)
  }, 200)
}

const ensureSyncProgressSubscription = (): void => {
  if (syncProgressCleanup) return
  syncProgressCleanup = window.visslm.onSyncProgress((next) => publishSyncProgress(next))
}

const useSyncProgress = (): SyncProgress | null => {
  const [progress, setProgress] = useState<SyncProgress | null>(syncProgressSnapshot)

  useEffect(() => {
    ensureSyncProgressSubscription()
    const listener: SyncProgressListener = () => setProgress(syncProgressSnapshot)
    syncProgressListeners.add(listener)
    listener()
    return () => {
      syncProgressListeners.delete(listener)
    }
  }, [])

  return progress
}

function PageLoadingFallback(): React.JSX.Element {
  return (
    <div className="page-loading-fallback" role="status" aria-live="polite">
      <Spin size="large" />
      <Text type="secondary">正在加载模块…</Text>
    </div>
  )
}

const AppIconThemeContext = React.createContext<AppThemeMode>('dark')

function ThemedAppIcon({ alt }: { alt: string }): React.JSX.Element {
  const themeMode = React.useContext(AppIconThemeContext)
  return <img src={themeMode === 'light' ? appIconLight : appIconDark} alt={alt} />
}

type SystemSettingsTabKey = 'platform' | 'model' | 'general' | 'features'
type FeatureDropPosition = 'before' | 'after'
type FeatureDropTarget = {
  key: FeatureModuleKey
  position: FeatureDropPosition
}

const systemSettingsTabKeys: readonly SystemSettingsTabKey[] = [
  'platform',
  'model',
  'general',
  'features'
]

const isSystemSettingsTabKey = (key: string): key is SystemSettingsTabKey =>
  systemSettingsTabKeys.includes(key as SystemSettingsTabKey)

const artifactVersionOf = (events: AgentEvent[] | undefined): number | undefined =>
  events?.find((event): event is Extract<AgentEvent, { type: 'artifact' }> => event.type === 'artifact')?.version

/**
 * The renderer receives status events from multiple built-in skills.  Keep a
 * single user-facing vocabulary for the global orchestration pipeline while
 * still accepting the older skill-specific stage names during the migration.
 * Status messages remain operational summaries; model reasoning is never
 * rendered here.
 */
const agentStageOrder = [
  'classify',
  'skill',
  'scope',
  'clarify',
  'clarification',
  'inspect',
  'scan',
  'retrieve',
  'group',
  'cite',
  'verify',
  'reason',
  'answer',
  'deliver',
  'error'
] as const

const agentStageLabels: Record<string, string> = {
  classify: '识别任务',
  skill: '选择技能',
  scope: '确认范围',
  inspect: '检查字段',
  scan: '扫描数据',
  retrieve: '检索依据',
  group: '整理分组',
  cite: '整理引用',
  verify: '校验结果',
  reason: '分析证据',
  answer: '整理回答',
  deliver: '准备交付',
  clarify: '等待补充',
  clarification: '等待补充',
  route: '理解需求',
  locate: '检查实体',
  recall: '混合召回',
  rerank: '候选重排',
  score: '确定性评分',
  explain: '解释证据',
  critique: '复核结果',
  summary: '整理结果',
  match: '匹配数据',
  plan: '制定计划',
  query: '查询数据',
  validate: '校验结果',
  error: '任务中断'
}

const legacyAgentStageAliases: Record<string, string> = {
  route: 'classify',
  plan: 'scope',
  locate: 'inspect',
  query: 'scan',
  recall: 'retrieve',
  rerank: 'retrieve',
  match: 'group',
  score: 'verify',
  critique: 'verify',
  explain: 'reason',
  summary: 'deliver',
  validate: 'verify',
  intent: 'classify',
  profile: 'inspect',
  execute: 'scan',
  compose: 'deliver',
  persist: 'deliver',
  repair: 'verify'
}

const canonicalAgentStageOf = (stage: string | undefined): string => {
  const normalized = stage?.trim().toLocaleLowerCase()
  if (!normalized) return 'classify'
  return legacyAgentStageAliases[normalized] ?? normalized
}

const agentStageLabelOf = (stage: string | undefined): string => {
  const normalized = stage?.trim().toLocaleLowerCase()
  const canonical = canonicalAgentStageOf(normalized)
  return agentStageLabels[canonical] ?? agentStageLabels[normalized ?? ''] ?? '执行任务'
}

const agentStageRankOf = (stage: string): number => {
  const normalized = stage.trim().toLocaleLowerCase()
  const canonical = canonicalAgentStageOf(normalized)
  const rank = agentStageOrder.indexOf(canonical as (typeof agentStageOrder)[number])
  if (rank === -1) return agentStageOrder.length * 100

  // Preserve useful legacy skill sub-stages without letting event arrival
  // order move the global rail around. Canonical stages always sort first in
  // their group, followed by the old granular progress labels.
  const legacyOffset: Record<string, number> = {
    route: 1,
    plan: 1,
    locate: 1,
    query: 1,
    recall: 1,
    rerank: 2,
    match: 1,
    score: 1,
    critique: 2,
    explain: 2,
    summary: 1,
    validate: 1
  }
  return rank * 100 + (legacyOffset[normalized] ?? 0)
}

type ChatSourceSummary = {
  records: number
  documents: number
}

const chatSourceSummaryOf = (sources: ChatMessage['sources']): ChatSourceSummary => {
  const documentIds = new Set<string>()
  let documentsWithoutId = 0
  let records = 0
  for (const source of sources ?? []) {
    // Legacy persisted sources omitted sourceType and were always data-center
    // records. Treat them as records so an old session never loses its count.
    if (source.sourceType !== 'document') {
      records += 1
      continue
    }
    // Several retrieved chunks may belong to one document. Count the document
    // once in the summary while leaving each chunk visible in the source list.
    const documentId = source.documentId?.trim()
    if (documentId) documentIds.add(documentId)
    else documentsWithoutId += 1
  }
  return {
    records,
    documents: documentIds.size + documentsWithoutId
  }
}

const assistantMessageMarkdownOf = (message: ChatMessage): string =>
  stripRedundantAssistantCitationSections(
    restoreLegacyAssistantMarkdown(message.content),
    Boolean(message.sources?.length)
  )

type KnowledgeCitationTarget = {
  documentId: string
  chunkId?: string
}

const knowledgeCitationTargetOf = (href?: string): KnowledgeCitationTarget | null => {
  const normalizedHref = href?.trim()
  if (!normalizedHref?.startsWith('#')) return null
  try {
    const params = new URLSearchParams(normalizedHref.slice(1))
    if (!params.has('knowledge-document')) return null
    const documentId = params.get('knowledge-document')?.trim()
    if (!documentId) return null
    const chunkId = params.get('chunk')?.trim()
    return chunkId ? { documentId, chunkId } : { documentId }
  } catch {
    return null
  }
}

const knowledgeSourceLocationLabelOf = (source: NonNullable<ChatMessage['sources']>[number]): string => {
  if (typeof source.pageNumber === 'number' && Number.isFinite(source.pageNumber) && source.pageNumber > 0) {
    return `第${source.pageNumber}页`
  }
  const sheetName = source.sheetName?.trim()
  if (sheetName) return `工作表「${sheetName}」`
  const location = source.location?.trim()
  if (location && !/^(?:文档)?正文(?:内容)?$|^(?:分块|chunk)(?:\s*[#：:.-]?\s*\d+)?$/i.test(location)) return location
  const snippet = source.snippet?.trim().replace(/\s+/g, ' ')
  if (snippet) {
    const shortened = snippet.length > 44 ? `${snippet.slice(0, 44)}…` : snippet
    return `正文「${shortened}」`
  }
  return '引用位置'
}

type AssistantMarkdownLinkProps = React.ComponentPropsWithoutRef<'a'> & {
  node?: unknown
}

const safeMarkdownHrefOf = (href?: string): string | undefined => {
  const normalizedHref = href?.trim()
  if (!normalizedHref) return undefined
  // ReactMarkdown already applies its URL transform; keep an explicit allow
  // list here so custom rendering never turns model output into an executable
  // javascript/data/vbscript URL.
  if (/[\u0000-\u001F\u007F]/.test(normalizedHref)) return undefined
  if (/^[a-z][a-z\d+.-]*:/i.test(normalizedHref) && !/^(?:https?:|mailto:|tel):/i.test(normalizedHref)) {
    return undefined
  }
  return normalizedHref
}

const renderAssistantMarkdownLink = (
  { href, children, node: _node, ...props }: AssistantMarkdownLinkProps,
  openKnowledgeDetail: (documentId: string, chunkId?: string) => Promise<void>
): React.JSX.Element => {
  const citation = knowledgeCitationTargetOf(href)
  if (citation) {
    return (
      <button
        type="button"
        className="chat-knowledge-citation-link"
        title="打开知识库引用"
        aria-label="打开知识库引用"
        onClick={() => void openKnowledgeDetail(citation.documentId, citation.chunkId)}
      >
        {children}
      </button>
    )
  }

  const safeHref = safeMarkdownHrefOf(href)
  if (!safeHref) {
    return <span className="chat-markdown-link-blocked">{children}</span>
  }
  const isExternal = /^(?:https?:|\/\/)/i.test(safeHref)
  return (
    <a
      {...props}
      href={safeHref}
      target={isExternal ? '_blank' : props.target}
      rel={isExternal ? 'noreferrer noopener' : props.rel}
    >
      {children}
    </a>
  )
}

const appTableScrollY = 'min(560px, max(260px, calc(100vh - 300px)))'
const compactTableScrollY = 'min(360px, max(180px, calc(100vh - 420px)))'

const normalizedChatRecordUidsOf = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  return [...new Set(
    value
      .filter((uid): uid is string => typeof uid === 'string')
      .map((uid) => uid.trim())
      .filter(Boolean)
  )]
}

const chatDataGroupRecordUidsOf = (
  group: ChatDataGroup
): string[] | undefined => normalizedChatRecordUidsOf(group.recordUids)

/**
 * Grouped views own their paging scope.  The top-level list remains the
 * compatibility fallback for older flat views that predate group recordUids.
 * An explicit empty group list is preserved as empty and must not fall back to
 * the view-wide list.
 */
const chatDataViewPageScopeForGroup = (
  view: ChatDataView,
  groupName: string
): { recordUids?: string[] } | undefined => {
  const group = view.groups.find((candidate) => candidate.name === groupName)
  const groupRecordUids = group ? chatDataGroupRecordUidsOf(group) : undefined
  if (groupRecordUids !== undefined) return { recordUids: groupRecordUids }
  // A top-level UID list belongs to the legacy single-group shape.  Reusing it
  // for an unscoped multi-group view would load one group's records into
  // another group, so leave those groups non-pageable until they carry their
  // own UID snapshot.
  if (view.groups.length > 1) return undefined
  const recordUids = normalizedChatRecordUidsOf(view.recordUids)
  return recordUids === undefined ? undefined : { recordUids }
}

const chatDataViewRecordUidsForGroup = (
  view: ChatDataView,
  groupName: string
): string[] | undefined => {
  const pageScope = chatDataViewPageScopeForGroup(view, groupName)
  return pageScope?.recordUids
}

const isRecordObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

type AgentControlStepKey = 'understand' | 'skill' | 'plan' | 'tool' | 'verify' | 'deliver'
type AgentControlStepState = 'pending' | 'active' | 'complete'
type AgentRunStatus = 'idle' | 'running' | 'clarification' | 'failed' | 'cancelled'

type AgentRunMetadata = {
  skill?: string
  taskType?: string
  sourceMode?: string
  intent?: string
  resultMode?: string
  followUp?: boolean
  clarificationQuestion?: string
}

type AssistantTaskStatus = 'pending' | 'running' | 'completed' | 'clarification' | 'failed' | 'cancelled'

type ActiveChatRun = {
  runId: string
  sessionId: string
  question: string
  userMessage: ChatMessage
  baseMessages: ChatMessage[]
  startedAt: string
  initialMetadata: AgentRunMetadata
  cancelRequested: boolean
}

type AnswerStreamBuffer = {
  runId: string
  sessionId: string
  content: string
  lastSequence: number | null
  done: boolean
}

type StreamingAnswerView = {
  runId: string
  sessionId: string
  content: string
}

type AssistantTaskView = {
  runId?: AssistantTaskTrace['runId']
  status?: AssistantTaskStatus
  primaryAgent?: AssistantExecutionAgentId
  invokedAgents: AssistantExecutionAgentId[]
  taskType?: string
  sourceMode?: string
  resultMode?: string
  startedAt?: string
  completedAt?: string
  clarificationQuestion?: string
  error?: string
}

const assistantTaskStatusLabels: Record<AssistantTaskStatus, string> = {
  pending: '准备中',
  running: '执行中',
  completed: '已完成',
  clarification: '等待补充',
  failed: '执行失败',
  cancelled: '已停止'
}

const assistantTaskStatusClassOf = (status: AssistantTaskStatus | undefined): string => (
  status === 'failed'
    ? 'failed'
    : status === 'clarification'
      ? 'clarification'
      : status === 'cancelled'
        ? 'cancelled'
        : status === 'completed'
          ? 'completed'
          : status === 'running'
            ? 'running'
            : 'pending'
)

const assistantTaskStatusOf = (
  value: unknown,
  fallback: AssistantTaskStatus = 'pending'
): AssistantTaskStatus => {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLocaleLowerCase()
  if (['success', 'succeeded', 'complete', 'completed', 'done'].includes(normalized)) return 'completed'
  if (['clarification', 'needs_clarification', 'paused', 'waiting'].includes(normalized)) return 'clarification'
  if (['cancelled', 'canceled', 'stopped', 'stop_requested'].includes(normalized)) return 'cancelled'
  if (['failed', 'failure', 'error', 'aborted'].includes(normalized)) return 'failed'
  if (['running', 'in_progress', 'active', 'executing'].includes(normalized)) return 'running'
  if (['pending', 'queued', 'created'].includes(normalized)) return 'pending'
  return fallback
}

const agentControlStepOrder: readonly AgentControlStepKey[] = [
  'understand',
  'skill',
  'plan',
  'tool',
  'verify',
  'deliver'
]

const agentControlStepLabels: Record<AgentControlStepKey, string> = {
  understand: '理解目标 / 识别意图',
  skill: '选择技能',
  plan: '制定计划',
  tool: '执行工具',
  verify: '校验证据',
  deliver: '准备交付'
}

const agentControlStepDescriptions: Record<AgentControlStepKey, string> = {
  understand: '确认问题和意图',
  skill: '匹配可用能力',
  plan: '限定来源与范围',
  tool: '获取结构化依据',
  verify: '核对结果和引用',
  deliver: '整理回答或交付物'
}

const agentControlStepLabelsByStage: Record<string, AgentControlStepKey> = {
  classify: 'understand',
  route: 'understand',
  skill: 'skill',
  scope: 'plan',
  inspect: 'plan',
  plan: 'plan',
  clarify: 'plan',
  clarification: 'plan',
  scan: 'tool',
  retrieve: 'tool',
  group: 'tool',
  query: 'tool',
  recall: 'tool',
  rerank: 'tool',
  match: 'tool',
  cite: 'verify',
  verify: 'verify',
  reason: 'verify',
  score: 'verify',
  critique: 'verify',
  validate: 'verify',
  explain: 'verify',
  answer: 'deliver',
  deliver: 'deliver',
  summary: 'deliver'
}

const agentSkillLabels: Record<string, string> = {
  general: '通用数据助手',
  'knowledge-base': '知识库专家',
  visualization: '数据可视化专家',
  'requirement-analysis': '需求分析专家',
  artifact: '交付物专家'
}

const agentSourceModeLabels: Record<string, string> = {
  conversation: '普通对话',
  records: '数据中心记录',
  record: '数据中心记录',
  knowledge: '知识库文档',
  document: '知识库文档',
  mixed: '混合取证'
}

const agentTaskTypeLabels: Record<string, string> = {
  conversation: '普通对话',
  records: '记录查询',
  knowledge: '知识库问答',
  mixed: '混合取证',
  schema_inspection: '字段检查',
  total: '汇总统计',
  field_aggregate: '分组统计',
  record_lookup: '记录查找',
  filter_records: '条件查询',
  count_matching: '条件统计',
  search_content: '知识检索',
  visualization: '可视化交付',
  artifact_generation: '交付物生成',
  requirement_analysis: '需求分析',
  'requirement-analysis': '需求分析'
}

const agentIntentLabels: Record<string, string> = {
  conversation: '普通对话',
  schema_inspection: '字段检查',
  total: '汇总统计',
  field_aggregate: '分组统计',
  record_lookup: '记录查找',
  filter_records: '条件查询',
  count_matching: '条件统计',
  search_content: '知识检索'
}

const normalizedMetadataValueOf = (value: string | undefined): string | undefined => {
  const normalized = value?.trim()
  if (!normalized || normalized.length > 80 || /[\r\n]/.test(normalized)) return undefined
  return normalized
}

const stringPropertyOf = (
  value: Record<string, unknown>,
  keys: readonly string[]
): string | undefined => {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string') {
      const normalized = normalizedMetadataValueOf(candidate)
      if (normalized) return normalized
    }
  }
  return undefined
}

/**
 * Read only explicit orchestration metadata.  Status text, answer text and
 * evidence snippets are deliberately excluded so model prose can never be
 * mistaken for a skill, task type or system instruction.
 */
const agentRunMetadataOf = (value: unknown): AgentRunMetadata => {
  if (!isRecordObject(value)) return {}
  const candidates = [
    value,
    isRecordObject(value.taskTrace) ? value.taskTrace : null,
    isRecordObject(value.assistantIntent) ? value.assistantIntent : null,
    isRecordObject(value.metadata) ? value.metadata : null,
    isRecordObject(value.progress) ? value.progress : null
  ].filter(isRecordObject)
  const read = (keys: readonly string[]): string | undefined => {
    for (const candidate of candidates) {
      const result = stringPropertyOf(candidate, keys)
      if (result) return result
    }
    return undefined
  }
  const followUp = candidates.some((candidate) =>
    candidate.followUp === true || candidate.isFollowUp === true
  )
  return {
    ...(read(['skillLabel', 'skillName', 'selectedSkill', 'skill', 'expertName', 'expertId'])
      ? { skill: read(['skillLabel', 'skillName', 'selectedSkill', 'skill', 'expertName', 'expertId']) }
      : {}),
    ...(read(['taskTypeLabel', 'taskType', 'taskTypeId', 'requestType'])
      ? { taskType: read(['taskTypeLabel', 'taskType', 'taskTypeId', 'requestType']) }
      : {}),
    ...(read(['sourceMode', 'sourceType', 'sourceScope', 'mode'])
      ? { sourceMode: read(['sourceMode', 'sourceType', 'sourceScope', 'mode']) }
      : {}),
    ...(read(['resultMode', 'resultType'])
      ? { resultMode: read(['resultMode', 'resultType']) }
      : {}),
    ...(read(['intent', 'intentType']) ? { intent: read(['intent', 'intentType']) } : {}),
    ...(followUp ? { followUp: true } : {}),
    ...(read(['clarificationQuestion'])
      ? { clarificationQuestion: read(['clarificationQuestion']) }
      : {})
  }
}

const mergeAgentRunMetadata = (...metadata: AgentRunMetadata[]): AgentRunMetadata => (
  metadata.reduce<AgentRunMetadata>((merged, current) => ({
    ...merged,
    ...current,
    ...(current.followUp ? { followUp: true } : {}),
    ...(current.skill ? { skill: current.skill } : {}),
    ...(current.taskType ? { taskType: current.taskType } : {}),
    ...(current.sourceMode ? { sourceMode: current.sourceMode } : {}),
    ...(current.intent ? { intent: current.intent } : {}),
    ...(current.resultMode ? { resultMode: current.resultMode } : {}),
    ...(current.clarificationQuestion ? { clarificationQuestion: current.clarificationQuestion } : {})
  }), {})
)

const agentControlStepOfStage = (stage: string | undefined): AgentControlStepKey | undefined => {
  if (!stage) return undefined
  const normalized = canonicalAgentStageOf(stage)
  return agentControlStepLabelsByStage[normalized]
}

const readableAgentValueOf = (
  value: string | undefined,
  labels: Record<string, string>
): string | undefined => {
  const normalized = normalizedMetadataValueOf(value)
  if (!normalized) return undefined
  return labels[normalized.toLocaleLowerCase()] ?? normalized.replace(/[_-]+/g, ' ')
}

const agentSkillLabelOf = (
  metadata: AgentRunMetadata | undefined,
  fallbackExpertId?: ExpertId
): string | undefined => readableAgentValueOf(metadata?.skill ?? fallbackExpertId, agentSkillLabels)

const agentTaskTypeLabelOf = (
  metadata: AgentRunMetadata | undefined,
  message?: ChatMessage
): string | undefined => {
  const direct = readableAgentValueOf(metadata?.taskType, agentTaskTypeLabels)
  if (direct) return direct
  const sourceMode = readableAgentValueOf(metadata?.sourceMode, agentSourceModeLabels)
  if (sourceMode) return sourceMode
  const intent = readableAgentValueOf(metadata?.intent, agentIntentLabels)
  if (intent) return intent
  if (message?.dashboard) return '可视化交付'
  if (message?.dataViews?.length) return '记录查询'
  const sourceSummary = chatSourceSummaryOf(message?.sources)
  if (sourceSummary.records > 0 && sourceSummary.documents > 0) return '混合取证'
  if (sourceSummary.documents > 0) return '知识库问答'
  if (sourceSummary.records > 0) return '记录查询'
  if (message?.expertId === 'visualization') return '可视化交付'
  if (message?.expertId === 'requirement-analysis') return '需求分析'
  return undefined
}

const explicitAgentSkillOf = (question: string): string | undefined => {
  if (/@数据可视化专家(?:\s|$)/.test(question)) return 'visualization'
  if (/@需求分析专家(?:\s|$)/.test(question)) return 'requirement-analysis'
  if (/@知识库专家(?:\s|$)/.test(question)) return 'knowledge-base'
  if (/@交付物专家(?:\s|$)/.test(question)) return 'artifact'
  if (/@通用数据助手(?:\s|$)/.test(question)) return 'general'
  return undefined
}

const followUpQuestionOf = (question: string): boolean => (
  /(?:刚才|上一轮|前面|上述|以上|前述|继续(?:查|分析|看|说)?|这些(?:记录|数据|文档|结果)?|它们|这个结果|那个结果)/.test(question)
)

const assistantExecutionAgentLabels: Record<AssistantExecutionAgentId, string> = {
  conversation: 'Conversation Agent',
  'data-center': '数据中心 Agent',
  'knowledge-base': '知识库 Agent',
  'requirement-analysis': '需求分析 Agent',
  visualization: '可视化 Agent',
  artifact: '交付物 Agent'
}

const assistantTaskTypeLabels: Record<string, string> = {
  conversation: '普通对话',
  record_query: '数据中心查询',
  knowledge_qa: '知识库问答',
  mixed_analysis: '混合分析',
  visualization: '可视化交付',
  requirement_matching: '需求匹配',
  artifact_generation: '交付物生成'
}

const assistantResultModeLabels: Record<string, string> = {
  answer: '回答',
  list: '列表',
  grouped_list: '分组列表',
  table: '数据表',
  dashboard: '大屏交付',
  artifact: '文件交付'
}

const assistantSourceModeLabels: Record<string, string> = {
  conversation: '普通对话',
  records: '数据中心记录',
  knowledge: '知识库文档',
  mixed: '记录与文档'
}

const canonicalAssistantExecutionAgentOf = (
  value: string | undefined
): AssistantExecutionAgentId | undefined => {
  const normalized = value?.trim().toLocaleLowerCase()
  if (!normalized) return undefined
  if (['conversation', 'conversation-agent', 'chat'].includes(normalized)) return 'conversation'
  if (
    ['data-center', 'data-center-agent', 'data', 'records', 'record', 'record-agent'].includes(normalized) ||
    /数据中心|记录|record|data-center/.test(normalized)
  ) return 'data-center'
  if (
    ['knowledge-base', 'knowledge-base-agent', 'knowledge', 'document', 'document-agent', 'kb'].includes(normalized) ||
    /知识库|文档|knowledge|document/.test(normalized)
  ) return 'knowledge-base'
  if (
    ['requirement-analysis', 'requirement-analysis-agent', 'requirement'].includes(normalized) ||
    /需求分析|requirement/.test(normalized)
  ) return 'requirement-analysis'
  if (
    ['visualization', 'visualization-agent', 'visual'].includes(normalized) ||
    /可视化|大屏|visual/.test(normalized)
  ) return 'visualization'
  if (
    ['artifact', 'artifact-agent', 'delivery'].includes(normalized) ||
    /交付物|artifact|delivery/.test(normalized)
  ) return 'artifact'
  return undefined
}

const assistantExecutionAgentLabelOf = (value: string | undefined): string | undefined => {
  const agentId = canonicalAssistantExecutionAgentOf(value)
  return agentId ? assistantExecutionAgentLabels[agentId] : undefined
}

const assistantExecutionAgentsFor = (
  sourceMode: string | undefined,
  taskType: string | undefined,
  skillId?: string
): AssistantExecutionAgentId[] => {
  const skillAgent = canonicalAssistantExecutionAgentOf(skillId)
  if (
    skillAgent === 'visualization' || skillAgent === 'requirement-analysis' || skillAgent === 'artifact'
  ) return [skillAgent]
  const normalizedTask = taskType?.trim().toLocaleLowerCase()
  const normalizedSource = sourceMode?.trim().toLocaleLowerCase()
  if (normalizedTask === 'conversation' || normalizedSource === 'conversation') return ['conversation']
  if (normalizedTask === 'knowledge_qa' || normalizedSource === 'knowledge') return ['knowledge-base']
  if (normalizedTask === 'mixed_analysis' || normalizedSource === 'mixed') {
    return ['data-center', 'knowledge-base']
  }
  if (normalizedTask === 'visualization') return ['visualization']
  if (normalizedTask === 'requirement_matching') return ['requirement-analysis']
  if (normalizedTask === 'artifact_generation') return ['artifact']
  if (normalizedTask === 'record_query' || normalizedSource === 'records') return ['data-center']
  return skillAgent ? [skillAgent] : []
}

const agentIdentifierOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return normalizedMetadataValueOf(value)
  if (!isRecordObject(value)) return undefined
  return stringPropertyOf(value, ['id', 'agentId', 'name', 'label'])
}

const agentIdentifiersPropertyOf = (
  value: Record<string, unknown>,
  keys: readonly string[]
): AssistantExecutionAgentId[] => {
  for (const key of keys) {
    const candidate = value[key]
    if (!Array.isArray(candidate)) continue
    return candidate
      .map((item) => agentIdentifierOf(item))
      .filter((item): item is string => Boolean(item))
      .map((item) => canonicalAssistantExecutionAgentOf(item))
      .filter((item): item is AssistantExecutionAgentId => Boolean(item))
  }
  return []
}

const textPropertyOf = (
  value: Record<string, unknown>,
  keys: readonly string[]
): string | undefined => {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string') {
      const normalized = normalizedMetadataValueOf(candidate)
      if (normalized) return normalized
    }
    if (isRecordObject(candidate)) {
      const nested = stringPropertyOf(candidate, ['message', 'text', 'detail'])
      if (nested) return nested
    }
  }
  return undefined
}

const assistantTaskErrorOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return normalizedMetadataValueOf(value)
  if (!isRecordObject(value)) return undefined
  return textPropertyOf(value, ['message', 'detail', 'error'])
}

const assistantTaskTraceViewFromObject = (
  raw: Record<string, unknown>,
  statusOverride?: AssistantTaskStatus
): AssistantTaskView | undefined => {
  const hasTaskFields = [
    'runId', 'status', 'primaryAgent', 'invokedAgents', 'taskType', 'sourceMode',
    'resultMode', 'startedAt', 'completedAt', 'clarificationQuestion', 'error'
  ].some((key) => key in raw)
  if (!hasTaskFields) return undefined

  const taskType = stringPropertyOf(raw, ['taskType'])
  const sourceMode = stringPropertyOf(raw, ['sourceMode'])
  const resultMode = stringPropertyOf(raw, ['resultMode'])
  const directPrimary = canonicalAssistantExecutionAgentOf(agentIdentifierOf(raw.primaryAgent))
  const directInvoked = agentIdentifiersPropertyOf(raw, ['invokedAgents'])
  const derivedAgents = assistantExecutionAgentsFor(sourceMode, taskType, agentIdentifierOf(raw.primaryAgent))
  const status = assistantTaskStatusOf(raw.status, statusOverride ?? 'pending')
  const invokedAgents: AssistantExecutionAgentId[] = [
    ...new Set<AssistantExecutionAgentId>(directInvoked.length ? directInvoked : derivedAgents)
  ]
  const primaryAgent = directPrimary ?? invokedAgents[0]
  const clarificationQuestion = textPropertyOf(raw, ['clarificationQuestion'])
  const error = assistantTaskErrorOf(raw.error)
  return {
    ...(stringPropertyOf(raw, ['runId']) ? { runId: stringPropertyOf(raw, ['runId']) } : {}),
    status,
    ...(status === 'clarification' ? {} : primaryAgent ? { primaryAgent } : {}),
    invokedAgents: status === 'clarification' ? [] : invokedAgents,
    ...(taskType ? { taskType } : {}),
    ...(sourceMode ? { sourceMode } : {}),
    ...(resultMode ? { resultMode } : {}),
    ...(stringPropertyOf(raw, ['startedAt']) ? { startedAt: stringPropertyOf(raw, ['startedAt']) } : {}),
    ...(stringPropertyOf(raw, ['completedAt']) ? { completedAt: stringPropertyOf(raw, ['completedAt']) } : {}),
    ...(clarificationQuestion ? { clarificationQuestion } : {}),
    ...(error ? { error } : {})
  }
}

const assistantTaskTraceViewOf = (
  value: unknown,
  statusOverride?: AssistantTaskStatus
): AssistantTaskView | undefined => {
  if (!isRecordObject(value)) return undefined
  if (isRecordObject(value.taskTrace)) {
    return assistantTaskTraceViewFromObject(value.taskTrace, statusOverride)
  }
  return assistantTaskTraceViewFromObject(value, statusOverride)
}

const assistantIntentTaskTraceViewOf = (
  value: unknown,
  statusOverride?: AssistantTaskStatus
): AssistantTaskView | undefined => {
  if (!isRecordObject(value) || !isRecordObject(value.assistantIntent)) return undefined
  const intent = value.assistantIntent
  const taskType = stringPropertyOf(intent, ['taskType'])
  const sourceMode = stringPropertyOf(intent, ['sourceMode'])
  const resultMode = stringPropertyOf(intent, ['resultMode'])
  const skillId = stringPropertyOf(intent, ['skillId'])
  if (!taskType && !sourceMode && !resultMode && !skillId) return undefined
  const status = intent.needsClarification === true
    ? 'clarification'
    : assistantTaskStatusOf(undefined, statusOverride ?? 'completed')
  const agents = assistantExecutionAgentsFor(sourceMode, taskType, skillId)
  return {
    status,
    ...(status === 'clarification' ? {} : agents[0] ? { primaryAgent: agents[0] } : {}),
    invokedAgents: status === 'clarification' ? [] : agents,
    ...(taskType ? { taskType } : {}),
    ...(sourceMode ? { sourceMode } : {}),
    ...(resultMode ? { resultMode } : {}),
    ...(textPropertyOf(intent, ['clarificationQuestion'])
      ? { clarificationQuestion: textPropertyOf(intent, ['clarificationQuestion']) }
      : {})
  }
}

const assistantEventTaskTraceViewOf = (
  value: unknown,
  statusOverride: AssistantTaskStatus = 'running'
): AssistantTaskView | undefined => {
  if (!isRecordObject(value)) return undefined
  const metadata = isRecordObject(value.metadata) ? value.metadata : undefined
  return metadata
    ? assistantTaskTraceViewFromObject(metadata, statusOverride)
    : assistantTaskTraceViewFromObject(value, statusOverride)
}

const assistantExpertTaskTraceViewOf = (
  value: unknown,
  statusOverride: AssistantTaskStatus
): AssistantTaskView | undefined => {
  if (!isRecordObject(value)) return undefined
  const expertId = stringPropertyOf(value, ['expertId'])
  const agent = canonicalAssistantExecutionAgentOf(expertId)
  if (agent !== 'visualization' && agent !== 'requirement-analysis') return undefined
  return {
    status: statusOverride,
    primaryAgent: agent,
    invokedAgents: [agent],
    taskType: agent === 'visualization' ? 'visualization' : 'requirement_matching',
    sourceMode: 'records',
    resultMode: agent === 'visualization' ? 'dashboard' : 'answer'
  }
}

const mergeAssistantTaskTraceViews = (
  ...tasks: Array<AssistantTaskView | undefined | null>
): AssistantTaskView | undefined => {
  const available = tasks.filter((task): task is AssistantTaskView => Boolean(task))
  if (!available.length) return undefined
  const merged = available.reduce<AssistantTaskView>((current, next) => ({
    ...current,
    ...next,
    invokedAgents: [...new Set([...current.invokedAgents, ...next.invokedAgents])]
  }), { invokedAgents: [] })
  if (merged.status === 'clarification') {
    merged.invokedAgents = []
    delete merged.primaryAgent
  }
  return merged
}

const assistantTaskTraceForMessage = (
  message: ChatMessage,
  metadata?: AgentRunMetadata
): AssistantTaskView | undefined => {
  const fallbackStatus: AssistantTaskStatus = message.contextOutcome === 'failed'
    ? 'failed'
    : message.contextOutcome === 'undone'
      ? 'cancelled'
      : 'completed'
  const metadataTaskTrace = metadata && (
    metadata.skill || metadata.taskType || metadata.sourceMode || metadata.resultMode
  )
    ? assistantTaskTraceViewFromObject({
        taskType: metadata.taskType,
        sourceMode: metadata.sourceMode,
        resultMode: metadata.resultMode,
        ...(metadata.skill ? { primaryAgent: metadata.skill } : {})
      }, fallbackStatus)
    : undefined
  return mergeAssistantTaskTraceViews(
    assistantExpertTaskTraceViewOf(message, fallbackStatus),
    assistantIntentTaskTraceViewOf(message, fallbackStatus),
    metadataTaskTrace,
    assistantTaskTraceViewOf(message, fallbackStatus)
  )
}

const assistantTaskTraceLabelOf = (
  value: string | undefined,
  labels: Record<string, string>
): string | undefined => readableAgentValueOf(value, labels)

const shortTraceIdOf = (runId: string | undefined): string | undefined => {
  const normalized = runId?.trim()
  if (!normalized) return undefined
  return normalized.length > 10 ? normalized.slice(0, 8) : normalized
}

const assistantTaskTracePayloadOf = (
  task: AssistantTaskView | undefined,
  fallbackStatus: AssistantTaskStatus
): AssistantTaskTrace | undefined => {
  if (!task?.runId || !task.primaryAgent || !task.taskType || !task.sourceMode || !task.resultMode) return undefined
  const status = task.status ?? fallbackStatus
  if (!['completed', 'clarification', 'failed', 'cancelled'].includes(status)) return undefined
  return {
    runId: task.runId,
    status: status as AssistantTaskTrace['status'],
    primaryAgent: task.primaryAgent,
    invokedAgents: status === 'clarification' ? [] : task.invokedAgents,
    taskType: task.taskType as AssistantTaskTrace['taskType'],
    sourceMode: task.sourceMode as AssistantTaskTrace['sourceMode'],
    resultMode: task.resultMode as AssistantTaskTrace['resultMode'],
    startedAt: task.startedAt ?? new Date().toISOString(),
    completedAt: task.completedAt ?? new Date().toISOString(),
    ...(task.clarificationQuestion ? { clarificationQuestion: task.clarificationQuestion } : {}),
    ...(task.error ? { error: { code: 'ASSISTANT_TASK_FAILED', message: task.error } } : {})
  }
}

function AgentTaskSummary({
  task,
  className = ''
}: {
  task?: AssistantTaskView | null
  className?: string
}): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const status = task?.status ?? 'running'
  const statusLabel = assistantTaskStatusLabels[status]
  const statusClass = assistantTaskStatusClassOf(status)
  const isClarification = status === 'clarification'
  const isCancelled = status === 'cancelled'
  const primaryLabel = isClarification
    ? '尚未执行'
    : assistantExecutionAgentLabelOf(task?.primaryAgent) ?? (isCancelled ? '未选定' : '路由中')
  const invokedLabels = (task?.invokedAgents ?? [])
    .map((agent) => assistantExecutionAgentLabels[agent])
    .filter((label, index, labels) => labels.indexOf(label) === index)
  const invokedLabel = isClarification
    ? '暂无（等待补充）'
      : invokedLabels.length
          ? invokedLabels.join('、')
          : status === 'running' || status === 'pending'
            ? '选择中'
            : isCancelled
              ? '未执行'
              : '未记录'
  const taskTypeLabel = assistantTaskTraceLabelOf(task?.taskType, assistantTaskTypeLabels)
  const sourceModeLabel = assistantTaskTraceLabelOf(task?.sourceMode, assistantSourceModeLabels)
  const resultModeLabel = assistantTaskTraceLabelOf(task?.resultMode, assistantResultModeLabels)
  const traceId = shortTraceIdOf(task?.runId)
  const summaryDetails = [primaryLabel, taskTypeLabel, sourceModeLabel]
    .filter(Boolean)
    .join(' · ')
  return (
    <details
      className={`agent-task-summary ${className}`.trim()}
      role="group"
      aria-label="Agent 任务摘要"
      open={detailsOpen}
      onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
    >
      <summary className={`agent-task-summary-summary status-${statusClass}`} aria-expanded={detailsOpen}>
        <span className="agent-task-summary-summary-title">Agent 任务 · {statusLabel}</span>
        <span className="agent-task-summary-summary-copy">{summaryDetails}</span>
        {traceId && <span className="agent-task-trace">追踪 {traceId}</span>}
        <span className="agent-task-summary-summary-action">{detailsOpen ? '收起详情' : '查看详情'}</span>
      </summary>
      <div className="agent-task-summary-detail-body">
        <div className="agent-task-summary-grid">
          <div className="agent-task-summary-item">
            <span>主执行 Agent</span>
            <strong>{primaryLabel}</strong>
          </div>
          <div className="agent-task-summary-item">
            <span>参与 Agent</span>
            <strong>{invokedLabel}</strong>
          </div>
          <div className={`agent-task-summary-item status ${statusClass}`}>
            <span>任务状态</span>
            <strong>{statusLabel}</strong>
          </div>
        </div>
        {(taskTypeLabel || sourceModeLabel || resultModeLabel || task?.error) && (
          <div className="agent-task-summary-details" aria-label="任务轨迹详情">
            {taskTypeLabel && <span>任务：{taskTypeLabel}</span>}
            {sourceModeLabel && <span>来源：{sourceModeLabel}</span>}
            {resultModeLabel && <span>交付：{resultModeLabel}</span>}
            {task?.error && <span className="agent-task-summary-error">错误：{task.error}</span>}
          </div>
        )}
      </div>
    </details>
  )
}

/**
 * Keep the local name readable while using the exact shared plan patch
 * contract. The main process remains the authority for canonicalization and
 * validation; the renderer deliberately sends only fields the user can edit.
 */
type AssistantPlanPatchInput = AssistantPlanPatch

type AssistantPlanDraft = {
  searchTerms: string[]
  fields: string[]
  projectIds: string[]
  nodeTypes: string[]
  baseFilters: AssistantPlanFilter[]
  filters: AssistantPlanFilter[]
  limit: number | null
  resultMode: AssistantExecutionSummary['resultMode']
}

type AssistantPlanValidationIssue = {
  field: string
  code: string
  message: string
}

type AssistantPlanSummaryExtras = AssistantExecutionSummary & {
  groupEntities?: string[]
  groupByField?: string
  metric?: string
  searchMode?: string
}

const assistantPlanFilterOperators: Array<{
  value: AssistantPlanFilterOperator
  label: string
}> = [
  { value: 'equals', label: '等于' },
  { value: 'not_equals', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'not_contains', label: '不包含' },
  { value: 'is_empty', label: '为空' },
  { value: 'not_empty', label: '不为空' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' }
]

const assistantPlanFilterOperatorAliases: Record<string, AssistantPlanFilterOperator> = {
  equals: 'equals',
  not_equals: 'not_equals',
  notEquals: 'not_equals',
  contains: 'contains',
  not_contains: 'not_contains',
  notContains: 'not_contains',
  is_empty: 'is_empty',
  empty: 'is_empty',
  not_empty: 'not_empty',
  notEmpty: 'not_empty',
  gt: 'gt',
  greaterThan: 'gt',
  gte: 'gte',
  greaterThanOrEqual: 'gte',
  lt: 'lt',
  lessThan: 'lt',
  lte: 'lte',
  lessThanOrEqual: 'lte'
}

const assistantPlanOperatorOf = (value: string): AssistantPlanFilterOperator => (
  assistantPlanFilterOperatorAliases[value.trim()] ?? 'equals'
)

const assistantPlanFilterOf = (
  filter: { field: string; operator: string; value?: unknown }
): AssistantPlanFilter => {
  const operator = assistantPlanOperatorOf(filter.operator)
  if (operator === 'is_empty' || operator === 'not_empty') {
    return { field: String(filter.field ?? ''), operator }
  }
  return {
    field: String(filter.field ?? ''),
    operator,
    value: filter.value === undefined ? '' : String(filter.value)
  }
}

const assistantPlanSummaryExtrasOf = (
  summary: AssistantExecutionSummary
): AssistantPlanSummaryExtras => summary as AssistantPlanSummaryExtras

const assistantPlanDraftOf = (summary: AssistantExecutionSummary): AssistantPlanDraft => ({
  searchTerms: [...(summary.searchTerms ?? [])],
  fields: [...(summary.fields ?? [])],
  projectIds: [...(summary.scope?.projectIds ?? [])],
  nodeTypes: [...(summary.scope?.nodeTypes ?? [])],
  baseFilters: (summary.scope?.baseFilters ?? []).map(assistantPlanFilterOf),
  filters: (summary.filters ?? []).map(assistantPlanFilterOf),
  limit: Number.isFinite(summary.limit) ? summary.limit : 1,
  resultMode: summary.resultMode
})

const assistantPlanArraysEqual = (left: string[], right: string[]): boolean => (
  left.length === right.length && left.every((value, index) => value === right[index])
)

const assistantPlanFiltersEqual = (
  left: AssistantPlanFilter[],
  right: AssistantPlanFilter[]
): boolean => JSON.stringify(left) === JSON.stringify(right)

const assistantPlanCapabilitiesOf = (summary: AssistantExecutionSummary): {
  searchTerms: boolean
  fields: boolean
  scope: boolean
  filters: boolean
  limit: boolean
  resultMode: AssistantExecutionSummary['resultMode'][]
} => {
  const extras = assistantPlanSummaryExtrasOf(summary)
  const isRecordsSource = summary.sourceMode === 'records' || summary.sourceMode === 'mixed'
  const isKnowledge = summary.sourceMode === 'knowledge' && summary.taskType === 'knowledge_qa'
  const isRequirementMatching = summary.taskType === 'requirement_matching'
  const isVisualization = summary.taskType === 'visualization'
  const resultMode: AssistantExecutionSummary['resultMode'][] = (
    summary.taskType === 'record_query' && summary.sourceMode === 'records'
  )
    ? ['answer', 'list', ...(extras.groupEntities?.length ? ['grouped_list' as const] : []), 'table']
    : summary.taskType === 'knowledge_qa' && summary.sourceMode === 'knowledge'
      ? ['answer']
      : summary.taskType === 'mixed_analysis' && summary.sourceMode === 'mixed'
        ? ['answer', 'list', ...(extras.groupEntities?.length ? ['grouped_list' as const] : []), 'table']
        : isVisualization && summary.sourceMode === 'records'
          ? ['dashboard']
          : isRequirementMatching && summary.sourceMode === 'records'
            ? ['answer']
            : [summary.resultMode]
  return {
    // These capabilities mirror the main-process supportedPatchField matrix.
    // Requirement matching and visualization keep their fixed execution
    // semantics; only their data scope can be adjusted in this version.
    searchTerms: (isKnowledge || isRecordsSource) && !isVisualization && !isRequirementMatching,
    fields: isRecordsSource && !isVisualization && !isRequirementMatching,
    scope: isRecordsSource,
    filters: isRecordsSource && !isVisualization && !isRequirementMatching,
    limit: (isRecordsSource && !isVisualization && !isRequirementMatching) || summary.sourceMode === 'knowledge',
    resultMode
  }
}

const assistantPlanPatchOf = (
  summary: AssistantExecutionSummary,
  draft: AssistantPlanDraft,
  capabilities: ReturnType<typeof assistantPlanCapabilitiesOf>
): AssistantPlanPatchInput => {
  const model = assistantPlanDraftOf(summary)
  const patch: AssistantPlanPatchInput = {}
  if (capabilities.searchTerms && !assistantPlanArraysEqual(draft.searchTerms, model.searchTerms)) {
    patch.searchTerms = [...draft.searchTerms]
  }
  if (capabilities.fields && !assistantPlanArraysEqual(draft.fields, model.fields)) {
    patch.fields = [...draft.fields]
  }
  if (capabilities.scope) {
    const scope: NonNullable<AssistantPlanPatchInput['scope']> = {}
    if (!assistantPlanArraysEqual(draft.projectIds, model.projectIds)) scope.projectIds = [...draft.projectIds]
    if (!assistantPlanArraysEqual(draft.nodeTypes, model.nodeTypes)) scope.nodeTypes = [...draft.nodeTypes]
    if (!assistantPlanFiltersEqual(draft.baseFilters, model.baseFilters)) scope.baseFilters = [...draft.baseFilters]
    if (Object.keys(scope).length) patch.scope = scope
  }
  if (capabilities.filters && !assistantPlanFiltersEqual(draft.filters, model.filters)) {
    patch.filters = [...draft.filters]
  }
  if (capabilities.limit && draft.limit !== model.limit) {
    patch.limit = draft.limit === null ? Number.NaN : draft.limit
  }
  if (capabilities.resultMode.includes(draft.resultMode) && draft.resultMode !== model.resultMode) {
    patch.resultMode = draft.resultMode
  }
  return patch
}

const assistantPlanIssueMatches = (issueField: string, field: string): boolean => {
  const normalizedIssue = issueField.trim().toLocaleLowerCase()
  const normalizedField = field.trim().toLocaleLowerCase()
  return normalizedIssue === normalizedField ||
    normalizedIssue.startsWith(`${normalizedField}.`) ||
    normalizedIssue.startsWith(`${normalizedField}[`)
}

function AssistantExecutionPlanCard({
  summary,
  pending,
  confirming,
  cancelling,
  expired = false,
  projects,
  nodeTypes,
  metadataLoading = false,
  metadataError,
  errors = [],
  warnings = [],
  onConfirm,
  onCancel,
  onClearIssues
}: {
  summary: AssistantExecutionSummary
  pending: boolean
  confirming: boolean
  cancelling: boolean
  expired?: boolean
  projects: ProjectRow[]
  nodeTypes: string[]
  metadataLoading?: boolean
  metadataError?: string
  errors?: AssistantPlanValidationIssue[]
  warnings?: AssistantPlanValidationIssue[]
  onConfirm: (patch: AssistantPlanPatchInput) => void | Promise<void>
  onCancel: () => void
  onClearIssues?: () => void
}): React.JSX.Element {
  const capabilities = assistantPlanCapabilitiesOf(summary)
  const modelDraft = useMemo(() => assistantPlanDraftOf(summary), [summary])
  const [draft, setDraft] = useState<AssistantPlanDraft>(modelDraft)
  const [editing, setEditing] = useState(pending)

  useEffect(() => {
    setDraft(modelDraft)
    setEditing(pending)
  }, [modelDraft, pending])

  const patch = useMemo(
    () => assistantPlanPatchOf(summary, draft, capabilities),
    [capabilities, draft, summary]
  )
  const dirty = Object.keys(patch).length > 0
  const extras = assistantPlanSummaryExtrasOf(summary)
  const fieldOptions = [...new Set([
    ...draft.fields,
    ...draft.filters.map((filter) => filter.field),
    ...draft.baseFilters.map((filter) => filter.field)
  ].map((value) => value.trim()).filter(Boolean))]
  const projectOptions = [
    ...projects.map((project) => ({ label: `${project.name} · ${project.uid}`, value: project.uid })),
    ...draft.projectIds
      .filter((id) => !projects.some((project) => project.uid === id))
      .map((id) => ({ label: id, value: id, disabled: true }))
  ]
  const nodeTypeOptions = [...new Set([...nodeTypes, ...draft.nodeTypes])].map((value) => ({
    label: value,
    value,
    ...(nodeTypes.includes(value) ? {} : { disabled: true })
  }))

  const updateDraft = (next: Partial<AssistantPlanDraft>): void => {
    setDraft((current) => ({ ...current, ...next }))
  }
  const updateFilter = (
    group: 'baseFilters' | 'filters',
    index: number,
    next: Partial<AssistantPlanFilter>
  ): void => {
    setDraft((current) => ({
      ...current,
      [group]: current[group].map((filter, filterIndex) => (
        filterIndex === index ? { ...filter, ...next } : filter
      ))
    }))
  }
  const removeFilter = (group: 'baseFilters' | 'filters', index: number): void => {
    setDraft((current) => ({
      ...current,
      [group]: current[group].filter((_filter, filterIndex) => filterIndex !== index)
    }))
  }
  const addFilter = (group: 'baseFilters' | 'filters'): void => {
    if (draft.baseFilters.length + draft.filters.length >= 10) return
    setDraft((current) => ({
      ...current,
      [group]: [
        ...current[group],
        { field: fieldOptions[0] ?? '', operator: 'equals', value: '' }
      ]
    }))
  }
  const issueTextFor = (field: string): string[] => errors
    .filter((issue) => assistantPlanIssueMatches(issue.field, field))
    .map((issue) => issue.message)
  const fixedFact = (label: string, value: string, className = ''): React.JSX.Element => (
    <div className={`agent-plan-fixed-fact ${className}`.trim()}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  )
  const renderFilterEditor = (
    group: 'baseFilters' | 'filters',
    label: string,
    helper: string
  ): React.JSX.Element => {
    const filters = draft[group]
    const groupIssueField = group === 'baseFilters' ? 'scope.baseFilters' : 'filters'
    return (
      <div className="agent-plan-editor-section agent-plan-filter-section">
        <div className="agent-plan-editor-heading">
          <div>
            <strong>{label}</strong>
            <small>{helper}</small>
          </div>
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined aria-hidden="true" />}
            onClick={() => addFilter(group)}
            disabled={!editing || confirming || filters.length + draft[group === 'filters' ? 'baseFilters' : 'filters'].length >= 10}
            aria-label={`添加${label}`}
          >
            添加条件
          </Button>
        </div>
        {filters.length === 0 ? (
          <Text type="secondary">无条件</Text>
        ) : (
          <div className="agent-plan-filter-list">
            {filters.map((filter, index) => {
              const noValue = filter.operator === 'is_empty' || filter.operator === 'not_empty'
              const rowField = `${group}[${index}]`
              const rowErrors = [
                ...issueTextFor(rowField),
                ...issueTextFor(`${group}.${index}`),
                ...issueTextFor(`${groupIssueField}[${index}]`),
                ...issueTextFor(`${groupIssueField}.${index}`),
                ...issueTextFor(`${group}[${index}].field`),
                ...issueTextFor(`${group}[${index}].operator`),
                ...issueTextFor(`${group}[${index}].value`)
              ]
              return (
                <div className="agent-plan-filter-row" key={`${group}-${index}`}>
                  <Select
                    mode="tags"
                    showSearch
                    allowClear
                    value={filter.field ? [filter.field] : []}
                    options={fieldOptions.map((field) => ({ label: field, value: field }))}
                    maxCount={1}
                    tokenSeparators={[',', '，', '、']}
                    placeholder="选择或输入字段 Key"
                    optionFilterProp="label"
                    disabled={!editing || confirming}
                    aria-label={`${label}第 ${index + 1} 条字段`}
                    onChange={(values) => updateFilter(group, index, {
                      field: Array.isArray(values) ? String(values.at(-1) ?? '') : ''
                    })}
                  />
                  <Select
                    value={filter.operator}
                    options={assistantPlanFilterOperators}
                    disabled={!editing || confirming}
                    aria-label={`${label}第 ${index + 1} 条操作符`}
                    onChange={(value) => {
                      const operator = assistantPlanOperatorOf(String(value))
                      updateFilter(group, index, {
                        operator,
                        ...(operator === 'is_empty' || operator === 'not_empty' ? { value: undefined } : { value: filter.value ?? '' })
                      })
                    }}
                  />
                  <Input
                    value={noValue ? undefined : filter.value ?? ''}
                    disabled={!editing || confirming || noValue}
                    placeholder={noValue ? '无需填写值' : '输入值'}
                    aria-label={`${label}第 ${index + 1} 条匹配值`}
                    onChange={(event) => updateFilter(group, index, { value: event.target.value })}
                  />
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined aria-hidden="true" />}
                    onClick={() => removeFilter(group, index)}
                    disabled={!editing || confirming}
                    aria-label={`删除${label}第 ${index + 1} 条`}
                  />
                  {rowErrors.length > 0 && <small className="agent-plan-field-error">{[...new Set(rowErrors)].join('；')}</small>}
                </div>
              )
            })}
          </div>
        )}
        {issueTextFor(groupIssueField).map((text) => (
          <small className="agent-plan-field-error" key={`${groupIssueField}-${text}`}>{text}</small>
        ))}
      </div>
    )
  }

  const canEdit = pending && !expired
  const statusLabel = expired
    ? '计划已失效'
    : pending
      ? (editing ? '编辑中，尚未执行工具' : '等待确认后执行工具')
      : '范围已确认，正在执行'
  return (
    <section
      className={`agent-execution-summary agent-plan-card ${pending ? 'is-pending' : 'is-confirmed'} ${expired ? 'is-expired' : ''}`.trim()}
      aria-label="执行计划确认卡片"
    >
      <div className="agent-plan-card-heading">
        <div>
          <strong>执行计划</strong>
          <small>{statusLabel}</small>
        </div>
        <div className="agent-plan-heading-actions">
          {canEdit && !editing && (
            <Button
              type="text"
              size="small"
              onClick={() => {
                setEditing(true)
                onClearIssues?.()
              }}
              disabled={confirming}
            >
              编辑计划
            </Button>
          )}
          {canEdit && editing && (
            <Button
              type="text"
              size="small"
              onClick={() => {
                setDraft(modelDraft)
                setEditing(true)
                onClearIssues?.()
              }}
              disabled={confirming || !dirty}
            >
              恢复模型计划
            </Button>
          )}
        </div>
      </div>
      <div className="agent-execution-summary-body agent-plan-card-body">
        <div className="agent-plan-fixed-grid" aria-label="计划固定事实">
          {fixedFact('用户问题', summary.question, 'is-question')}
          {fixedFact('来源模式', assistantSourceModeLabels[summary.sourceMode] ?? summary.sourceMode)}
          {fixedFact('任务类型', assistantTaskTypeLabels[summary.taskType] ?? summary.taskType)}
          {fixedFact('计划意图', agentIntentLabels[summary.intent] ?? summary.intent)}
          {summary.scope.snapshotAt ? fixedFact('范围快照', summary.scope.snapshotAt) : null}
          {extras.groupEntities?.length ? fixedFact('分组实体', extras.groupEntities.join('、')) : null}
          {extras.groupByField ? fixedFact('分组字段', extras.groupByField) : null}
          {extras.sort ? fixedFact('排序', `${extras.sort.field} · ${extras.sort.direction === 'asc' ? '升序' : '降序'}`) : null}
          {extras.metric ? fixedFact('指标', extras.metric) : null}
          {extras.searchMode ? fixedFact('搜索模式', extras.searchMode === 'all' ? '全部匹配' : '任一匹配') : null}
          {capabilities.resultMode.length === 1
            ? fixedFact('交付形式', assistantResultModeLabels[capabilities.resultMode[0]] ?? capabilities.resultMode[0])
            : null}
        </div>

        {canEdit && editing ? (
          <div className="agent-plan-editors" aria-label="可编辑执行计划">
            {capabilities.searchTerms && (
              <div className="agent-plan-editor-section">
                <label htmlFor="agent-plan-search-terms">检索词</label>
                <Select
                  id="agent-plan-search-terms"
                  mode="tags"
                  value={draft.searchTerms}
                  options={draft.searchTerms.map((term) => ({ label: term, value: term }))}
                  tokenSeparators={[',', '，', '、']}
                  maxCount={10}
                  placeholder="输入后按 Enter 添加，最多 10 项"
                  disabled={confirming}
                  aria-label="检索词"
                  onChange={(values) => updateDraft({ searchTerms: Array.isArray(values) ? values.map(String).slice(0, 10) : [] })}
                />
                {issueTextFor('searchTerms').map((text) => <small className="agent-plan-field-error" key={`searchTerms-${text}`}>{text}</small>)}
              </div>
            )}
            {capabilities.fields && (
              <div className="agent-plan-editor-section">
                <label htmlFor="agent-plan-fields">读取字段</label>
                <Select
                  id="agent-plan-fields"
                  mode="tags"
                  value={draft.fields}
                  options={fieldOptions.map((field) => ({ label: field, value: field }))}
                  tokenSeparators={[',', '，', '、']}
                  maxCount={20}
                  placeholder="选择或输入字段 Key，最多 20 项"
                  disabled={confirming}
                  aria-label="读取字段"
                  onChange={(values) => updateDraft({ fields: Array.isArray(values) ? values.map(String).slice(0, 20) : [] })}
                />
                <small className="agent-plan-editor-hint">字段目录不可用时可输入字段 Key，确认时由主进程校验。</small>
                {issueTextFor('fields').map((text) => <small className="agent-plan-field-error" key={`fields-${text}`}>{text}</small>)}
              </div>
            )}
            {capabilities.scope && (
              <div className="agent-plan-scope-grid">
                <div className="agent-plan-editor-section">
                  <label htmlFor="agent-plan-projects">项目范围</label>
                  <Select
                    id="agent-plan-projects"
                    mode="multiple"
                    allowClear
                    showSearch
                    value={draft.projectIds}
                    options={projectOptions}
                    optionFilterProp="label"
                    maxTagCount="responsive"
                    placeholder={metadataLoading ? '正在读取项目目录…' : '全部项目'}
                    disabled={confirming || metadataLoading}
                    aria-label="项目范围"
                    onChange={(values) => updateDraft({ projectIds: Array.isArray(values) ? values.map(String).slice(0, 100) : [] })}
                  />
                  {metadataError && <small className="agent-plan-field-error">{metadataError}</small>}
                  {issueTextFor('scope.projectIds').map((text) => <small className="agent-plan-field-error" key={`projects-${text}`}>{text}</small>)}
                </div>
                <div className="agent-plan-editor-section">
                  <label htmlFor="agent-plan-node-types">数据类型</label>
                  <Select
                    id="agent-plan-node-types"
                    mode="multiple"
                    allowClear
                    showSearch
                    value={draft.nodeTypes}
                    options={nodeTypeOptions}
                    optionFilterProp="label"
                    maxTagCount="responsive"
                    placeholder={metadataLoading ? '正在读取类型目录…' : '全部类型'}
                    disabled={confirming || metadataLoading}
                    aria-label="数据类型"
                    onChange={(values) => updateDraft({ nodeTypes: Array.isArray(values) ? values.map(String).slice(0, 100) : [] })}
                  />
                  {issueTextFor('scope.nodeTypes').map((text) => <small className="agent-plan-field-error" key={`nodeTypes-${text}`}>{text}</small>)}
                </div>
              </div>
            )}
            {capabilities.filters && (
              <>
                {renderFilterEditor('filters', '计划筛选条件', '本轮查询条件；与范围筛选按 AND 合并。')}
                {renderFilterEditor('baseFilters', '范围筛选条件', '继承范围条件；清空表示不追加该组条件。')}
              </>
            )}
            <div className="agent-plan-scope-grid">
              {capabilities.limit ? (
                <div className="agent-plan-editor-section">
                  <label htmlFor="agent-plan-limit">结果上限</label>
                  <InputNumber
                    id="agent-plan-limit"
                    min={1}
                    max={50}
                    precision={0}
                    value={draft.limit}
                    disabled={confirming}
                    aria-label="结果上限"
                    onChange={(value) => updateDraft({ limit: value })}
                  />
                  {issueTextFor('limit').map((text) => <small className="agent-plan-field-error" key={`limit-${text}`}>{text}</small>)}
                </div>
              ) : (
                fixedFact('结果上限', `${summary.limit} 条`)
              )}
              {capabilities.resultMode.length > 1 && (
                <div className="agent-plan-editor-section">
                  <label htmlFor="agent-plan-result-mode">兼容交付形式</label>
                  <Select
                    id="agent-plan-result-mode"
                    value={draft.resultMode}
                    options={capabilities.resultMode.map((mode) => ({ label: assistantResultModeLabels[mode] ?? mode, value: mode }))}
                    disabled={confirming}
                    aria-label="兼容交付形式"
                    onChange={(value) => updateDraft({ resultMode: value as AssistantExecutionSummary['resultMode'] })}
                  />
                  {issueTextFor('resultMode').map((text) => <small className="agent-plan-field-error" key={`resultMode-${text}`}>{text}</small>)}
                </div>
              )}
            </div>
            {errors.length > 0 && (
              <div className="agent-plan-validation-summary" role="alert" aria-live="assertive">
                <strong>计划校验未通过，请修正后重试。</strong>
                {errors.map((issue, index) => (
                  <span key={`${issue.field}-${issue.code}-${index}`}>{issue.field ? `${issue.field}：` : ''}{issue.message}</span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="agent-plan-readonly-values" aria-label="计划参数">
            {capabilities.searchTerms && fixedFact('检索词', summary.searchTerms.join('、') || '无全文检索词')}
            {capabilities.fields && fixedFact('读取字段', summary.fields.join('、') || '按任务所需字段')}
            {capabilities.scope && fixedFact('项目范围', summary.scope.projectIds.join('、') || '全部项目')}
            {capabilities.scope && fixedFact('数据类型', summary.scope.nodeTypes.join('、') || '全部类型')}
            {capabilities.scope && fixedFact('记录范围', summary.scope.recordCount === undefined ? '当前范围全部记录' : `${summary.scope.recordCount} 条指定记录`)}
            {fixedFact('结果上限', `${summary.limit} 条`)}
            {fixedFact('交付形式', assistantResultModeLabels[summary.resultMode] ?? summary.resultMode)}
            {capabilities.filters && (
              <div className="agent-plan-readonly-filters">
                <span>筛选条件</span>
                <div>
                  {[...summary.scope.baseFilters, ...summary.filters].length
                    ? [...summary.scope.baseFilters, ...summary.filters].map((filter, index) => (
                        <Tag key={`${filter.field}-${filter.operator}-${index}`}>
                          {filter.field} {assistantPlanFilterOperators.find((option) => option.value === assistantPlanOperatorOf(filter.operator))?.label ?? filter.operator}{filter.value === undefined ? '' : ` ${filter.value}`}
                        </Tag>
                      ))
                    : <Text type="secondary">无额外筛选条件</Text>}
                </div>
              </div>
            )}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="agent-plan-warning-list" role="status" aria-live="polite">
            {warnings.map((warning) => <span key={`${warning.field}-${warning.code}`}>{warning.field ? `${warning.field}：` : ''}{warning.message}</span>)}
          </div>
        )}
        <div className="agent-execution-summary-actions agent-plan-actions">
          {pending && !expired ? (
            <>
              <Button
                type="primary"
                size="small"
                loading={confirming}
                disabled={!editing || confirming}
                onClick={() => void onConfirm(patch)}
              >
                确认并执行
              </Button>
              <Button
                size="small"
                danger
                onClick={onCancel}
                disabled={cancelling}
              >
                取消任务
              </Button>
            </>
          ) : expired ? (
            <>
              <Tag color="error" icon={<ExclamationCircleOutlined />}>执行计划已失效，请重新提交问题</Tag>
              <Button size="small" danger onClick={onCancel} disabled={cancelling}>取消任务</Button>
            </>
          ) : (
            <Tag color="success" icon={<CheckCircleOutlined />}>已确认</Tag>
          )}
        </div>
      </div>
    </section>
  )
}

const semanticTaskStatusLabels: Record<SemanticizationTaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  pausing: '暂停中',
  paused: '已暂停',
  stopping: '停止中',
  stopped: '已停止',
  completed: '已完成'
}

const semanticTaskStageLabels: Record<SemanticizationTaskStage, string> = {
  queued: '等待开始',
  initial: '初步分析',
  independent: '独立复核',
  adjudication: '结果裁决',
  persisting: '保存语义卡片',
  idle: '空闲'
}

type SemanticTaskMode = 'standard' | 'strict'

const semanticTaskModeOf = (
  task: Pick<SemanticizationTaskSnapshot, 'deepThinking' | 'qualityMode'>
): SemanticTaskMode => {
  if (task.qualityMode === 'standard' || task.qualityMode === 'strict') return task.qualityMode
  // Older snapshots only carry deepThinking; retain that IPC/storage meaning.
  return task.deepThinking === false ? 'standard' : 'strict'
}

const semanticTaskModeLabelOf = (mode: SemanticTaskMode): string => (
  mode === 'standard' ? '标准模式' : '严格模式'
)

const semanticTaskModeDescriptionOf = (mode: SemanticTaskMode): string => (
  mode === 'standard'
    ? '标准模式：单次结构化提取，校验失败才定向修复'
    : '严格模式：启用深度思考，独立复核，仅分歧/低置信时裁决'
)

const semanticTaskActiveStatuses: SemanticizationTaskStatus[] = [
  'queued',
  'running',
  'pausing',
  'paused',
  'stopping'
]

const semanticTaskThinkingStorageKey = 'visslm:semanticization-deep-thinking:v1'

const readSemanticDeepThinking = (): boolean => {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(semanticTaskThinkingStorageKey)
    return raw === null ? false : raw !== 'false'
  } catch {
    return false
  }
}

const writeSemanticDeepThinking = (value: boolean): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(semanticTaskThinkingStorageKey, String(value))
  } catch {
    // Local preferences are optional; the task remains usable when storage is unavailable.
  }
}

const semanticTaskCurrentUid = (task: SemanticizationTaskSnapshot | null): string | undefined => {
  return task?.currentRecord?.uid
}

const semanticTaskCurrentName = (task: SemanticizationTaskSnapshot | null): string => {
  if (task) {
    const activeCount = semanticTaskActiveCountOf(task)
    if (activeCount !== undefined && activeCount > 1) {
      return `${semanticTaskFocusNameOf(task)} 等 ${activeCount} 条`
    }
  }
  if (task?.currentRecord) return task.currentRecord.name || task.currentRecord.itemId
  if (task?.status === 'paused') return '等待恢复任务'
  if (task?.status === 'completed' || task?.status === 'stopped') return '无正在处理的记录'
  return '等待下一条记录'
}

const semanticTaskCurrentIndex = (task: SemanticizationTaskSnapshot): number => {
  if (task.currentRecord) return task.currentRecord.index
  return Math.min(task.total || 1, task.completed + 1)
}

const semanticTaskFiniteNumberOf = (value: number | undefined): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
)

const semanticTaskPositiveIntegerOf = (value: number | undefined): number | undefined => {
  const finite = semanticTaskFiniteNumberOf(value)
  return finite !== undefined && finite > 0 ? Math.floor(finite) : undefined
}

const semanticTaskActiveCountOf = (task: SemanticizationTaskSnapshot): number | undefined => {
  const activeCount = semanticTaskFiniteNumberOf(task.activeCount)
  if (activeCount !== undefined && activeCount >= 0) return Math.floor(activeCount)
  return Array.isArray(task.activeRecords) ? task.activeRecords.length : undefined
}

const semanticTaskConcurrencyLimitOf = (task: SemanticizationTaskSnapshot): number | undefined => (
  semanticTaskPositiveIntegerOf(task.maxConcurrency)
)

const semanticTaskFocusNameOf = (task: SemanticizationTaskSnapshot): string => (
  task.currentRecord?.name
    || task.currentRecord?.itemId
    || task.activeRecords?.[0]?.name
    || task.activeRecords?.[0]?.itemId
    || '当前记录'
)

const semanticTaskCurrentIndexLabelOf = (task: SemanticizationTaskSnapshot): string => {
  const activeCount = semanticTaskActiveCountOf(task)
  if (activeCount !== undefined && activeCount > 1) {
    const maxConcurrency = semanticTaskConcurrencyLimitOf(task)
    return maxConcurrency !== undefined
      ? `并行 ${activeCount} / ${maxConcurrency}`
      : `并行 ${activeCount}`
  }
  return task.total > 0 ? `${semanticTaskCurrentIndex(task)} / ${task.total}` : '—'
}

const semanticTaskThroughputLabelOf = (value: number | undefined): string => {
  const throughput = semanticTaskFiniteNumberOf(value)
  return throughput !== undefined && throughput >= 0.1
    ? `${throughput.toFixed(1)} 条/分`
    : '计算中'
}

const semanticTaskEtaLabelOf = (value: number | undefined): string => {
  const remainingMs = semanticTaskFiniteNumberOf(value)
  if (remainingMs === undefined || remainingMs < 0) return '计算中'
  if (remainingMs < 60_000) return `约${Math.max(0, Math.round(remainingMs / 1_000))}秒`
  const minutes = remainingMs / 60_000
  if (minutes < 60) return `约${Math.max(1, Math.round(minutes))}分钟`
  const hours = remainingMs / 3_600_000
  const hourLabel = hours < 10
    ? hours.toFixed(1).replace(/\.0$/u, '')
    : String(Math.round(hours))
  return `约${hourLabel}小时`
}

const semanticTaskExecutionPolicyHint = '在线模型自动并发处理，本地模型保持单路保护'

const semanticTaskDisplayMessageOf = (task: SemanticizationTaskSnapshot): string => {
  const rawMessage = task.message?.trim()
  const hasLegacySequentialCopy = Boolean(rawMessage && /逐条|按记录/u.test(rawMessage))
  const baseMessage = !rawMessage || hasLegacySequentialCopy
    ? '任务将按所选质量模式自适应处理'
    : rawMessage
  const activeCount = semanticTaskActiveCountOf(task)
  const activePrefix = activeCount !== undefined && activeCount > 1
    ? `并行处理中 ${activeCount} 条 · `
    : ''
  const policySuffix = task.status === 'queued' || task.total === 0 || hasLegacySequentialCopy
    ? `；${semanticTaskExecutionPolicyHint}`
    : ''
  return `${activePrefix}${baseMessage}${policySuffix}`
}

type RequirementMatchProgress = AgentMatchProgress

const progressNumberOf = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
}

const parseRequirementMatchProgress = (
  events: Array<Extract<AgentEvent, { type: 'status' }>>
): RequirementMatchProgress => {
  let progress: RequirementMatchProgress = { hasMatch: false }
  let matchSeen = false
  const keepLargest = (current: number | undefined, next: number | undefined): number | undefined => {
    if (next === undefined) return current
    return current === undefined ? next : Math.max(current, next)
  }

  events.forEach((event) => {
    if (event.progress?.match?.hasMatch) {
      progress = { ...progress, ...event.progress.match, hasMatch: true }
      matchSeen = true
      return
    }
    const message = event.message || ''
    if (event.stage === 'locate' && matchSeen) {
      progress = { hasMatch: false }
      matchSeen = false
    }
    const isMatchMessage = ['recall', 'rerank', 'score', 'explain'].includes(event.stage)
      || /(混合召回|RRF|Cross-Encoder|多维业务评分|批量 AI 解释|缓存命中|AI 解释不可用|隔离)/u.test(message)
    if (!isMatchMessage) return

    matchSeen = true
    progress.hasMatch = true

    const recallTotal = progressNumberOf(message.match(/共\s*(\d+)\s*条候选/u)?.[1])
    progress.recallTotal = keepLargest(progress.recallTotal, recallTotal)

    const rerankTotal = progressNumberOf(message.match(/重排\s*(?:正在)?\s*(\d+)\s*条候选/u)?.[1])
    const rerankCurrent = progressNumberOf(message.match(/进入前\s*(\d+)\s*条/u)?.[1])
    progress.rerankTotal = keepLargest(progress.rerankTotal, rerankTotal ?? rerankCurrent)
    progress.rerankCurrent = keepLargest(progress.rerankCurrent, rerankCurrent)

    const scoreMessage = message.match(/已完成\s*(\d+)\s*条候选多维业务评分(?:，|,)?\s*前\s*(\d+)\s*条/u)
    progress.scoredTotal = keepLargest(progress.scoredTotal, progressNumberOf(scoreMessage?.[1]))
    progress.scoredCurrent = keepLargest(progress.scoredCurrent, progressNumberOf(scoreMessage?.[1]))

    const explainMessage = message.match(/待\s*AI\s*解释\s*(\d+)\s*条，已复核缓存命中\s*(\d+)\s*条/u)
    if (explainMessage) {
      const pending = progressNumberOf(explainMessage[1]) ?? 0
      const cacheHits = progressNumberOf(explainMessage[2]) ?? 0
      progress.explanationTotal = keepLargest(progress.explanationTotal, pending + cacheHits)
      progress.explanationDone = keepLargest(progress.explanationDone, cacheHits)
      progress.cacheHits = keepLargest(progress.cacheHits, cacheHits)
    }
    if (/一次批量 AI 解释已通过/u.test(message) || /AI 解释总结已生成/u.test(message)) {
      progress.explanationDone = progress.explanationTotal ?? progress.scoredCurrent ?? progress.rerankCurrent
      progress.explanationTotal = progress.explanationTotal ?? progress.explanationDone
    }

    const isolated = progressNumberOf(message.match(/(?:隔离|失败隔离)(?:候选)?\s*(?:数|数量)?\s*[：:]?\s*(\d+)/u)?.[1])
    progress.isolated = keepLargest(progress.isolated, isolated)
  })

  if (!progress.hasMatch) return progress
  progress.cacheHits ??= 0
  progress.isolated ??= 0
  return progress
}

const requirementAnalysisProgressOf = (
  events: Array<Extract<AgentEvent, { type: 'status' }>>
): AgentProgress | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const progress = events[index].progress
    if (!progress) continue
    const values = [progress.percent, progress.currentItem, progress.totalItems, progress.completedItems]
    if (values.some((value) => !Number.isFinite(value))) continue
    return {
      percent: Math.min(100, Math.max(0, progress.percent)),
      currentItem: Math.max(0, Math.floor(progress.currentItem)),
      totalItems: Math.max(0, Math.floor(progress.totalItems)),
      completedItems: Math.max(0, Math.floor(progress.completedItems)),
      ...(progress.stageCurrent === undefined || !Number.isFinite(progress.stageCurrent)
        ? {}
        : { stageCurrent: Math.max(0, Math.floor(progress.stageCurrent)) }),
      ...(progress.stageTotal === undefined || !Number.isFinite(progress.stageTotal)
        ? {}
        : { stageTotal: Math.max(0, Math.floor(progress.stageTotal)) }),
      ...(progress.match ? { match: progress.match } : {})
    }
  }
  return undefined
}

type SemanticAuditStageKey = 'queued' | 'initial' | 'independent' | 'adjudication' | 'persisting'
type SemanticAuditStageStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped'
type SemanticAuditEventKind = 'stage' | 'validation' | 'retry' | 'info'
type SemanticAuditEventStatus = 'running' | 'success' | 'warning' | 'error' | 'info'

type SemanticAuditFieldView = {
  key: string
  label: string
  value: string
  evidence: string
  confidence?: number
}

type SemanticAuditStageView = {
  key: SemanticAuditStageKey
  label: string
  hint: string
  status: SemanticAuditStageStatus
  summary: string
  evidence: string
  fields: SemanticAuditFieldView[]
}

type SemanticAuditEventView = {
  id: string
  kind: SemanticAuditEventKind
  status: SemanticAuditEventStatus
  title: string
  detail: string
  timestamp?: string
  attempt?: number
}

type SemanticAuditComparisonView = {
  field: string
  label: string
  initial: string
  independent: string
  resolution: string
  evidence: string
}

const semanticAuditStageDefinitions: Array<{
  key: SemanticAuditStageKey
  label: string
  hint: string
}> = [
  { key: 'queued', label: '任务排队', hint: '确认任务范围并等待执行' },
  { key: 'initial', label: '初步分析', hint: '基于原文生成结构化分析结果' },
  { key: 'independent', label: '独立复核', hint: '严格模式下不参考初步结论，重新核对字段' },
  { key: 'adjudication', label: '结果裁决', hint: '仅在分歧或低置信时按原文证据形成终稿' },
  { key: 'persisting', label: '校验与保存', hint: '校验字段、置信度和证据引用后保存' }
]

const semanticAuditFieldLabels: Record<string, string> = {
  requirementType: '需求类型',
  productDomain: '产品域',
  module: '业务模块',
  functionalObject: '功能对象',
  action: '需求动作',
  currentState: '当前状态',
  targetState: '目标状态',
  trigger: '触发条件',
  input: '输入',
  output: '输出',
  behavior: '功能行为',
  constraints: '业务约束',
  acceptance: '验收结果',
  businessScene: '业务场景'
}

const semanticResultFieldDefinitions: Array<{
  aliases: readonly string[]
}> = [
  { aliases: ['action', '需求动作'] },
  { aliases: ['functionalObject', '功能对象'] },
  { aliases: ['behavior', '功能行为'] },
  { aliases: ['targetState', '目标状态'] },
  { aliases: ['constraints', '业务约束'] },
  { aliases: ['acceptance', '验收结果'] }
]

const semanticActionLabels: Record<string, string> = {
  rename_label: '修改名称/文案',
  configure_permission: '配置权限',
  compare: '对比分析',
  enable_selection: '开启选择',
  add_capability: '新增能力',
  remove_capability: '移除能力',
  relax_constraint: '放宽约束',
  tighten_constraint: '收紧约束',
  fix_defect: '修复缺陷',
  change_flow: '调整流程',
  optimize_ui: '优化界面',
  unknown: '未识别'
}

const semanticResultPlaceholderValues = new Set(['—', '未确认', '未提供', '等待裁决', '等待裁决输出'])

const semanticResultValueIsPresent = (value: string): boolean => Boolean(value)
  && !semanticResultPlaceholderValues.has(value)

const semanticResultFieldsOf = (fields: SemanticAuditFieldView[]): SemanticAuditFieldView[] => (
  semanticResultFieldDefinitions.flatMap(({ aliases }) => {
    const field = fields.find((candidate) => (
      aliases.some((alias) => alias === candidate.key || alias === candidate.label)
      && semanticResultValueIsPresent(candidate.value)
    ))
    return field ? [field] : []
  })
)

const semanticAuditStatusLabels: Record<SemanticAuditStageStatus, string> = {
  pending: '待执行',
  active: '进行中',
  completed: '已完成',
  failed: '需关注',
  skipped: '未执行'
}

const semanticAuditEventStatusLabels: Record<SemanticAuditEventStatus, string> = {
  running: '进行中',
  success: '通过',
  warning: '需关注',
  error: '失败',
  info: '记录'
}

const auditRecordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
)

const auditTextOf = (value: unknown): string => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

const firstAuditText = (record: Record<string, unknown> | null, keys: readonly string[]): string => {
  if (!record) return ''
  for (const key of keys) {
    const value = auditTextOf(record[key])
    if (value) return value
  }
  return ''
}

const auditNumberOf = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

const semanticAuditTraceSignatureOf = (
  task: Pick<SemanticizationTaskSnapshot, 'analysisTrace'>
): string => {
  const trace = task.analysisTrace
  if (!trace) return ''
  const events = Array.isArray(trace.events) ? trace.events : []
  const lastEvent = events.length ? events[events.length - 1] : undefined
  const stageSignature = semanticAuditStageDefinitions
    .map(({ key }) => {
      if (key === 'queued') return ''
      const stage = trace.stages?.[key]
      return [
        key,
        stage?.status ?? '',
        stage?.attempts ?? '',
        stage?.startedAt ?? '',
        stage?.completedAt ?? '',
        stage?.summary ?? '',
        Object.keys(stage?.fields ?? {}).length
      ].join(':')
    })
    .join('|')
  return JSON.stringify([
    trace.recordUid,
    trace.outcome ?? '',
    trace.completedAt ?? '',
    events.length,
    lastEvent?.id ?? '',
    lastEvent?.timestamp ?? '',
    lastEvent?.kind ?? '',
    stageSignature
  ])
}

const semanticAuditTaskSignatureOf = (
  task: SemanticizationTaskSnapshot,
  traceSignature = semanticAuditTraceSignatureOf(task)
): string => JSON.stringify([
  task.jobId,
  task.status,
  task.currentStage,
  task.total,
  task.succeeded,
  task.failed,
  task.message,
  task.deepThinking,
  task.qualityMode,
  task.currentRecord?.uid ?? '',
  task.currentRecord?.index ?? '',
  (Array.isArray(task.recentItems) ? task.recentItems : []).map((item) => [
    item.uid,
    item.itemId,
    item.name,
    item.status,
    item.error ?? '',
    item.durationMs ?? ''
  ]),
  traceSignature
])

const semanticTaskSnapshotSignatureOf = (
  snapshot: SemanticizationTaskSnapshot
): string => JSON.stringify([
  snapshot.jobId,
  snapshot.status,
  snapshot.currentStage,
  snapshot.total,
  snapshot.available,
  snapshot.completed,
  snapshot.succeeded,
  snapshot.failed,
  snapshot.remaining,
  snapshot.startedAt,
  snapshot.updatedAt,
  snapshot.message,
  snapshot.deepThinking,
  snapshot.qualityMode,
  snapshot.maxConcurrency,
  snapshot.activeCount,
  snapshot.elapsedMs,
  snapshot.recordsPerMinute,
  snapshot.estimatedRemainingMs,
  snapshot.currentRecord,
  (Array.isArray(snapshot.activeRecords) ? snapshot.activeRecords : []).map((record) => [
    record.uid,
    record.itemId,
    record.name,
    record.index,
    record.stage,
    record.startedAt
  ]),
  (Array.isArray(snapshot.recentItems) ? snapshot.recentItems : []).map((item) => [
    item.uid,
    item.itemId,
    item.name,
    item.status,
    item.error ?? '',
    item.durationMs ?? ''
  ]),
  semanticAuditTraceSignatureOf(snapshot)
])

const plainAuditText = (value: unknown): string => auditTextOf(value)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p\s*>/gi, '\n')
  .replace(/<[^>]*>/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const semanticAuditPayloadOf = (task: SemanticizationTaskSnapshot): Record<string, unknown> => {
  const taskRecord = task as unknown as Record<string, unknown>
  const candidates = [
    taskRecord.audit,
    taskRecord.auditTrace,
    taskRecord.analysisTrace,
    taskRecord.trace,
    taskRecord.analysis
  ]
  const payload = candidates.map(auditRecordOf).find((value): value is Record<string, unknown> => Boolean(value)) ?? {}
  if (Array.isArray(payload)) return { events: payload }
  return payload
}

const semanticAuditStagePayloadOf = (
  payload: Record<string, unknown>,
  key: SemanticAuditStageKey
): Record<string, unknown> => {
  const stages = payload.stages
  const stageRecord = auditRecordOf(stages)
  if (stageRecord) {
    const nested = auditRecordOf(stageRecord[key])
    if (nested) return nested
  }
  if (Array.isArray(stages)) {
    const nested = stages
      .map(auditRecordOf)
      .find((value) => value && firstAuditText(value, ['stage', 'key', 'name', 'type']) === key)
    if (nested) return nested
  }
  const direct = auditRecordOf(payload[key])
    ?? auditRecordOf(payload[`${key}Analysis`])
    ?? auditRecordOf(payload[`${key}Result`])
  const summary = firstAuditText(payload, [
    `${key}Summary`,
    key === 'adjudication' ? 'finalSummary' : '',
    key === 'adjudication' ? 'decisionSummary' : ''
  ].filter(Boolean))
  return direct || summary ? { ...(direct ?? {}), ...(summary ? { summary } : {}) } : {}
}

const semanticAuditFieldsOf = (stage: Record<string, unknown>): SemanticAuditFieldView[] => {
  const fieldSource = stage.fields
    ?? stage.structuredFields
    ?? stage.fieldAssessments
    ?? stage.output
    ?? stage.result
  const entries: Array<[string, unknown]> = Array.isArray(fieldSource)
    ? fieldSource.flatMap((item): Array<[string, unknown]> => {
        const itemRecord = auditRecordOf(item)
        const key = firstAuditText(itemRecord, ['field', 'key', 'name', 'label'])
        return key ? [[key, item]] : []
      })
    : Object.entries(auditRecordOf(fieldSource) ?? {})
  return entries.map(([key, value]) => {
    const item = auditRecordOf(value)
    const fieldValue = item
      ? firstAuditText(item, ['value', 'text', 'result', 'finalValue', 'resolvedValue'])
      : auditTextOf(value)
    return {
      key,
      label: semanticAuditFieldLabels[key] ?? key,
      value: fieldValue || (item ? '未确认' : '—'),
      evidence: item
        ? firstAuditText(item, ['evidence', 'sourceQuote', 'quote', 'originalEvidence', 'evidenceText'])
        : '',
      ...(item && auditNumberOf(item.confidence) !== undefined
        ? { confidence: auditNumberOf(item.confidence) }
        : {})
    }
  }).filter((field) => field.value || field.evidence).slice(0, 24)
}

const semanticAuditStageStatusOf = (
  task: SemanticizationTaskSnapshot,
  key: SemanticAuditStageKey,
  stage: Record<string, unknown>,
  currentIndex: number
): SemanticAuditStageStatus => {
  const explicit = firstAuditText(stage, ['status', 'state']).toLocaleLowerCase()
  const tracePayload = semanticAuditPayloadOf(task)
  const traceOutcome = firstAuditText(tracePayload, ['outcome']).toLocaleLowerCase()
  if ((traceOutcome === 'failed' || traceOutcome === 'stopped') && ['active', 'running', 'processing'].includes(explicit)) {
    return 'failed'
  }
  if (['pending', 'queued', 'waiting'].includes(explicit)) return 'pending'
  if (['active', 'running', 'processing'].includes(explicit)) return 'active'
  if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(explicit)) return 'completed'
  if (['failed', 'error'].includes(explicit)) return 'failed'
  if (['skipped', 'cancelled', 'canceled'].includes(explicit)) return 'skipped'
  if (traceOutcome === 'completed') return 'completed'
  if (traceOutcome === 'failed' || traceOutcome === 'stopped') {
    return key === 'queued' ? 'completed' : 'skipped'
  }
  if (!Object.keys(tracePayload).length && task.total === 0) {
    return key === 'queued' ? 'completed' : 'skipped'
  }
  if (task.status === 'completed') return 'completed'
  if (task.status === 'stopped') {
    if (currentIndex < 0) return key === 'queued' ? 'completed' : 'skipped'
    if (key === task.currentStage) return 'failed'
    const stageIndex = semanticAuditStageDefinitions.findIndex((item) => item.key === key)
    return stageIndex < currentIndex ? 'completed' : 'skipped'
  }
  if (task.currentStage === 'idle') return key === 'queued' ? 'active' : 'pending'
  if (task.currentStage === key) return 'active'
  const stageIndex = semanticAuditStageDefinitions.findIndex((item) => item.key === key)
  return currentIndex >= 0 && stageIndex < currentIndex ? 'completed' : 'pending'
}

const semanticAuditEventKindOf = (value: unknown, fallback: SemanticAuditEventKind): SemanticAuditEventKind => {
  const text = auditTextOf(value).toLocaleLowerCase()
  if (text.includes('retry') || text.includes('重试')) return 'retry'
  if (text.includes('valid') || text.includes('校验') || text.includes('验证')) return 'validation'
  if (text.includes('stage') || text.includes('阶段')) return 'stage'
  return fallback
}

const semanticAuditEventStatusOf = (value: unknown, fallback: SemanticAuditEventStatus): SemanticAuditEventStatus => {
  const text = auditTextOf(value).toLocaleLowerCase()
  if (['running', 'active', 'processing'].includes(text) || text.includes('进行')) return 'running'
  if (['success', 'succeeded', 'passed', 'complete', 'completed'].includes(text) || text.includes('通过')) return 'success'
  if (['warning', 'warn', 'pending'].includes(text) || text.includes('关注')) return 'warning'
  if (['error', 'failed', 'failure'].includes(text) || text.includes('失败')) return 'error'
  return fallback
}

const semanticAuditEventsOf = (payload: Record<string, unknown>): SemanticAuditEventView[] => {
  const eventSources: Array<{ value: unknown; fallback: SemanticAuditEventKind }> = [
    { value: payload.events, fallback: 'info' },
    { value: payload.auditEvents, fallback: 'info' },
    { value: payload.validationEvents, fallback: 'validation' },
    { value: payload.retryEvents, fallback: 'retry' }
  ]
  const events: SemanticAuditEventView[] = []
  eventSources.forEach(({ value, fallback }) => {
    if (!Array.isArray(value)) return
    value.forEach((item, index) => {
      const record = auditRecordOf(item)
      if (!record) return
      const rawKind = firstAuditText(record, ['kind', 'type', 'event']).toLocaleLowerCase()
      const kind = semanticAuditEventKindOf(rawKind, fallback)
      const inferredStatus: SemanticAuditEventStatus = rawKind === 'stage_started'
        ? 'running'
        : rawKind === 'stage_completed' || rawKind === 'validation_passed'
          ? 'success'
          : rawKind === 'validation_failed' || rawKind === 'model_error'
            ? 'error'
            : rawKind === 'retry' || rawKind === 'divergence'
              ? 'warning'
              : kind === 'retry' ? 'warning' : 'info'
      const title = firstAuditText(record, ['title', 'label', 'name', 'event']) || (
        rawKind === 'stage_started' ? '阶段开始'
          : rawKind === 'stage_completed' ? '阶段完成'
            : rawKind === 'model_error' ? '模型调用失败'
            : rawKind === 'divergence' ? '检测到字段分歧'
              : kind === 'retry' ? '模型重试' : kind === 'validation' ? '结果校验' : '审计事件'
      )
      const detail = firstAuditText(record, ['detail', 'message', 'description', 'reason', 'summary'])
      const attempt = auditNumberOf(record.attempt ?? record.retryCount)
      events.push({
        id: `payload-${kind}-${index}-${title}`,
        kind,
        status: semanticAuditEventStatusOf(record.status ?? record.state, inferredStatus),
        title,
        detail: detail || '事件已记录，当前快照未提供更多说明。',
        timestamp: firstAuditText(record, ['timestamp', 'createdAt', 'updatedAt', 'at']),
        ...(attempt !== undefined ? { attempt } : {})
      })
    })
  })
  return events.slice(-32)
}

const semanticAuditComparisonsOf = (
  payload: Record<string, unknown>,
  initial: SemanticAuditStageView,
  independent: SemanticAuditStageView
): SemanticAuditComparisonView[] => {
  const divergenceRecord = auditRecordOf(payload.divergence)
  const explicitSource = payload.disagreements ?? payload.divergences ?? payload.comparisons ?? divergenceRecord?.fields
  const finalFields = auditRecordOf(auditRecordOf(payload.finalAdjudication)?.fields)
  const explicit = Array.isArray(explicitSource)
    ? explicitSource.flatMap((item, index): SemanticAuditComparisonView[] => {
        const record = auditRecordOf(item)
        if (!record) return []
        const field = firstAuditText(record, ['field', 'key', 'name', 'label']) || `difference-${index + 1}`
        const initialField = auditRecordOf(record.initial)
        const independentField = auditRecordOf(record.independent)
        return [{
          field,
          label: semanticAuditFieldLabels[field] ?? field,
          initial: firstAuditText(record, ['initialValue', 'first', 'left'])
            || firstAuditText(initialField, ['value']) || '未提供',
          independent: firstAuditText(record, ['independentValue', 'second', 'right'])
            || firstAuditText(independentField, ['value']) || '未提供',
          resolution: firstAuditText(record, ['resolution', 'decision', 'adjudicated', 'finalValue'])
            || firstAuditText(auditRecordOf(finalFields?.[field]), ['value'])
            || '等待裁决',
          evidence: firstAuditText(record, ['evidence', 'sourceQuote', 'reason'])
            || firstAuditText(auditRecordOf(finalFields?.[field]), ['evidence'])
            || firstAuditText(initialField, ['evidence'])
            || firstAuditText(independentField, ['evidence'])
        }]
      })
    : []
  if (explicit.length) return explicit.slice(0, 24)
  const initialMap = new Map(initial.fields.map((field) => [field.key, field]))
  const independentMap = new Map(independent.fields.map((field) => [field.key, field]))
  return [...new Set([...initialMap.keys(), ...independentMap.keys()])]
    .flatMap((field): SemanticAuditComparisonView[] => {
      const first = initialMap.get(field)
      const second = independentMap.get(field)
      if (!first || !second || !first.value || !second.value || first.value === second.value) return []
      return [{
        field,
        label: semanticAuditFieldLabels[field] ?? field,
        initial: first.value,
        independent: second.value,
        resolution: '等待裁决输出',
        evidence: first.evidence || second.evidence
      }]
    }).slice(0, 24)
}

const buildSemanticAuditView = (
  task: SemanticizationTaskSnapshot,
  records: RecordRow[],
  history: SemanticAuditEventView[]
): {
  timeline: SemanticAuditStageView[]
  outputs: SemanticAuditStageView[]
  events: SemanticAuditEventView[]
  comparisons: SemanticAuditComparisonView[]
  finalSummary: string
  evidence: string
  finalFields: SemanticAuditFieldView[]
} => {
  const payload = semanticAuditPayloadOf(task)
  const currentIndex = semanticAuditStageDefinitions.findIndex((stage) => stage.key === task.currentStage)
  const taskRecord = task as unknown as Record<string, unknown>
  const recentUid = task.currentRecord?.uid || task.recentItems[0]?.uid
  const sourceRecord = recentUid ? records.find((record) => record.uid === recentUid) : undefined
  const finalAdjudication = auditRecordOf(payload.finalAdjudication)
  const finalAdjudicationFields = finalAdjudication ? semanticAuditFieldsOf(finalAdjudication) : []
  const adjudicationPayload = semanticAuditStagePayloadOf(payload, 'adjudication')
  const adjudicationStageFields = semanticAuditFieldsOf(adjudicationPayload)
  const adjudicatedFields = [...finalAdjudicationFields, ...adjudicationStageFields]
  const finalFields = semanticResultFieldsOf(adjudicatedFields)
  const adjudicationEvidence = [...new Set(adjudicatedFields.map((field) => field.evidence).filter(Boolean))].join('；')
  const evidence = firstAuditText(payload, ['sourceEvidence', 'originalEvidence', 'evidence', 'sourceText'])
    || adjudicationEvidence
    || plainAuditText(sourceRecord?.normalizedText || sourceRecord?.description || sourceRecord?.name)
  const timeline = semanticAuditStageDefinitions.map((definition) => {
    const stagePayload = semanticAuditStagePayloadOf(payload, definition.key)
    const summary = firstAuditText(stagePayload, ['summary', 'analysisSummary', 'decisionSummary', 'message'])
      || (definition.key === task.currentStage ? task.message : '')
    return {
      ...definition,
      status: semanticAuditStageStatusOf(task, definition.key, stagePayload, currentIndex),
      summary,
      evidence: firstAuditText(stagePayload, ['evidence', 'sourceQuote', 'originalEvidence', 'evidenceText']) || evidence,
      fields: semanticAuditFieldsOf(stagePayload)
    }
  })
  const outputs = timeline.filter((stage): stage is SemanticAuditStageView => (
    stage.key === 'initial' || stage.key === 'independent' || stage.key === 'adjudication'
  ))
  const initial = outputs.find((stage) => stage.key === 'initial') ?? outputs[0]
  const independent = outputs.find((stage) => stage.key === 'independent') ?? outputs[1]
  const adjudication = outputs.find((stage) => stage.key === 'adjudication') ?? outputs[2]
  const finalSummary = firstAuditText(payload, ['finalSummary', 'adjudicationSummary', 'decisionSummary', 'analysisSummary', 'summary'])
    || firstAuditText(finalAdjudication, ['summary'])
    || adjudication?.summary
    || ''
  const explicitEvents = semanticAuditEventsOf(payload)
  const events = [...explicitEvents, ...history.filter((event) => event.kind === 'validation' || event.kind === 'retry')]
  const currentMessage = `${task.message} ${firstAuditText(taskRecord, ['error', 'errorMessage'])}`
  if (task.currentStage === 'persisting' || /校验|验证|valid/i.test(currentMessage)) {
    events.push({
      id: `live-validation-${task.updatedAt}`,
      kind: 'validation',
      status: task.currentStage === 'persisting' ? 'running' : 'error',
      title: '结构化结果校验',
      detail: task.currentStage === 'persisting'
        ? '正在检查字段完整性、置信度范围和原文证据引用。'
        : task.message || '当前快照报告了校验相关状态。',
      timestamp: task.updatedAt
    })
  }
  if (/重试|retry/i.test(currentMessage)) {
    events.push({
      id: `live-retry-${task.updatedAt}`,
      kind: 'retry',
      status: 'warning',
      title: '模型重试',
      detail: task.message || '当前快照报告了重试事件。',
      timestamp: task.updatedAt
    })
  }
  task.recentItems.filter((item) => item.error).forEach((item) => {
    events.push({
      id: `recent-error-${item.uid}-${item.error}`,
      kind: 'validation',
      status: 'error',
      title: `${item.name || item.itemId || item.uid} · 校验/处理失败`,
      detail: item.error || '记录处理失败。'
    })
  })
  const dedupedEvents = [...new Map(events.map((event) => [event.id, event])).values()].slice(-32)
  return {
    timeline,
    outputs,
    events: dedupedEvents,
    comparisons: initial && independent ? semanticAuditComparisonsOf(payload, initial, independent) : [],
    finalSummary,
    evidence,
    finalFields
  }
}

const persistedSemanticAuditTask = (detail: RecordDetail): SemanticizationTaskSnapshot | null => {
  const trace = detail.semanticAnalysisTrace
  if (!trace) return null
  const completed = trace.outcome === 'completed'
  return {
    jobId: `persisted-${detail.uid}`,
    status: 'completed',
    currentStage: 'idle',
    total: 1,
    available: 1,
    completed: 1,
    succeeded: completed ? 1 : 0,
    failed: completed ? 0 : 1,
    remaining: 0,
    startedAt: trace.stages.initial?.startedAt || detail.semanticUpdatedAt,
    updatedAt: trace.completedAt || detail.semanticUpdatedAt,
    message: completed ? '语义化审计轨迹已完成' : '语义化审计轨迹记录了异常或终止',
    recentItems: [],
    deepThinking: trace.deepThinking !== false,
    ...(trace.qualityMode ? { qualityMode: trace.qualityMode } : {}),
    analysisTrace: trace
  }
}

type SemanticAuditPanelProps = {
  task: SemanticizationTaskSnapshot
  records?: RecordRow[]
  history?: SemanticAuditEventView[]
}

const semanticAuditPanelPropsEqual = (
  previous: SemanticAuditPanelProps,
  next: SemanticAuditPanelProps
): boolean => (
  semanticAuditTaskSignatureOf(previous.task) === semanticAuditTaskSignatureOf(next.task) &&
  previous.records === next.records &&
  previous.history === next.history
)

const SemanticAuditPanel = React.memo(function SemanticAuditPanel({
  task,
  records = [],
  history = []
}: SemanticAuditPanelProps): React.JSX.Element {
  const traceSignature = semanticAuditTraceSignatureOf(task)
  const taskSignature = semanticAuditTaskSignatureOf(task, traceSignature)
  const view = useMemo(
    () => buildSemanticAuditView(task, records, history),
    [history, records, taskSignature, traceSignature]
  )
  const taskMode = semanticTaskModeOf(task)
  const adjudicationStage = view.timeline.find((stage) => stage.key === 'adjudication')
  const hasSemanticResult = view.finalFields.length > 0 || Boolean(view.finalSummary)
  const resultIsCompleted = hasSemanticResult
    && adjudicationStage?.status !== 'failed'
    && ((task.status === 'completed' && task.succeeded > 0 && task.failed === 0) || adjudicationStage?.status === 'completed')
  const resultNeedsAttention = !resultIsCompleted && (
    adjudicationStage?.status === 'failed' || task.status === 'stopped' || task.failed > 0
  )
  const resultStatusClass = resultIsCompleted
    ? 'is-completed'
    : resultNeedsAttention
      ? 'is-failed'
      : hasSemanticResult ? 'is-active' : 'is-pending'
  const resultStatusLabel = resultIsCompleted
    ? '已完成 · 结构化结果'
    : resultNeedsAttention
      ? '结果需关注'
      : hasSemanticResult ? '已生成 · 待校验' : '尚未生成结构化结果'
  return (
    <section className="asset-semantic-audit" aria-label="AI 语义化可审计分析过程">
      <div className="asset-semantic-audit-heading">
        <div>
          <Text strong>可审计分析过程</Text>
          <Text type="secondary">展示阶段、校验事件和可追溯证据，不展示模型内部思维链。</Text>
        </div>
        <div className="asset-semantic-audit-badges">
          <span className="asset-semantic-audit-disclaimer">分析模式：{semanticTaskModeLabelOf(taskMode)}</span>
          <span className="asset-semantic-audit-disclaimer">过程记录 ≠ 内部思维链</span>
        </div>
      </div>
      <section className={`asset-semantic-result-summary ${resultIsCompleted ? 'is-completed' : ''}`} aria-label="最终结构化语义结果">
        <div className="asset-semantic-result-heading">
          <div>
            <div className="asset-semantic-result-title">
              {resultIsCompleted ? <CheckCircleOutlined aria-hidden="true" /> : <InfoCircleOutlined aria-hidden="true" />}
              <span>最终语义化结果</span>
            </div>
            <Text type="secondary">基于已确认字段汇总，优先展示通过校验的内容。</Text>
          </div>
          <span className={`asset-semantic-result-state ${resultStatusClass}`} role="status">
            {resultStatusLabel}
          </span>
        </div>
        {view.finalFields.length ? (
          <div className="asset-semantic-result-grid" role="list" aria-label="最终语义化核心字段">
            {view.finalFields.map((field) => {
              const value = field.key === 'action' ? semanticActionLabels[field.value] ?? field.value : field.value
              return (
                <div className="asset-semantic-result-field" key={`final-${field.key}`} role="listitem">
                  <div className="asset-semantic-result-field-heading">
                    <span className="asset-semantic-result-label">{field.label}</span>
                    {field.confidence !== undefined && <span className="asset-semantic-result-confidence">置信度 {Math.round(field.confidence * 100)}%</span>}
                  </div>
                  <div className="asset-semantic-result-value" title={value}>{value}</div>
                </div>
              )
            })}
          </div>
        ) : hasSemanticResult ? (
          <p className="asset-semantic-result-text">{view.finalSummary}</p>
        ) : (
          <div className="asset-semantic-result-empty">生成并通过必要校验后，已确认的核心字段会显示在这里。</div>
        )}
        {view.finalFields.length > 0 && view.finalSummary && <p className="asset-semantic-result-text">{view.finalSummary}</p>}
      </section>
      <div className="asset-semantic-audit-grid">
        <section className="asset-semantic-audit-section" aria-label="阶段时间线">
          <div className="asset-semantic-audit-section-heading"><span>阶段时间线</span><Text type="secondary">实时更新</Text></div>
          <ol className="asset-semantic-audit-timeline-list">
            {view.timeline.map((stage) => (
              <li className={`is-${stage.status}`} key={stage.key}>
                <span className="asset-semantic-audit-timeline-marker" aria-hidden="true" />
                <div><div className="asset-semantic-audit-line"><strong>{stage.label}</strong><span className={`asset-semantic-audit-status is-${stage.status}`}>{semanticAuditStatusLabels[stage.status]}</span></div><Text type="secondary">{stage.summary || stage.hint}</Text></div>
              </li>
            ))}
          </ol>
        </section>
        <section className="asset-semantic-audit-section" aria-label="校验与重试事件">
          <div className="asset-semantic-audit-section-heading"><span>校验与重试事件</span><Text type="secondary">{view.events.length} 条</Text></div>
          <div className="asset-semantic-audit-event-list" role="log" aria-live="polite">
            {view.events.length ? view.events.map((event) => (
              <div className={`asset-semantic-audit-event is-${event.status}`} key={event.id}>
                <span className="asset-semantic-audit-event-dot" aria-hidden="true" />
                <div><div className="asset-semantic-audit-line"><strong>{event.title}</strong><span>{event.attempt ? `第 ${event.attempt} 次 · ` : ''}{semanticAuditEventStatusLabels[event.status]}</span></div><Text type="secondary">{event.detail}</Text></div>
                {event.timestamp && <time dateTime={event.timestamp}>{formatDate(event.timestamp)}</time>}
              </div>
            )) : <div className="asset-semantic-audit-empty">任务运行中的校验、重试和异常会记录在这里。</div>}
          </div>
        </section>
      </div>
      <div className="asset-semantic-audit-output-grid">
        {view.outputs.map((stage) => (
          <details className="asset-semantic-audit-output" key={stage.key} open={stage.key === task.currentStage}>
            <summary><span>{stage.label}</span><span className={`asset-semantic-audit-status is-${stage.status}`}>{semanticAuditStatusLabels[stage.status]}</span></summary>
            <div className="asset-semantic-audit-output-body">
              <p>{stage.summary || '该阶段尚未提供结构化摘要。'}</p>
              {stage.fields.length ? <div className="asset-semantic-audit-fields">{stage.fields.map((field) => (
                <div className="asset-semantic-audit-field" key={`${stage.key}-${field.key}`}>
                  <div className="asset-semantic-audit-field-heading"><strong>{field.label}</strong>{field.confidence !== undefined && <span>{Math.round(field.confidence * 100)}%</span>}</div>
                  <div>{field.value}</div>
                  {field.evidence && <blockquote>原文证据：{field.evidence}</blockquote>}
                </div>
              ))}</div> : <div className="asset-semantic-audit-empty">阶段完成后展示已校验字段和原文证据。</div>}
            </div>
          </details>
        ))}
      </div>
      <div className="asset-semantic-audit-review-grid">
        <section className="asset-semantic-audit-section">
          <div className="asset-semantic-audit-section-heading"><span>复核与分歧</span><Text type="secondary">{view.comparisons.length} 项</Text></div>
          {view.comparisons.length ? <div className="asset-semantic-audit-comparison-list">{view.comparisons.map((item) => (
            <div className="asset-semantic-audit-comparison" key={item.field}><strong>{item.label}</strong><div><span>初步</span><p>{item.initial}</p></div><div><span>独立</span><p>{item.independent}</p></div><div><span>裁决</span><p>{item.resolution}</p></div>{item.evidence && <blockquote>依据：{item.evidence}</blockquote>}</div>
          ))}</div> : <div className="asset-semantic-audit-empty">未触发独立复核，或当前尚无需要裁决的分歧。</div>}
        </section>
        <section className="asset-semantic-audit-section">
          <div className="asset-semantic-audit-section-heading"><span>最终结论摘要</span><Text type="secondary">可追溯结论</Text></div>
          <p className="asset-semantic-audit-final-summary">{view.finalSummary || '必要校验完成后展示最终摘要。'}</p>
          <div className="asset-semantic-audit-evidence"><strong>原文证据</strong><p>{view.evidence || '当前记录尚未提供可引用原文。'}</p></div>
        </section>
      </div>
    </section>
  )
}, semanticAuditPanelPropsEqual)

const featureNavigationItems: Array<{
  key: Exclude<PageKey, 'settings'>
  feature: FeatureModuleKey
  icon: React.ReactNode
  label: string
}> = [
  { key: 'dashboard', feature: 'dashboard', icon: <BarChartOutlined />, label: '数据概览' },
  {
    key: 'visualization',
    feature: 'visualization',
    icon: <FundProjectionScreenOutlined />,
    label: '可视化大屏'
  },
  { key: 'projects', feature: 'projects', icon: <ProjectOutlined />, label: '项目管理' },
  { key: 'data', feature: 'data', icon: <DatabaseOutlined />, label: '资产中心' },
  { key: 'semanticization', feature: 'semanticization', icon: <BulbOutlined />, label: 'AI 语义化' },
  { key: 'chat', feature: 'chat', icon: <MessageOutlined />, label: 'AI 助手' },
  { key: 'sync', feature: 'sync', icon: <SyncOutlined />, label: '数据采集' },
  { key: 'push', feature: 'push', icon: <SendOutlined />, label: '数据推送' }
]

const featureDefinitions: Array<{
  key: FeatureModuleKey
  label: string
  description: string
  icon: React.ReactNode
  defaultDisabled?: boolean
}> = [
  {
    key: 'dashboard',
    label: '数据概览',
    description: '查看本地数据统计、类型构成与发布状态。',
    icon: <BarChartOutlined />
  },
  {
    key: 'visualization',
    label: '可视化大屏',
    description: '创建、编辑和导出可追溯的数据可视化大屏。',
    icon: <FundProjectionScreenOutlined />
  },
  {
    key: 'projects',
    label: '项目管理',
    description: '管理项目成本、协议需求和数据中心资产。',
    icon: <ProjectOutlined />
  },
  {
    key: 'data',
    label: '资产中心',
    description: '管理已同步的数据记录与本地知识库资产。',
    icon: <DatabaseOutlined />
  },
  {
    key: 'semanticization',
    label: 'AI 语义化',
    description: '独立执行语义卡片生成、任务控制与审计日志查看。',
    icon: <BulbOutlined />
  },
  {
    key: 'chat',
    label: 'AI 助手',
    description: '使用本地或在线模型进行数据问答和分析。',
    icon: <MessageOutlined />
  },
  {
    key: 'sync',
    label: '数据采集',
    description: '从 VISSLM 平台读取数据并同步到本地。',
    icon: <SyncOutlined />
  },
  {
    key: 'push',
    label: '数据推送',
    description: '将本地处理后的数据按配置推送回业务平台。',
    icon: <SendOutlined />,
    defaultDisabled: true
  }
]

const normalizeFeatureNavigationOrder = (
  input?: readonly FeatureModuleKey[]
): FeatureNavigationOrder => {
  const seen = new Set<FeatureModuleKey>()
  const normalized: FeatureNavigationOrder = []

  for (const key of input ?? []) {
    if (!DEFAULT_FEATURE_NAVIGATION_ORDER.includes(key) || seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }

  for (const key of DEFAULT_FEATURE_NAVIGATION_ORDER) {
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }
  return normalized
}

const onlineModelProviders: Array<{
  value: ModelProvider
  label: string
  baseUrl: string
  models: string[]
}> = [
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.2', 'gpt-4.1', 'gpt-4.1-mini'] },
  { value: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-opus-4-1', 'claude-sonnet-4-0', 'claude-3-7-sonnet-latest'] },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { value: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { value: 'zhipu', label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4-plus', 'glm-4-flash'] },
  { value: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'] },
  { value: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', models: ['MiniMax-M2.5', 'MiniMax-M2.1'] },
  { value: 'rawchat-codex', label: 'RawChat Codex（Responses）', baseUrl: 'https://rawchat.cn/codex', models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'] },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口', baseUrl: '', models: [] }
]

const chatExperts: Array<{
  id: ExpertId
  name: string
  mention: string
  description: string
}> = [
  {
    id: 'visualization',
    name: '数据可视化专家',
    mention: '@数据可视化专家',
    description: '生成可追溯、可编辑的数据大屏'
  },
  {
    id: 'general',
    name: '通用数据助手',
    mention: '@通用数据助手',
    description: '检索、统计和解释本地数据'
  },
  assistantSkillPresentation['knowledge-base'],
  {
    id: 'requirement-analysis',
    name: '需求分析专家',
    mention: '@需求分析专家',
    description: '按需求编号匹配数据中心相似需求'
  },
  assistantSkillPresentation.artifact
]

const visualizationStages = [
  { id: 'intent', label: '理解需求' },
  { id: 'profile', label: '分析数据' },
  { id: 'plan', label: '规划指标' },
  { id: 'query', label: '校验查询' },
  { id: 'execute', label: '计算数据' },
  { id: 'compose', label: '生成大屏' },
  { id: 'validate', label: '质量检查' },
  { id: 'persist', label: '完成' }
] as const

const formatDate = (value?: string): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

type AssistantRunHistoryWithTokenMetrics = AssistantRunHistory & {
  inputTokenCount?: number
  outputTokenCount?: number
  tokensPerSecond?: number
}

const formatDurationSeconds = (milliseconds?: number): string => {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return '—'
  const seconds = Math.round((milliseconds / 1000) * 10) / 10
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(seconds)} 秒`
}

const formatRunMetric = (value: number | undefined, maximumFractionDigits = 0): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(value)
}

const recordMaintenanceOperationLabels: Record<RecordMaintenanceOperation, string> = {
  optimize: '一键优化匹配',
  clean: '仅清理数据',
  rebuild_indexes: '仅重建索引'
}

const recordMaintenanceTaskStatusLabels: Record<RecordMaintenanceTaskStatus, string> = {
  queued: '排队中',
  scanning: '扫描中',
  running: '执行中',
  stopping: '停止中',
  stopped: '已安全停止',
  completed: '已完成',
  completed_with_errors: '完成但有失败',
  failed: '执行失败'
}

const recordMaintenanceStageLabels: Record<RecordMaintenanceStage, string> = {
  scanning: '扫描数据',
  cleaning: '清理数据',
  lexical: '重建全文索引',
  vector: '重建向量索引',
  finalizing: '保存结果',
  idle: '空闲'
}

const recordMaintenanceIndexStatusMeta: Record<RecordMaintenanceIndexStatus, {
  label: string
  color: 'default' | 'processing' | 'success' | 'warning' | 'error'
}> = {
  ready: { label: '就绪', color: 'success' },
  pending: { label: '待处理', color: 'warning' },
  stale: { label: '需更新', color: 'warning' },
  running: { label: '处理中', color: 'processing' },
  failed: { label: '失败', color: 'error' },
  unavailable: { label: '不可用', color: 'default' }
}

const recordMaintenanceActiveStatuses: RecordMaintenanceTaskStatus[] = [
  'queued',
  'scanning',
  'running',
  'stopping'
]

const recordMaintenanceTerminalStatuses: RecordMaintenanceTaskStatus[] = [
  'stopped',
  'completed',
  'completed_with_errors',
  'failed'
]

const fallbackMaintenanceState = (): RecordMaintenanceState => ({
  overallStatus: 'unavailable',
  clean: { status: 'unavailable', version: '—', updatedAt: '' },
  lexical: { status: 'unavailable', version: '—', updatedAt: '' },
  vector: { status: 'unavailable', version: '—', updatedAt: '' }
})

const recordMaintenanceIndexDefinitions: Array<{
  key: 'clean' | 'lexical' | 'vector'
  label: string
}> = [
  { key: 'clean', label: '数据清理' },
  { key: 'lexical', label: '全文索引' },
  { key: 'vector', label: '向量索引' }
]

const formatChatSessionTime = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 60 * 60 * 1000) return `${Math.max(1, Math.floor(elapsed / 60000))} 分钟前`
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)} 小时前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

const chatSessionTitleOf = (
  session: ChatSessionSummary | undefined,
  messages: ChatMessage[]
): string => {
  const storedTitle = session?.title?.replace(/\s+/g, ' ').trim()
  if (storedTitle) return storedTitle
  const firstQuestion = messages.find((item) => item.role === 'user')?.content
    ?.replace(/\s+/g, ' ')
    .trim()
  return firstQuestion || '新的数据任务'
}

const plainTextFromHtml = (value?: string): string => {
  if (!value) return ''
  const document = new DOMParser().parseFromString(value, 'text/html')
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

type DataTransferMeta = {
  format?: 'json' | 'jsonl' | 'visslmpack'
  importRunId?: string
  packVersion?: number
  assetCount?: number
  assetBytes?: number
  checksumVerified?: boolean
  batchCount?: number
  sourceRowCount?: number
  parseErrorCount?: number
  durationMs?: number
}

const formatTransferBytes = (bytes?: number): string | undefined => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const dataTransferMetaText = (result: DataTransferMeta): string => {
  const formatLabel = result.format === 'visslmpack'
    ? `.visslmpack 资源包${result.packVersion ? ` v${result.packVersion}` : ''}`
    : result.format === 'jsonl'
      ? '旧 JSONL'
      : result.format === 'json'
        ? '旧 JSON'
        : undefined
  const parts = [formatLabel]
  if (typeof result.assetCount === 'number') parts.push(`${result.assetCount} 个二进制资源`)
  const assetBytes = formatTransferBytes(result.assetBytes)
  if (assetBytes) parts.push(assetBytes)
  if (result.checksumVerified === true) parts.push('校验通过')
  if (typeof result.batchCount === 'number') parts.push(`${result.batchCount} 批流式导入`)
  if (typeof result.sourceRowCount === 'number') parts.push(`${result.sourceRowCount} 行源数据`)
  if (typeof result.parseErrorCount === 'number' && result.parseErrorCount > 0) {
    parts.push(`${result.parseErrorCount} 条解析错误`)
  }
  if (result.importRunId) parts.push(`运行 ${result.importRunId.slice(0, 8)}`)
  if (typeof result.durationMs === 'number' && result.durationMs >= 1000) {
    parts.push(`${(result.durationMs / 1000).toFixed(1)} 秒`)
  }
  return parts.filter((part): part is string => Boolean(part)).join(' · ')
}

const dataImportRunStatusMeta: Record<DataImportRunSnapshot['status'], {
  label: string
  color: string
}> = {
  running: { label: '进行中', color: 'processing' },
  success: { label: '已完成', color: 'success' },
  failed: { label: '已中断', color: 'error' }
}

const pushImageStats = (result: PushResult): {
  total: number
  uploaded: number
  reused: number
  failed: number
  available: boolean
} => {
  const requestStats = result.requests.reduce(
    (summary, request) => ({
      total: summary.total + (request.imageTotal ?? 0),
      uploaded: summary.uploaded + (request.imageUpload ?? 0),
      reused: summary.reused + (request.imageReuse ?? 0),
      failed: summary.failed + (request.imageFailed ?? 0)
    }),
    { total: 0, uploaded: 0, reused: 0, failed: 0 }
  )
  const hasResultStats = [
    result.imageTotal,
    result.imageUpload,
    result.imageReuse,
    result.imageFailed
  ].some((value) => typeof value === 'number')
  const hasRequestStats = result.requests.some((request) => [
    request.imageTotal,
    request.imageUpload,
    request.imageReuse,
    request.imageFailed
  ].some((value) => typeof value === 'number'))
  return {
    total: result.imageTotal ?? requestStats.total,
    uploaded: result.imageUpload ?? requestStats.uploaded,
    reused: result.imageReuse ?? requestStats.reused,
    failed: result.imageFailed ?? requestStats.failed,
    available: hasResultStats || hasRequestStats
  }
}

const renderPushStatus = (record: Pick<
  RecordRow,
  'pushStatus' | 'pushMessage' | 'pushedAt' | 'pushedUid'
>): React.JSX.Element => {
  if (record.pushStatus === 'success') {
    return (
      <Tag color="success" title={record.pushedUid ? `平台 UID：${record.pushedUid}` : undefined}>
        推送成功
      </Tag>
    )
  }
  if (record.pushStatus === 'failed') {
    return (
      <Tag color="error" title={record.pushMessage || undefined}>
        推送失败
      </Tag>
    )
  }
  return <Tag>未推送</Tag>
}

const semanticStatusMeta: Record<RequirementSemanticizationStatus, {
  label: string
  icon: React.ReactNode
}> = {
  pending: { label: '待语义化', icon: <BulbOutlined /> },
  processing: { label: '处理中', icon: <SyncOutlined spin /> },
  ready: { label: '已完成', icon: <CheckCircleOutlined /> },
  failed: { label: '失败', icon: <ExclamationCircleOutlined /> }
}

const semanticStatusReasonLabels: Record<string, string> = {
  missing: '尚未生成',
  content_changed: '内容已变化',
  analyzer_changed: '分析器已变化',
  model_changed: '模型已变化',
  processing: '正在生成',
  ready: '已生成',
  failed: '上次生成失败'
}

const normalizeSemanticStatus = (value: unknown): RequirementSemanticizationStatus => {
  if (value === 'processing' || value === 'ready' || value === 'failed') return value
  return 'pending'
}

const semanticStatusReasonLabel = (value: unknown): string => (
  typeof value === 'string' ? semanticStatusReasonLabels[value] ?? value : ''
)

const renderSemanticStatus = (record: Pick<
  RecordRow,
  'semanticStatus' | 'semanticStatusReason' | 'semanticError'
>): React.JSX.Element => {
  const status = normalizeSemanticStatus(record.semanticStatus)
  const meta = semanticStatusMeta[status]
  const reason = semanticStatusReasonLabel(record.semanticStatusReason)
  const label = status === 'failed' && record.semanticError
    ? `${meta.label}：${record.semanticError}`
    : reason && status === 'pending'
      ? `${meta.label}：${reason}`
      : meta.label
  const content = (
    <span
      className={`asset-semantic-status is-${status}`}
      aria-label={label}
      title={status === 'failed' ? undefined : label}
    >
      {meta.icon}
      <span>{meta.label}</span>
    </span>
  )
  return status === 'failed'
    ? <Tooltip title={record.semanticError || '语义卡片生成失败，可重试'}>{content}</Tooltip>
    : content
}

function readDashboardToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function DashboardPage({ refreshKey, themeMode }: { refreshKey: number; themeMode: AppThemeMode }): React.JSX.Element {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStats(await window.visslm.getStats())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats, refreshKey])

  if (!stats && loading) {
    return (
      <div className="overview-state overview-loading" role="status">
        <Spin size="small" />
        <Text>正在加载数据概览</Text>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="overview-state">
        <Alert
          type="error"
          showIcon
          message="数据概览加载失败"
          description={error || '暂时无法读取本地统计数据'}
          action={<Button onClick={() => void loadStats()}>重试</Button>}
        />
      </div>
    )
  }

  const typeTotal = stats.byType.reduce((sum, item) => sum + item.value, 0)
  const releaseTotal = stats.byRelease.reduce((sum, item) => sum + item.value, 0)
  const pushRate = stats.collectedCount
    ? Math.round((stats.pushedCount / stats.collectedCount) * 100)
    : 0
  const typeRows = stats.byType.slice(0, 8)
  const releaseRows = stats.byRelease.slice(0, 6)
  const releaseChartRows = stats.byRelease.slice(0, 6)
  const releaseChartTotal = releaseChartRows.reduce((sum, item) => sum + item.value, 0)
  if (releaseTotal > releaseChartTotal) {
    releaseChartRows.push({ name: '其他', value: releaseTotal - releaseChartTotal })
  }
  const releaseColors = [
    readDashboardToken('--accent', '#7c6cff'),
    readDashboardToken('--state-info', '#60b9ff'),
    readDashboardToken('--state-success', '#49d597'),
    readDashboardToken('--state-warning', '#f2b45c'),
    readDashboardToken('--state-error', '#ef6b73'),
    readDashboardToken('--text-muted', '#929bad')
  ]
  const releaseOtherColor = readDashboardToken('--surface-soft', '#171b25')
  const releaseChartColors = [
    ...releaseColors,
    releaseOtherColor
  ]
  const releaseChartData = releaseChartRows.map((item, index) => ({
    ...item,
    itemStyle: { color: releaseChartColors[index] ?? releaseOtherColor }
  }))
  const chartSurface = readDashboardToken('--surface-raised', '#131720')
  const chartOverlay = readDashboardToken('--surface-overlay', '#171b24')
  const chartStroke = readDashboardToken('--stroke-strong', 'rgba(255, 255, 255, 0.13)')
  const chartText = readDashboardToken('--text-main', '#eef1f7')
  const chartMuted = readDashboardToken('--text-muted', '#929bad')
  const releaseOption = {
    animationDuration: 350,
    color: releaseChartColors,
    tooltip: {
      trigger: 'item',
      renderMode: 'html',
      appendToBody: false,
      confine: true,
      transitionDuration: 0,
      backgroundColor: chartOverlay,
      borderColor: chartStroke,
      textStyle: { color: chartText },
      formatter: '{b}<br/><strong>{c}</strong> 条（{d}%）'
    },
    title: {
      text: String(releaseTotal),
      subtext: '条记录',
      left: 'center',
      top: '36%',
      textStyle: { color: chartText, fontSize: 25, fontWeight: 650 },
      subtextStyle: { color: chartMuted, fontSize: 11, lineHeight: 18 }
    },
    series: [
      {
        name: '_valm_Release_text',
        type: 'pie',
        radius: ['62%', '82%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: {
          borderColor: chartSurface,
          borderWidth: 3,
          borderRadius: 5
        },
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          scaleSize: 5,
          label: { show: false }
        },
        data: releaseChartData
      }
    ]
  }
  const metrics = [
    {
      key: 'projects',
      label: '采集项目',
      value: stats.projectCount,
      detail: '资产中心采集项目',
      icon: <ProjectOutlined />,
      tone: 'accent'
    },
    {
      key: 'records',
      label: '已采集数据',
      value: stats.collectedCount,
      detail: '本地 records 记录',
      icon: <DatabaseOutlined />,
      tone: 'info'
    },
    {
      key: 'pushed',
      label: '已推送数据',
      value: stats.pushedCount,
      detail: `成功推送率 ${pushRate}%`,
      icon: <SendOutlined />,
      tone: 'success'
    },
    {
      key: 'images',
      label: '图片资产',
      value: stats.imageCount,
      detail: '已提取二进制图片资源',
      icon: <PictureOutlined />,
      tone: 'warning'
    }
  ]
  const moduleStats = [
    {
      key: 'project-management',
      title: '项目管理',
      subtitle: '项目、需求审核与关联资产',
      icon: <ProjectOutlined />,
      tone: 'accent',
      badge: `${stats.projectManagement.projectCount} 个项目`,
      meta: stats.projectManagement.processingProjectCount
        ? `${stats.projectManagement.processingProjectCount} 个处理中`
        : `${stats.projectManagement.activeProjectCount} 个已启用`,
      items: [
        { label: '已启用项目', value: stats.projectManagement.activeProjectCount },
        { label: '需求条目', value: stats.projectManagement.requirementCount },
        { label: '待审核需求', value: stats.projectManagement.pendingReviewCount },
        { label: '关联资产', value: stats.projectManagement.linkedAssetCount }
      ]
    },
    {
      key: 'asset-center',
      title: '资产中心',
      subtitle: '本地记录、项目归属与媒体资源',
      icon: <DatabaseOutlined />,
      tone: 'info',
      badge: `${stats.assetCenter.recordCount} 条记录`,
      meta: `${stats.assetCenter.typeCount} 种对象类型`,
      items: [
        { label: '数据记录', value: stats.assetCenter.recordCount },
        { label: '采集项目', value: stats.assetCenter.projectCount },
        { label: '对象类型', value: stats.assetCenter.typeCount },
        { label: '图片资产', value: stats.assetCenter.imageCount }
      ]
    }
  ]

  return (
    <div className="page-stack overview-dashboard">
      <div className="overview-metric-grid" aria-label="数据总量">
        {metrics.map((metric) => (
          <Card
            className={`overview-metric-card overview-metric-card-${metric.tone}`}
            key={metric.key}
            role="group"
            aria-label={`${metric.label} ${metric.value}`}
          >
            <div className="overview-metric-heading">
              <span className="overview-metric-icon" aria-hidden="true">
                {metric.icon}
              </span>
              <span className="overview-metric-label">{metric.label}</span>
            </div>
            <Statistic value={metric.value} />
            <span className="overview-metric-detail">{metric.detail}</span>
          </Card>
        ))}
      </div>

      <Card className="overview-analytics-card">
        <div className="overview-analytics-heading">
          <div className="overview-analytics-title">
            <span className="overview-section-kicker">
              <BarChartOutlined />
              数据构成
            </span>
            <Title level={4}>本地数据分布</Title>
            <Text type="secondary">按对象类型与发布状态查看已采集记录的结构</Text>
          </div>
          <div className="overview-analytics-actions">
            <div className="overview-summary-strip" aria-label="数据摘要">
              <span>{stats.byType.length} 种对象类型</span>
              <span>{stats.byRelease.length} 个发布状态</span>
              <span>{pushRate}% 推送率</span>
            </div>
            <Button
              type="text"
              className="overview-refresh-button"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void loadStats()}
              aria-label="刷新数据概览"
              title="刷新数据概览"
            />
          </div>
        </div>

        <div className="overview-analysis-grid">
          <section className="overview-analysis-section overview-type-section">
            <div className="overview-section-heading">
              <div>
                <strong>对象类型</strong>
                <Text type="secondary">按本地已采集记录统计</Text>
              </div>
              <span>{stats.byType.length} 种</span>
            </div>
            {typeRows.length ? (
              <div className="overview-type-list" role="list" aria-label="对象类型分布">
                {typeRows.map((item, index) => {
                  const percent = typeTotal ? Math.round((item.value / typeTotal) * 100) : 0
                  return (
                    <div
                      className="overview-type-item"
                      key={item.name}
                      role="listitem"
                      title={`${item.name}：${item.value} 条，占比 ${percent}%`}
                      aria-label={`${item.name} ${item.value} 条，占比 ${percent}%`}
                    >
                      <div className="overview-type-meta">
                        <span className={`overview-type-dot overview-type-dot-${index % 4}`} aria-hidden="true" />
                        <span className="overview-type-name">{item.name}</span>
                        <strong>{item.value}</strong>
                      </div>
                      <div className="overview-type-track" aria-hidden="true">
                        <span style={{ width: `${Math.max(percent, 3)}%` }} />
                      </div>
                    </div>
                  )
                })}
                {stats.byType.length > typeRows.length ? (
                  <span className="overview-list-note">其余 {stats.byType.length - typeRows.length} 种类型未展开</span>
                ) : null}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="采集数据后显示统计" />
            )}
          </section>

          <section className="overview-analysis-section overview-release-section">
            <div className="overview-section-heading">
              <div>
                <strong>发布状态</strong>
                <Text type="secondary">显示字段 _valm_Release_text</Text>
              </div>
              <span>{stats.byRelease.length} 项</span>
            </div>
            {releaseRows.length ? (
              <div className="overview-release-layout">
                <ReactECharts
                  className="overview-release-chart"
                  option={releaseOption}
                  notMerge
                  lazyUpdate
                  opts={{ renderer: 'svg' }}
                />
                <div className="overview-release-list" role="list" aria-label="发布状态分布">
                  {releaseRows.map((item, index) => {
                    const percent = releaseTotal ? Math.round((item.value / releaseTotal) * 100) : 0
                    return (
                      <div
                        className="overview-release-row"
                        key={item.name}
                        role="listitem"
                        title={`${item.name}：${item.value} 条，占比 ${percent}%`}
                      >
                        <span
                          className="overview-release-dot"
                          style={{ backgroundColor: releaseColors[index % releaseColors.length] }}
                          aria-hidden="true"
                        />
                        <span className="overview-release-name">{item.name}</span>
                        <strong>{item.value}</strong>
                        <small>{percent}%</small>
                      </div>
                    )
                  })}
                  {stats.byRelease.length > releaseRows.length ? (
                    <span className="overview-list-note">其余 {stats.byRelease.length - releaseRows.length} 项状态未展开</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="采集发布显示字段后显示统计" />
            )}
          </section>
        </div>

        <div className="overview-module-grid" aria-label="业务模块统计">
          {moduleStats.map((module) => (
            <section className={`overview-module-section overview-module-${module.tone}`} key={module.key}>
              <div className="overview-module-heading">
                <div className="overview-module-title">
                  <span className="overview-module-icon" aria-hidden="true">
                    {module.icon}
                  </span>
                  <div className="overview-module-copy">
                    <strong>{module.title}</strong>
                    <Text type="secondary">{module.subtitle}</Text>
                  </div>
                </div>
                <div className="overview-module-summary">
                  <strong>{module.badge}</strong>
                  <span>{module.meta}</span>
                </div>
              </div>
              <div className="overview-module-stat-grid" role="list" aria-label={`${module.title}统计`}>
                {module.items.map((item) => (
                  <div className="overview-module-stat" key={item.label} role="listitem">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Card>
    </div>
  )
}

function DataReviewModal({
  source,
  batchId,
  items,
  onClose,
  onApplied
}: {
  source: DataReviewSource
  batchId: string
  items: DataReviewItem[]
  onClose: () => void
  onApplied: (result: DataReviewApplyResult) => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [visibleItems, setVisibleItems] = useState(items)
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [applying, setApplying] = useState(false)
  const sourceLabel = source === 'sync' ? '数据采集' : '数据导入'

  useEffect(() => {
    setVisibleItems(items)
    setSelectedRowKeys([])
  }, [batchId, items])

  const apply = async (reviewIds: string[]): Promise<void> => {
    if (!reviewIds.length) {
      message.warning('请先选择需要覆盖的数据')
      return
    }
    setApplying(true)
    try {
      const result = await window.visslm.applyDataReview({ source, batchId, reviewIds })
      onApplied(result)
      if (result.resolvedReviewIds.length) {
        setVisibleItems((current) => current.filter((item) => !result.resolvedReviewIds.includes(item.id)))
        setSelectedRowKeys((current) => current.filter((id) => !result.resolvedReviewIds.includes(id)))
      }
      if (result.errors.length) {
        message.warning(result.message)
      } else {
        message.success(result.message)
      }
      if (result.resolvedReviewIds.length === visibleItems.length && !result.errors.length) {
        onClose()
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setApplying(false)
    }
  }

  const confirmApply = (reviewIds: string[], all: boolean): void => {
    if (!reviewIds.length) {
      message.warning('请先选择需要覆盖的数据')
      return
    }
    modal.confirm({
      title: all ? `确认覆盖全部 ${reviewIds.length} 条数据？` : `确认覆盖选中的 ${reviewIds.length} 条数据？`,
      content: '覆盖后本地记录内容、文本和图片将以待审查数据为准。',
      okText: '确认覆盖',
      okType: 'danger',
      cancelText: '暂不覆盖',
      onOk: () => apply(reviewIds)
    })
  }

  return (
    <Modal
      className="data-review-modal"
      open
      width="min(1120px, calc(100vw - 32px))"
      title={`${sourceLabel} · 已有数据审查`}
      onCancel={onClose}
      maskClosable={false}
      footer={(
        <Space wrap>
          <Button onClick={onClose}>暂不覆盖</Button>
          <Button
            danger
            loading={applying}
            disabled={!selectedRowKeys.length}
            onClick={() => confirmApply(selectedRowKeys, false)}
          >
            覆盖选中（{selectedRowKeys.length}）
          </Button>
          <Button
            type="primary"
            danger
            loading={applying}
            disabled={!visibleItems.length}
            onClick={() => confirmApply(visibleItems.map((item) => item.id), true)}
          >
            覆盖全部（{visibleItems.length}）
          </Button>
        </Space>
      )}
    >
      <Alert
        showIcon
        type="warning"
        title={`检测到 ${visibleItems.length} 条数据的 _valm_ItemID 已存在，本次默认已过滤。`}
        description="请核对已有记录和待采集/导入记录后，再决定是否覆盖更新。"
        className="data-review-alert"
      />
      <ResizableTable<DataReviewItem>
        tableKey={`data-review-${source}`}
        rowKey="id"
        dataSource={visibleItems}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys.map(String))
        }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (count) => `共 ${count} 条` }}
        scroll={{ x: 1080, y: 'min(440px, max(220px, calc(100vh - 390px)))' }}
        locale={{ emptyText: '暂无待审查数据' }}
        columns={[
          {
            title: '_valm_ItemID',
            dataIndex: 'itemId',
            width: 180,
            ellipsis: true
          },
          {
            title: '已有记录',
            key: 'existingName',
            width: 220,
            ellipsis: true,
            render: (_value, item) => <span title={item.existing.name}>{item.existing.name || '—'}</span>
          },
          {
            title: '待更新记录',
            key: 'incomingName',
            width: 220,
            ellipsis: true,
            render: (_value, item) => <span title={item.incoming.name}>{item.incoming.name || '—'}</span>
          },
          {
            title: '已有类型',
            key: 'existingNodeType',
            width: 130,
            ellipsis: true,
            render: (_value, item) => item.existing.nodeType || '—'
          },
          {
            title: '待更新类型',
            key: 'incomingNodeType',
            width: 130,
            ellipsis: true,
            render: (_value, item) => item.incoming.nodeType || '—'
          },
          {
            title: '已有 UID',
            key: 'existingUid',
            width: 150,
            ellipsis: true,
            render: (_value, item) => <span title={item.existing.uid}>{item.existing.uid || '—'}</span>
          },
          {
            title: '待更新 UID',
            key: 'incomingUid',
            width: 150,
            ellipsis: true,
            render: (_value, item) => <span title={item.incoming.uid}>{item.incoming.uid || '—'}</span>
          },
          {
            title: '已有修改时间',
            key: 'existingLastModifyTime',
            width: 170,
            render: (_value, item) => formatDate(item.existing.lastModifyTime)
          },
          {
            title: '待更新修改时间',
            key: 'incomingLastModifyTime',
            width: 170,
            render: (_value, item) => formatDate(item.incoming.lastModifyTime)
          }
        ]}
      />
    </Modal>
  )
}

function DataPage({
  refreshKey,
  onDataChanged,
  onVisualize
}: {
  refreshKey: number
  onDataChanged: () => void
  onVisualize: (scope: DataScope, summary: string) => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [nodeTypes, setNodeTypes] = useState<string[]>([])
  const [records, setRecords] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [releaseText, setReleaseText] = useState<string | undefined>(undefined)
  const [releaseValues, setReleaseValues] = useState<RecordReleaseValue[]>([])
  const [releaseValuesLoading, setReleaseValuesLoading] = useState(false)
  const [projectId, setProjectId] = useState<string>()
  const [nodeType, setNodeType] = useState<string>()
  const [semanticStatusFilter, setSemanticStatusFilter] = useState<RequirementSemanticizationStatus | 'all'>('all')
  const [detail, setDetail] = useState<RecordDetail | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [importRunsOpen, setImportRunsOpen] = useState(false)
  const [importRuns, setImportRuns] = useState<DataImportRunSnapshot[]>([])
  const [importRunsLoading, setImportRunsLoading] = useState(false)
  const [resumingImportRunId, setResumingImportRunId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [review, setReview] = useState<{ batchId: string; items: DataReviewItem[] } | null>(null)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const [maintenanceOpenFromDetail, setMaintenanceOpenFromDetail] = useState(false)
  const [maintenanceScope, setMaintenanceScope] = useState<RecordMaintenanceScope>('all')
  const [maintenanceTargetUids, setMaintenanceTargetUids] = useState<string[]>([])
  const [maintenanceOperation, setMaintenanceOperation] = useState<RecordMaintenanceOperation>('optimize')
  const [maintenancePreview, setMaintenancePreview] = useState<RecordMaintenancePreview | null>(null)
  const [maintenancePreviewLoading, setMaintenancePreviewLoading] = useState(false)
  const [maintenancePreviewError, setMaintenancePreviewError] = useState<string | null>(null)
  const [maintenanceSubmitting, setMaintenanceSubmitting] = useState(false)
  const [maintenanceStopPending, setMaintenanceStopPending] = useState(false)
  const [maintenanceTask, setMaintenanceTask] = useState<RecordMaintenanceTaskSnapshot | null>(null)
  const maintenanceTerminalRef = useRef('')
  const maintenanceDetailUidRef = useRef<string | null>(null)
  const maintenancePreviewRequestRef = useRef(0)
  const [maintenancePreviewRefreshKey, setMaintenancePreviewRefreshKey] = useState(0)
  const [semanticDictionaryOpen, setSemanticDictionaryOpen] = useState(false)
  const [semanticProfiles, setSemanticProfiles] = useState<FieldProfile[]>([])
  const [semanticProfilesLoading, setSemanticProfilesLoading] = useState(false)
  const [semanticEditing, setSemanticEditing] = useState<FieldProfile | null>(null)
  const [semanticDisplayName, setSemanticDisplayName] = useState('')
  const [semanticRole, setSemanticRole] = useState<FieldProfileRole>('dimension')
  const [semanticSynonyms, setSemanticSynonyms] = useState('')
  const [semanticSensitivity, setSemanticSensitivity] = useState<FieldSensitivity>('normal')
  const [semanticSaving, setSemanticSaving] = useState(false)

  const semanticScope = useMemo<DataScope>(
    () => projectId ? { projectIds: [projectId] } : {},
    [projectId]
  )

  const loadSemanticProfiles = useCallback(async (): Promise<void> => {
    setSemanticProfilesLoading(true)
    try {
      setSemanticProfiles(await window.visslm.listFieldProfiles(semanticScope))
    } catch (error) {
      message.error(`读取字段语义词典失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSemanticProfilesLoading(false)
    }
  }, [message, semanticScope])

  const openSemanticDictionary = (): void => {
    setSemanticDictionaryOpen(true)
    void loadSemanticProfiles()
  }

  const editSemanticProfile = (profile: FieldProfile): void => {
    setSemanticEditing(profile)
    setSemanticDisplayName(profile.displayName ?? '')
    setSemanticRole(profile.role ?? 'dimension')
    setSemanticSynonyms((profile.synonyms ?? []).join('、'))
    setSemanticSensitivity(profile.sensitivity)
  }

  const saveSemanticProfile = async (): Promise<void> => {
    if (!semanticEditing) return
    setSemanticSaving(true)
    try {
      const synonyms = [...new Set(semanticSynonyms
        .split(/[、,，;；\n]+/u)
        .map((value) => value.trim())
        .filter(Boolean))]
      const saved = await window.visslm.saveFieldProfileSemantics(
        semanticScope,
        semanticEditing.field,
        {
          displayName: semanticDisplayName.trim(),
          role: semanticRole,
          synonyms,
          sensitivity: semanticSensitivity
        }
      )
      setSemanticProfiles((current) => current.map((profile) => (
        profile.field === saved.field ? saved : profile
      )))
      setSemanticEditing(null)
      message.success('字段语义已保存，后续 Agent 规划将优先采用该配置')
    } catch (error) {
      message.error(`保存字段语义失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSemanticSaving(false)
    }
  }

  const recordFilters = useMemo<RecordExportQuery>(() => ({
    search,
    projectId,
    nodeType,
    ...(releaseText !== undefined ? { releaseText } : {}),
    ...(semanticStatusFilter !== 'all' ? { semanticStatus: semanticStatusFilter } : {})
  }), [search, projectId, nodeType, releaseText, semanticStatusFilter])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await window.visslm.listRecords({
        page,
        pageSize,
        ...recordFilters
      })
      setRecords(data.rows)
      setTotal(data.total)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, recordFilters])

  const loadReleaseValues = useCallback(async (): Promise<void> => {
    setReleaseValuesLoading(true)
    try {
      setReleaseValues(await window.visslm.listRecordReleaseValues())
    } catch (error) {
      message.error(`读取发布属性候选失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setReleaseValuesLoading(false)
    }
  }, [message])

  useEffect(() => {
    void Promise.all([window.visslm.listProjects(), window.visslm.listNodeTypes()]).then(
      ([projectRows, types]) => {
        setProjects(projectRows)
        setNodeTypes(types)
      }
    )
  }, [refreshKey])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    void loadReleaseValues()
  }, [loadReleaseValues, refreshKey])

  useEffect(() => {
    maintenanceDetailUidRef.current = detail?.uid ?? null
  }, [detail?.uid])

  const openDetail = async (uid: string): Promise<void> => {
    setDetail(await window.visslm.getRecord(uid))
  }

  const loadImportRuns = useCallback(async (): Promise<void> => {
    if (typeof window.visslm.listDataImportRuns !== 'function') return
    setImportRunsLoading(true)
    try {
      setImportRuns(await window.visslm.listDataImportRuns(50))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setImportRunsLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (importRunsOpen) void loadImportRuns()
  }, [importRunsOpen, loadImportRuns, refreshKey])

  const applyMaintenanceSnapshot = useCallback((snapshot: RecordMaintenanceTaskSnapshot): void => {
    setMaintenanceTask(snapshot)
    if (!recordMaintenanceTerminalStatuses.includes(snapshot.status)) return
    const terminalKey = `${snapshot.taskId}:${snapshot.status}:${snapshot.finishedAt ?? snapshot.updatedAt}`
    if (maintenanceTerminalRef.current === terminalKey) return
    maintenanceTerminalRef.current = terminalKey
    setMaintenancePreviewRefreshKey((current) => current + 1)
    void load()
    onDataChanged()
    const detailUid = maintenanceDetailUidRef.current
    if (!detailUid) return
    void window.visslm.getRecord(detailUid).then((next) => {
      setDetail((current) => current?.uid === detailUid ? next : current)
    }).catch(() => {
      // The list refresh remains useful when the detail request is temporarily unavailable.
    })
  }, [load, onDataChanged])

  const hydrateMaintenanceTask = useCallback(async (): Promise<void> => {
    try {
      if (typeof window.visslm.getRecordMaintenanceTask !== 'function') return
      const snapshot = await window.visslm.getRecordMaintenanceTask()
      if (snapshot) applyMaintenanceSnapshot(snapshot)
    } catch {
      // Maintenance recovery is best effort; the data center remains usable without it.
    }
  }, [applyMaintenanceSnapshot])

  useEffect(() => {
    void hydrateMaintenanceTask()
  }, [hydrateMaintenanceTask, refreshKey])

  useEffect(() => {
    if (typeof window.visslm.onRecordMaintenanceProgress !== 'function') return undefined
    return window.visslm.onRecordMaintenanceProgress((snapshot) => {
      applyMaintenanceSnapshot(snapshot)
    })
  }, [applyMaintenanceSnapshot])

  const maintenanceTargetIds = useMemo(
    () => [...new Set(maintenanceTargetUids.map((uid) => uid.trim()).filter(Boolean))],
    [maintenanceTargetUids]
  )
  const maintenanceTaskIsActive = Boolean(
    maintenanceTask && recordMaintenanceActiveStatuses.includes(maintenanceTask.status)
  )

  useEffect(() => {
    if (!maintenanceOpen) return undefined
    const requestId = ++maintenancePreviewRequestRef.current
    if (maintenanceScope === 'selected' && !maintenanceTargetIds.length) {
      setMaintenancePreview(null)
      setMaintenancePreviewError('请先选择至少一条记录')
      setMaintenancePreviewLoading(false)
      return undefined
    }
    setMaintenancePreviewLoading(true)
    setMaintenancePreviewError(null)
    const input = maintenanceScope === 'selected'
      ? { scope: maintenanceScope, recordUids: maintenanceTargetIds }
      : { scope: maintenanceScope }
    if (typeof window.visslm.previewRecordMaintenance !== 'function') {
      setMaintenancePreviewLoading(false)
      setMaintenancePreviewError('当前应用暂未提供数据维护预览能力')
      return undefined
    }
    void window.visslm.previewRecordMaintenance(input).then((preview) => {
      if (requestId !== maintenancePreviewRequestRef.current) return
      setMaintenancePreview(preview)
    }).catch((error) => {
      if (requestId !== maintenancePreviewRequestRef.current) return
      setMaintenancePreview(null)
      setMaintenancePreviewError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (requestId === maintenancePreviewRequestRef.current) setMaintenancePreviewLoading(false)
    })
    return undefined
  }, [maintenanceOpen, maintenanceScope, maintenanceTargetIds, maintenancePreviewRefreshKey])

  const openMaintenancePanel = (
    scope: RecordMaintenanceScope,
    recordUids: string[],
    fromDetail = false
  ): void => {
    const targetIds = [...new Set(recordUids.map((uid) => uid.trim()).filter(Boolean))]
    if (scope === 'selected' && !targetIds.length) {
      message.info('请先选择需要维护的记录')
      return
    }
    setMaintenanceTargetUids(targetIds)
    setMaintenanceScope(scope)
    setMaintenanceOpenFromDetail(fromDetail)
    setMaintenancePreview(null)
    setMaintenancePreviewError(null)
    setMaintenanceOpen(true)
  }

  const openMaintenanceFromToolbar = (): void => {
    const targetIds = [...selectedRowKeys]
    openMaintenancePanel(targetIds.length ? 'selected' : 'all', targetIds)
  }

  const startMaintenance = async (
    operation: RecordMaintenanceOperation,
    scope = maintenanceScope,
    targetIds = maintenanceTargetIds
  ): Promise<void> => {
    const recordUids = [...new Set(targetIds.map((uid) => uid.trim()).filter(Boolean))]
    if (scope === 'selected' && !recordUids.length) {
      message.info('请先选择需要维护的记录')
      return
    }
    if (maintenanceTaskIsActive) {
      message.info('当前已有数据维护任务，请等待任务结束或先安全停止')
      return
    }
    setMaintenanceSubmitting(true)
    setMaintenanceOperation(operation)
    maintenanceTerminalRef.current = ''
    try {
      if (typeof window.visslm.startRecordMaintenance !== 'function') {
        throw new Error('当前应用暂未提供数据维护能力')
      }
      const snapshot = await window.visslm.startRecordMaintenance({
        scope,
        ...(scope === 'selected' ? { recordUids } : {}),
        operation
      })
      applyMaintenanceSnapshot(snapshot)
      message.success(`${recordMaintenanceOperationLabels[operation]}任务已启动`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setMaintenanceSubmitting(false)
    }
  }

  const confirmStartMaintenance = (operation: RecordMaintenanceOperation): void => {
    const count = maintenancePreview?.totalCount
    const scopeLabel = maintenanceScope === 'selected'
      ? `已选 ${maintenanceTargetIds.length} 条记录`
      : '全部数据中心记录'
    modal.confirm({
      title: `确认${recordMaintenanceOperationLabels[operation]}？`,
      content: `将处理${scopeLabel}${count !== undefined ? `，预览共 ${count} 条` : ''}。任务会逐条执行，已完成结果会保留。`,
      okText: '确认开始',
      cancelText: '暂不执行',
      onOk: () => startMaintenance(operation)
    })
  }

  const confirmStopMaintenance = (): void => {
    modal.confirm({
      title: '安全停止当前维护任务？',
      content: '停止请求会在当前记录处理完成后生效，已经完成的记录不会回滚。',
      okText: '确认停止',
      okType: 'danger',
      cancelText: '继续执行',
      onOk: async () => {
        setMaintenanceStopPending(true)
        try {
          if (typeof window.visslm.stopRecordMaintenance !== 'function') {
            throw new Error('当前应用暂未提供停止维护能力')
          }
          const snapshot = await window.visslm.stopRecordMaintenance()
          if (snapshot) applyMaintenanceSnapshot(snapshot)
          message.info('已请求安全停止，当前记录完成后生效')
        } catch (error) {
          message.error(error instanceof Error ? error.message : String(error))
          throw error
        } finally {
          setMaintenanceStopPending(false)
        }
      }
    })
  }

  const retryFailedMaintenanceItems = (): void => {
    if (!maintenanceTask?.failedItems.length) return
    const failedIds = [...new Set(maintenanceTask.failedItems.map((item) => item.uid).filter(Boolean))]
    if (!failedIds.length) return
    setMaintenanceTargetUids(failedIds)
    setMaintenanceScope('selected')
    modal.confirm({
      title: `重试失败项（${failedIds.length} 条）？`,
      content: '只会重新处理上次失败的记录，成功记录不会重复执行。',
      okText: '重试失败项',
      cancelText: '暂不重试',
      onOk: () => startMaintenance(maintenanceTask.operation, 'selected', failedIds)
    })
  }

  const applyImportResult = (result: DataImportResult): boolean => {
    if (result.canceled) return false
    if (!result.ok) {
      message.error(result.message)
      return false
    }
    const transferMeta = dataTransferMetaText(result)
    message.success(transferMeta ? `${result.message}（${transferMeta}）` : result.message)
    if (result.errors.length) {
      modal.warning({
        title: '部分数据未导入',
        content: (
          <pre className="import-error-list">
            {result.errors.slice(0, 20).join('\n')}
          </pre>
        )
      })
    }
    if (result.reviewBatchId && result.duplicates.length) {
      setReview({ batchId: result.reviewBatchId, items: result.duplicates })
    }
    void loadImportRuns()
    setSelectedRowKeys([])
    onDataChanged()
    return true
  }

  const importData = async (): Promise<void> => {
    setImporting(true)
    try {
      const result = await window.visslm.importData()
      applyImportResult(result)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  const resumeImportRun = async (run: DataImportRunSnapshot): Promise<void> => {
    if (run.status !== 'failed' || typeof window.visslm.resumeDataImportRun !== 'function') return
    setResumingImportRunId(run.id)
    try {
      const result = await window.visslm.resumeDataImportRun(run.id)
      applyImportResult(result)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      void loadImportRuns()
    } finally {
      setResumingImportRunId(null)
    }
  }

  const exportData = async (): Promise<void> => {
    if (!total) {
      message.info('当前筛选结果没有可导出的数据')
      return
    }
    setExporting(true)
    try {
      const result = await window.visslm.exportData(recordFilters)
      if (result.canceled) return
      if (!result.ok) {
        message.error(result.message)
        return
      }
      const transferMeta = dataTransferMetaText(result)
      const exportCount = `实际导出 ${result.recordCount} 条记录`
      message.success(transferMeta
        ? `${result.message}（${exportCount} · ${transferMeta}）`
        : `${result.message}（${exportCount}）`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(false)
    }
  }

  const deleteData = (uids?: string[]): void => {
    const deletingAll = uids === undefined
    const count = deletingAll ? total : uids.length
    modal.confirm({
      title: deletingAll ? '确认删除全部数据？' : `确认删除选中的 ${count} 条数据？`,
      content: deletingAll
        ? '将清空数据中心内的项目、记录和图片。平台连接、模型和采集范围配置不会被删除。'
        : '记录关联的本地二进制图片资源也会一并清理，此操作不可撤销。',
      okText: deletingAll ? '全部删除' : '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setDeleting(true)
        try {
          const result = await window.visslm.deleteData(uids)
          message.success(result.message)
          setSelectedRowKeys([])
          setDetail(null)
          setPage(1)
          onDataChanged()
        } catch (error) {
          message.error(error instanceof Error ? error.message : String(error))
          throw error
        } finally {
          setDeleting(false)
        }
      }
    })
  }

  const handoffToVisualization = (): void => {
    const selectedRecords = selectedRowKeys.length > 0
    const scope: DataScope = selectedRecords
      ? { recordUids: selectedRowKeys }
      : {
          ...(projectId ? { projectIds: [projectId] } : {}),
          ...(nodeType ? { nodeTypes: [nodeType] } : {})
        }
    const parts = selectedRecords
      ? [`已选 ${selectedRowKeys.length} 条记录`]
      : [
          projectId
            ? `项目 ${projects.find((project) => project.uid === projectId)?.name ?? projectId}`
            : '',
          nodeType ? `类型 ${nodeType}` : ''
        ].filter(Boolean)
    onVisualize(scope, parts.join(' · '))
  }

  const maintenanceTaskPercent = maintenanceTask && maintenanceTask.total > 0
    ? Math.min(100, Math.round((maintenanceTask.current / maintenanceTask.total) * 100))
    : maintenanceTask && recordMaintenanceTerminalStatuses.includes(maintenanceTask.status)
      ? 100
      : 0
  const maintenanceProgressStatus = maintenanceTask?.status === 'completed'
    ? 'success'
    : maintenanceTask && ['completed_with_errors', 'failed', 'stopped'].includes(maintenanceTask.status)
      ? 'exception'
      : 'active'
  const maintenanceCanStart = Boolean(
    maintenancePreview &&
    maintenancePreview.totalCount > 0 &&
    !maintenancePreviewLoading &&
    !maintenancePreviewError &&
    !maintenanceTaskIsActive
  )
  const detailMaintenance = detail?.maintenance ?? fallbackMaintenanceState()

  return (
    <div className="page-stack">
      <div className="page-toolbar">
        <Space wrap>
          <Button
            icon={<ImportOutlined />}
            loading={importing}
            title="支持 .visslmpack 资源包，也兼容旧 JSON/JSONL 数据"
            onClick={() => void importData()}
          >
            导入资源包或旧数据
          </Button>
          <Button
            icon={<HistoryOutlined />}
            onClick={() => setImportRunsOpen(true)}
          >
            导入运行记录
          </Button>
          <Button
            icon={<ExportOutlined />}
            loading={exporting}
            disabled={loading || !total}
            title={loading
              ? '正在更新当前筛选结果，请稍候'
              : total
              ? `按当前筛选条件导出全部 ${total} 条记录，不受分页限制；生成 .visslmpack 二进制资源包`
              : '当前筛选结果为 0 条，暂无可导出数据'}
            onClick={() => void exportData()}
          >
            导出当前筛选结果（{total}）
          </Button>
          <Button
            icon={<ThunderboltOutlined />}
            onClick={openMaintenanceFromToolbar}
          >
            数据维护
            {selectedRowKeys.length ? `（${selectedRowKeys.length}）` : ''}
          </Button>
          <Button icon={<BulbOutlined />} onClick={openSemanticDictionary}>
            字段语义词典
          </Button>
          <Button
            type="primary"
            icon={<FundProjectionScreenOutlined />}
            disabled={!selectedRowKeys.length && !projectId && !nodeType}
            onClick={handoffToVisualization}
          >
            交给可视化专家
            {selectedRowKeys.length ? `（${selectedRowKeys.length}）` : ''}
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            loading={deleting}
            disabled={!selectedRowKeys.length}
            onClick={() => deleteData(selectedRowKeys)}
          >
            删除所选{selectedRowKeys.length ? `（${selectedRowKeys.length}）` : ''}
          </Button>
          <Button
            danger
            type="primary"
            icon={<DeleteOutlined />}
            loading={deleting}
            disabled={!total}
            onClick={() => deleteData()}
          >
            全部删除
          </Button>
        </Space>
      </div>
      <Card className="data-workbench-card">
        <div className="filter-bar asset-center-filter-bar">
          <Input.Search
            allowClear
            placeholder="搜索名称、编号和正文"
            prefix={<SearchOutlined />}
            onSearch={(value) => {
              setSearch(value)
              setPage(1)
            }}
            style={{ width: 360 }}
          />
          <Select
            allowClear
            placeholder="全部项目"
            value={projectId}
            onChange={(value) => {
              setProjectId(value)
              setPage(1)
            }}
            options={projects.map((project) => ({ label: project.name, value: project.uid }))}
            style={{ width: 220 }}
          />
          <Select
            allowClear
            placeholder="全部类型"
            value={nodeType}
            onChange={(value) => {
              setNodeType(value)
              setPage(1)
            }}
            options={nodeTypes.map((type) => ({ label: type, value: type }))}
            style={{ width: 160 }}
          />
          <Select<string>
            allowClear
            showSearch
            className="asset-release-filter"
            loading={releaseValuesLoading}
            value={releaseText}
            placeholder="发布属性（_valm_Release_text）"
            aria-label="按发布属性（_valm_Release_text）筛选"
            style={{ width: 280 }}
            filterOption={(input, option) => String(option?.value ?? '').toLocaleLowerCase().includes(input.trim().toLocaleLowerCase())}
            options={releaseValues.map(({ value, count }) => ({
              value,
              label: (
                <span className="push-release-option">
                  <span className="push-release-option-value" title={value || '空值'}>
                    {value || '（空值）'}
                  </span>
                  <span className="push-release-option-count">{count} 条</span>
                </span>
              )
            }))}
            onChange={(value) => {
              setReleaseText(value)
              setPage(1)
              setSelectedRowKeys([])
            }}
          />
          <Select<RequirementSemanticizationStatus | 'all'>
            value={semanticStatusFilter}
            onChange={(value) => {
              setSemanticStatusFilter(value)
              setPage(1)
            }}
            options={[
              { label: '全部', value: 'all' },
              { label: '待语义化', value: 'pending' },
              { label: '处理中', value: 'processing' },
              { label: '已完成', value: 'ready' },
              { label: '失败', value: 'failed' }
            ]}
            style={{ width: 140 }}
          />
        </div>
        <ResizableTable<RecordRow>
          tableKey="asset-center-records"
          rowKey="uid"
          rowSelection={{
            selectedRowKeys,
            preserveSelectedRowKeys: true,
            onChange: (keys) => setSelectedRowKeys(keys.map(String))
          }}
          loading={loading}
          dataSource={records}
          scroll={{ x: 1670, y: appTableScrollY }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 条`
          }}
          onChange={(pagination: TablePaginationConfig) => {
            setPage(pagination.current ?? 1)
            setPageSize(pagination.pageSize ?? 20)
          }}
          onRow={(record) => ({
            onDoubleClick: () => void openDetail(record.uid)
          })}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              width: 260,
              ellipsis: true,
              render: (name: string, record) => (
                <Button
                  type="link"
                  className="table-link"
                  title={name || '未命名记录'}
                  onClick={() => void openDetail(record.uid)}
                >
                  {name}
                </Button>
              )
            },
            { title: '类型', dataIndex: 'nodeType', width: 130, render: (v) => <Tag>{v || '—'}</Tag> },
            { title: '对象编号', dataIndex: 'itemId', width: 180, ellipsis: true },
            {
              title: '发布属性',
              dataIndex: 'releaseText',
              width: 220,
              ellipsis: true,
              render: (value: string) => (
                <span title={value || '空值'}>{value || '—'}</span>
              )
            },
            {
              title: '描述',
              dataIndex: 'description',
              width: 360,
              ellipsis: true,
              render: (description: string) => {
                const text = plainTextFromHtml(description)
                return (
                  <span className="description-cell" title={text}>
                    {text || '—'}
                  </span>
                )
              }
            },
            { title: 'UID', dataIndex: 'uid', width: 120, ellipsis: true },
            { title: '项目 UID', dataIndex: 'projectId', width: 120, ellipsis: true },
            {
              title: '数据状态',
              key: 'pushStatus',
              width: 110,
              render: (_value, record) => renderPushStatus(record)
            },
            {
              title: 'AI 语义化',
              key: 'semanticStatus',
              width: 130,
              render: (_value, record) => renderSemanticStatus(record)
            },
            { title: '图片', dataIndex: 'imageCount', width: 80 },
            {
              title: '最后修改',
              dataIndex: 'lastModifyTime',
              width: 180,
              render: formatDate
            },
          ]}
        />
      </Card>
      <Drawer
        rootClassName="semantic-dictionary-drawer-shell"
        className="semantic-dictionary-drawer"
        title={(
          <div className="drawer-context-title">
            <BulbOutlined />
            <span>字段语义词典</span>
            <strong>{projectId
              ? projects.find((project) => project.uid === projectId)?.name ?? projectId
              : '全部项目'}</strong>
          </div>
        )}
        extra={(
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={semanticProfilesLoading}
            onClick={() => void loadSemanticProfiles()}
          >
            刷新
          </Button>
        )}
        size={960}
        open={semanticDictionaryOpen}
        onClose={() => {
          setSemanticDictionaryOpen(false)
          setSemanticEditing(null)
        }}
      >
        <div className="semantic-dictionary-panel">
          <Alert
            type="info"
            showIcon
            message="人工维护的显示名、角色和业务别名会进入 Agent 字段目录；同一别名映射多个字段时，Agent 会先要求澄清。"
          />
          <ResizableTable<FieldProfile>
            tableKey="asset-field-semantics"
            rowKey="field"
            loading={semanticProfilesLoading}
            dataSource={semanticProfiles}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            scroll={{ x: 1100, y: 'min(560px, max(260px, calc(100vh - 280px)))' }}
            locale={{ emptyText: '当前范围暂无可维护字段' }}
            columns={[
              { title: '原始字段', dataIndex: 'field', width: 220, ellipsis: true },
              {
                title: '业务显示名',
                dataIndex: 'displayName',
                width: 180,
                ellipsis: true,
                render: (value: string) => value || '—'
              },
              {
                title: '角色',
                dataIndex: 'role',
                width: 110,
                render: (value: FieldProfileRole | undefined) => value
                  ? <Tag>{({ dimension: '维度', measure: '度量', time: '时间', identifier: '标识' } as const)[value]}</Tag>
                  : '—'
              },
              {
                title: '业务别名',
                dataIndex: 'synonyms',
                width: 260,
                ellipsis: true,
                render: (values: string[] | undefined) => values?.join('、') || '—'
              },
              {
                title: '类型 / 覆盖率',
                key: 'profile',
                width: 180,
                render: (_value, profile) => `${profile.declaredType ?? profile.inferredType} · ${Math.round(profile.nonNullRate * 100)}%`
              },
              {
                title: '操作',
                key: 'actions',
                width: 100,
                render: (_value, profile) => (
                  <Button type="link" size="small" onClick={() => editSemanticProfile(profile)}>
                    纠正
                  </Button>
                )
              }
            ]}
          />
        </div>
      </Drawer>
      <Modal
        title={`纠正字段语义 · ${semanticEditing?.field ?? ''}`}
        open={Boolean(semanticEditing)}
        okText="保存语义"
        cancelText="取消"
        confirmLoading={semanticSaving}
        width="min(640px, calc(100vw - 32px))"
        onOk={() => void saveSemanticProfile()}
        onCancel={() => setSemanticEditing(null)}
      >
        <Form layout="vertical" className="semantic-dictionary-form">
          <Form.Item label="业务显示名" extra="留空可清除人工显示名，Agent 仍使用原始字段名。">
            <Input
              value={semanticDisplayName}
              maxLength={120}
              placeholder="例如：负责人"
              onChange={(event) => setSemanticDisplayName(event.target.value)}
            />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="字段角色">
                <Select<FieldProfileRole>
                  value={semanticRole}
                  options={[
                    { value: 'dimension', label: '维度' },
                    { value: 'measure', label: '度量' },
                    { value: 'time', label: '时间' },
                    { value: 'identifier', label: '唯一标识' }
                  ]}
                  onChange={setSemanticRole}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="敏感级别">
                <Select<FieldSensitivity>
                  value={semanticSensitivity}
                  options={[
                    { value: 'normal', label: '普通' },
                    { value: 'internal', label: '内部' },
                    { value: 'sensitive', label: '敏感' }
                  ]}
                  onChange={setSemanticSensitivity}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="业务别名" extra="使用顿号、逗号或换行分隔；留空可清除人工别名。">
            <Input.TextArea
              value={semanticSynonyms}
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder="例如：责任人、经办人、Owner"
              onChange={(event) => setSemanticSynonyms(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        rootClassName="data-import-runs-drawer-shell"
        className="data-import-runs-drawer"
        title={(
          <div className="drawer-context-title">
            <HistoryOutlined />
            <span>数据导入</span>
            <strong>运行记录</strong>
          </div>
        )}
        extra={(
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={importRunsLoading}
            aria-label="刷新导入运行记录"
            onClick={() => void loadImportRuns()}
          >
            刷新
          </Button>
        )}
        size={960}
        open={importRunsOpen}
        onClose={() => setImportRunsOpen(false)}
      >
        <div className="data-import-runs-panel">
          <Text type="secondary">
            运行记录用于查看大文件旧 JSON/JSONL 导入的批次检查点。应用在导入中途退出时，已提交批次会保留并标记为中断；确认原文件仍在后，可从最后一个已提交批次继续，记录默认保留 30 天。
          </Text>
          <ResizableTable<DataImportRunSnapshot>
            tableKey="data-import-runs"
            rowKey="id"
            loading={importRunsLoading}
            dataSource={importRuns}
            pagination={false}
            scroll={{ x: 1680, y: 'min(560px, max(260px, calc(100vh - 260px)))' }}
            locale={{ emptyText: '暂无导入运行记录' }}
            columns={[
              {
                title: '状态',
                dataIndex: 'status',
                width: 100,
                render: (status: DataImportRunSnapshot['status']) => {
                  const meta = dataImportRunStatusMeta[status] ?? { label: '未知', color: 'default' }
                  return <Tag color={meta.color}>{meta.label}</Tag>
                }
              },
              {
                title: '文件',
                dataIndex: 'path',
                width: 280,
                ellipsis: true,
                render: (path: string) => <span title={path}>{path || '—'}</span>
              },
              {
                title: '格式',
                dataIndex: 'format',
                width: 100,
                render: (format: DataImportRunSnapshot['format']) => format.toUpperCase()
              },
              { title: '批次', dataIndex: 'batchCount', width: 84 },
              { title: '源行', dataIndex: 'sourceRowCount', width: 100 },
              { title: '已导入', dataIndex: 'importedRecordCount', width: 100 },
              { title: '跳过', dataIndex: 'skippedCount', width: 84 },
              { title: '解析错误', dataIndex: 'parseErrorCount', width: 104 },
              {
                title: '审查批次',
                dataIndex: 'reviewBatchId',
                width: 180,
                ellipsis: true,
                render: (value: string) => <span title={value}>{value || '—'}</span>
              },
              {
                title: '更新时间',
                dataIndex: 'updatedAt',
                width: 180,
                render: formatDate
              },
              {
                title: '错误信息',
                dataIndex: 'errorMessage',
                width: 300,
                ellipsis: true,
                render: (value: string) => <span title={value}>{value || '—'}</span>
              },
              {
                title: '操作',
                key: 'actions',
                width: 112,
                render: (_value, run) => run.status === 'failed' && typeof window.visslm.resumeDataImportRun === 'function'
                  ? (
                    <Button
                      size="small"
                      type="link"
                      loading={resumingImportRunId === run.id}
                      disabled={Boolean(resumingImportRunId && resumingImportRunId !== run.id)}
                      onClick={() => void resumeImportRun(run)}
                    >
                      继续导入
                    </Button>
                  )
                  : '—'
              }
            ]}
          />
        </div>
      </Drawer>
      <Drawer
        rootClassName="record-detail-drawer-shell"
        className="record-detail-drawer"
        title={detail ? (
          <div className="drawer-context-title">
            <DatabaseOutlined />
            <span>数据中心记录</span>
            <strong title={detail.name}>{detail.name}</strong>
          </div>
        ) : '数据中心记录'}
        size={960}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <div className="detail-stack">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="UID">{detail.uid}</Descriptions.Item>
              <Descriptions.Item label="类型">{detail.nodeType}</Descriptions.Item>
              <Descriptions.Item label="对象编号">{detail.itemId || '—'}</Descriptions.Item>
              <Descriptions.Item label="项目 UID">{detail.projectId}</Descriptions.Item>
              <Descriptions.Item label="AI 语义化">
                {renderSemanticStatus(detail)}
              </Descriptions.Item>
              <Descriptions.Item label="最后修改" span={2}>
                {formatDate(detail.lastModifyTime)}
              </Descriptions.Item>
            </Descriptions>
            <section className="record-maintenance-readiness" aria-label="匹配准备度">
              <div className="record-maintenance-readiness-heading">
                <div>
                  <Text strong>匹配准备度</Text>
                  <Text type="secondary">查看清理、全文索引和向量索引的可用状态</Text>
                </div>
                <Button
                  size="small"
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  onClick={() => openMaintenancePanel('selected', [detail.uid], true)}
                >
                  优化此记录
                </Button>
              </div>
              <div className="record-maintenance-readiness-grid" role="list" aria-label="匹配准备度状态">
                {recordMaintenanceIndexDefinitions.map(({ key, label }) => {
                  const index = detailMaintenance[key]
                  const meta = recordMaintenanceIndexStatusMeta[index.status]
                  return (
                    <div className="record-maintenance-readiness-item" key={key} role="listitem">
                      <div className="record-maintenance-readiness-item-heading">
                        <strong>{label}</strong>
                        <Tag color={meta.color}>{meta.label}</Tag>
                      </div>
                      <dl>
                        <div><dt>版本</dt><dd title={index.version}>{index.version || '—'}</dd></div>
                        <div><dt>模型</dt><dd title={index.modelVersion || undefined}>{index.modelVersion || '—'}</dd></div>
                        <div><dt>分块</dt><dd>{index.chunkCount ?? '—'}</dd></div>
                        <div><dt>更新时间</dt><dd>{formatDate(index.updatedAt)}</dd></div>
                      </dl>
                      {index.error && (
                        <p className="record-maintenance-index-error" title={index.error}>
                          <ExclamationCircleOutlined />
                          <span>{index.error}</span>
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
            <Divider titlePlacement="start">描述</Divider>
            <RichDescription html={detail.description} images={detail.images} />
            {detail.images.length > 0 && (
              <>
                <Divider titlePlacement="start">图片资源</Divider>
                <Image.PreviewGroup>
                  <div className="image-grid">
                    {detail.images.map((image) => (
                      <div className="image-tile" key={image.id}>
                        <Image src={image.assetUrl ?? ''} alt={image.name} fallback="" />
                        <Text ellipsis>{image.name || image.sha256.slice(0, 12)}</Text>
                      </div>
                    ))}
                  </div>
                </Image.PreviewGroup>
              </>
            )}
            <Divider titlePlacement="start">匹配文本</Divider>
            <pre className="matching-text-preview">{detail.matchingText || detail.normalizedText || '暂无可用于匹配的文本'}</pre>
            <Collapse
              className="record-detail-raw-collapse"
              items={[{
                key: 'raw',
                label: '原始 JSON（低频信息）',
                children: <pre className="json-preview">{JSON.stringify(detail.raw, null, 2)}</pre>
              }]}
            />
          </div>
        )}
      </Drawer>
      <Drawer
        rootClassName="record-maintenance-drawer-shell"
        className="record-maintenance-drawer"
        title={(
          <div className="drawer-context-title">
            <ThunderboltOutlined />
            <span>数据维护</span>
            <strong>{maintenanceTask ? recordMaintenanceTaskStatusLabels[maintenanceTask.status] : '执行前预览'}</strong>
          </div>
        )}
        size={640}
        open={maintenanceOpen}
        mask={!maintenanceOpenFromDetail}
        maskClosable={false}
        onClose={() => {
          setMaintenanceOpen(false)
          setMaintenanceOpenFromDetail(false)
        }}
      >
        <div className="record-maintenance-panel">
          <section className="record-maintenance-section record-maintenance-preview" aria-label="数据维护执行前预览">
            <div className="record-maintenance-section-heading">
              <div>
                <Text strong>执行前预览</Text>
                <Text type="secondary">只读扫描当前范围，不会修改数据。</Text>
              </div>
              {maintenancePreviewLoading && <Spin size="small" aria-label="正在生成维护预览" />}
            </div>
            {maintenancePreviewError ? (
              <Alert type="warning" showIcon message={maintenancePreviewError} />
            ) : maintenancePreview ? (
              <>
                <div className="record-maintenance-preview-grid" role="list" aria-label="维护预览数量">
                  <div role="listitem"><span>范围记录</span><strong>{maintenancePreview.totalCount}</strong></div>
                  <div role="listitem"><span>待清理</span><strong>{maintenancePreview.cleanPendingCount}</strong></div>
                  <div role="listitem"><span>待全文索引</span><strong>{maintenancePreview.lexicalPendingCount}</strong></div>
                  <div role="listitem"><span>待向量索引</span><strong>{maintenancePreview.vectorPendingCount}</strong></div>
                  <div role="listitem"><span>语义失效</span><strong>{maintenancePreview.semanticInvalidationCount}</strong></div>
                </div>
                <div className="record-maintenance-preview-versions" aria-label="维护版本">
                  <span>规范化 {maintenancePreview.normalizerVersion || '—'}</span>
                  <span>全文 {maintenancePreview.lexicalVersion || '—'}</span>
                  <span>模型 {maintenancePreview.modelVersion || '—'}</span>
                  <span>扫描于 {formatDate(maintenancePreview.scannedAt)}</span>
                </div>
              </>
            ) : (
              <div className="record-maintenance-empty">正在读取当前范围的可维护项。</div>
            )}
          </section>

          <section className="record-maintenance-section record-maintenance-scope-section" aria-label="数据维护范围">
            <div className="record-maintenance-section-heading">
              <div>
                <Text strong>处理范围</Text>
                <Text type="secondary">默认优先使用当前已选记录。</Text>
              </div>
            </div>
            <Segmented
              aria-label="数据维护范围"
              value={maintenanceScope}
              options={[
                { label: `已选记录（${maintenanceTargetIds.length}）`, value: 'selected', disabled: !maintenanceTargetIds.length },
                { label: '全部记录', value: 'all' }
              ]}
              onChange={(value) => setMaintenanceScope(value as RecordMaintenanceScope)}
            />
          </section>

          <section className="record-maintenance-section record-maintenance-actions-section" aria-label="数据维护操作">
            <div className="record-maintenance-section-heading">
              <div>
                <Text strong>执行操作</Text>
                <Text type="secondary">维护任务会逐条处理，完成后自动刷新列表和详情。</Text>
              </div>
            </div>
            <div className="record-maintenance-action-grid">
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={maintenanceSubmitting && maintenanceOperation === 'optimize'}
                disabled={!maintenanceCanStart || maintenanceSubmitting}
                onClick={() => confirmStartMaintenance('optimize')}
              >
                一键优化匹配
              </Button>
              <Button
                icon={<ClearOutlined />}
                loading={maintenanceSubmitting && maintenanceOperation === 'clean'}
                disabled={!maintenanceCanStart || maintenanceSubmitting}
                onClick={() => confirmStartMaintenance('clean')}
              >
                仅清理数据
              </Button>
              <Button
                icon={<DatabaseOutlined />}
                loading={maintenanceSubmitting && maintenanceOperation === 'rebuild_indexes'}
                disabled={!maintenanceCanStart || maintenanceSubmitting}
                onClick={() => confirmStartMaintenance('rebuild_indexes')}
              >
                仅重建索引
              </Button>
            </div>
          </section>

          {maintenanceTask && (
            <section
              className={`record-maintenance-section record-maintenance-task-panel is-${maintenanceTask.status}`}
              aria-label="数据维护任务状态"
            >
              <div className="record-maintenance-task-heading">
                <div>
                  <div className="record-maintenance-task-title">
                    <Text strong>当前维护任务</Text>
                    <Tag color={maintenanceTask.status === 'completed'
                      ? 'success'
                      : maintenanceTask.status === 'completed_with_errors' || maintenanceTask.status === 'failed'
                        ? 'warning'
                        : maintenanceTask.status === 'stopped'
                          ? 'default'
                          : 'processing'}>
                      {recordMaintenanceTaskStatusLabels[maintenanceTask.status]}
                    </Tag>
                  </div>
                  <Text type="secondary" aria-live="polite">
                    {maintenanceTask.message || recordMaintenanceOperationLabels[maintenanceTask.operation]}
                  </Text>
                </div>
                <Button
                  danger
                  size="small"
                  icon={<StopOutlined />}
                  loading={maintenanceStopPending}
                  disabled={!maintenanceTaskIsActive || maintenanceStopPending || maintenanceTask.status === 'stopping'}
                  onClick={confirmStopMaintenance}
                >
                  安全停止
                </Button>
              </div>
              <div className="record-maintenance-task-current">
                <div>
                  <span>当前阶段</span>
                  <strong>{recordMaintenanceStageLabels[maintenanceTask.stage]}</strong>
                </div>
                <div>
                  <span>当前记录</span>
                  <strong title={maintenanceTask.currentName || maintenanceTask.currentUid || undefined}>
                    {maintenanceTask.currentName || maintenanceTask.currentUid || '等待开始'}
                  </strong>
                </div>
              </div>
              <Tooltip title={`已处理 ${maintenanceTask.current} / ${maintenanceTask.total} 条`}>
                <Progress
                  percent={maintenanceTaskPercent}
                  status={maintenanceProgressStatus}
                  showInfo={false}
                  aria-label={`数据维护进度 ${maintenanceTaskPercent}%`}
                />
              </Tooltip>
              <div className="record-maintenance-task-metrics" aria-label="数据维护任务统计">
                <span><strong>{maintenanceTask.current}</strong><small>已处理</small></span>
                <span className="is-success"><strong>{maintenanceTask.succeeded}</strong><small>成功</small></span>
                <span className="is-error"><strong>{maintenanceTask.failed}</strong><small>失败</small></span>
                <span><strong>{Math.max(0, maintenanceTask.total - maintenanceTask.current)}</strong><small>剩余</small></span>
              </div>
              {maintenanceTask.status === 'completed_with_errors' && (
                <Alert type="warning" showIcon message="维护已完成，但仍有失败记录，可在下方重试。" />
              )}
              {maintenanceTask.status === 'stopped' && (
                <Alert type="info" showIcon message="任务已安全停止，已完成的记录结果已保留。" />
              )}
              {maintenanceTask.status === 'failed' && (
                <Alert type="error" showIcon message={maintenanceTask.message || '维护任务失败，请检查失败记录。'} />
              )}
              {maintenanceTask.failedItems.length > 0 && (
                <div className="record-maintenance-failed-items">
                  <div className="record-maintenance-failed-heading">
                    <Text strong>失败记录（{maintenanceTask.failedItems.length}）</Text>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      disabled={maintenanceTaskIsActive || maintenanceSubmitting}
                      onClick={retryFailedMaintenanceItems}
                    >
                      重试失败项
                    </Button>
                  </div>
                  <ul>
                    {maintenanceTask.failedItems.slice(0, 12).map((item) => (
                      <li key={`${item.uid}-${item.stage}`}>
                        <span title={item.name || item.uid}>{item.name || item.uid}</span>
                        <small>{recordMaintenanceStageLabels[item.stage]}</small>
                        <Text type="secondary" title={item.error}>{item.error}</Text>
                      </li>
                    ))}
                  </ul>
                  {maintenanceTask.failedItems.length > 12 && (
                    <Text type="secondary">其余失败记录可通过重试失败项再次处理。</Text>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </Drawer>
      {review && (
        <DataReviewModal
          source="import"
          batchId={review.batchId}
          items={review.items}
          onClose={() => setReview(null)}
          onApplied={(result) => {
            if (result.updatedCount > 0) onDataChanged()
            setReview((current) => {
              if (!current) return current
              const resolved = new Set(result.resolvedReviewIds)
              const items = current.items.filter((item) => !resolved.has(item.id))
              return items.length ? { ...current, items } : null
            })
          }}
        />
      )}
    </div>
  )
}

function SemanticizationPage({
  refreshKey,
  onDataChanged,
  onOpenSettings
}: {
  refreshKey: number
  onDataChanged: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [nodeTypes, setNodeTypes] = useState<string[]>([])
  const [records, setRecords] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [projectId, setProjectId] = useState<string>()
  const [nodeType, setNodeType] = useState<string>()
  const [statusFilter, setStatusFilter] = useState<RequirementSemanticizationStatus | 'all'>('all')
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [detail, setDetail] = useState<RecordDetail | null>(null)
  const [semanticSubmitting, setSemanticSubmitting] = useState(false)
  const [semanticActionUids, setSemanticActionUids] = useState<string[]>([])
  const [semanticTask, setSemanticTask] = useState<SemanticizationTaskSnapshot | null>(null)
  const [semanticDeepThinking, setSemanticDeepThinking] = useState<boolean>(() => readSemanticDeepThinking())
  const [semanticControlPending, setSemanticControlPending] = useState<SemanticizationControlAction | null>(null)
  const [semanticAuditHistory, setSemanticAuditHistory] = useState<SemanticAuditEventView[]>([])
  const semanticTaskSnapshotSignatureRef = useRef<string | null>(null)
  const semanticTerminalRefreshJobRef = useRef<string | null>(null)

  const semanticTaskIsActive = Boolean(
    semanticTask && semanticTaskActiveStatuses.includes(semanticTask.status)
  )

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await window.visslm.listRecords({
        page,
        pageSize,
        search,
        projectId,
        nodeType,
        ...(statusFilter !== 'all' ? { semanticStatus: statusFilter } : {})
      })
      setRecords(data.rows)
      setTotal(data.total)
    } finally {
      setLoading(false)
    }
  }, [nodeType, page, pageSize, projectId, search, statusFilter])

  useEffect(() => {
    void Promise.all([window.visslm.listProjects(), window.visslm.listNodeTypes()]).then(
      ([projectRows, types]) => {
        setProjects(projectRows)
        setNodeTypes(types)
      }
    )
  }, [refreshKey])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const updateRecordsFromSemanticTask = useCallback((snapshot: SemanticizationTaskSnapshot): void => {
    const updates = new Map<string, { status: RequirementSemanticizationStatus; error: string }>()
    const recentItems = Array.isArray(snapshot.recentItems) ? snapshot.recentItems : []
    recentItems.forEach((item) => {
      const uid = item.uid.trim()
      if (!uid) return
      updates.set(uid, item.status === 'failed'
        ? { status: 'failed', error: item.error || '语义化失败' }
        : { status: 'ready', error: '' })
    })
    const currentUid = semanticTaskCurrentUid(snapshot)
    if (currentUid && semanticTaskActiveStatuses.includes(snapshot.status)) {
      updates.set(currentUid, { status: 'processing', error: '' })
    }
    if (!updates.size) return
    setRecords((current) => {
      let changed = false
      const next = current.map((record) => {
        const update = updates.get(record.uid)
        if (!update) return record
        const semanticStatusReason: RecordRow['semanticStatusReason'] = update.status === 'processing'
          ? 'processing'
          : update.status === 'ready'
            ? 'ready'
            : 'failed'
        if (record.semanticStatus === update.status &&
          record.semanticStatusReason === semanticStatusReason &&
          (record.semanticError ?? '') === update.error) {
          return record
        }
        changed = true
        return {
          ...record,
          semanticStatus: update.status,
          semanticStatusReason,
          semanticError: update.error
        }
      })
      return changed ? next : current
    })
  }, [])

  const applySemanticTaskSnapshot = useCallback((snapshot: SemanticizationTaskSnapshot): boolean => {
    const signature = semanticTaskSnapshotSignatureOf(snapshot)
    if (semanticTaskSnapshotSignatureRef.current === signature) return false
    semanticTaskSnapshotSignatureRef.current = signature
    setSemanticTask(snapshot)
    const messageText = semanticTaskDisplayMessageOf(snapshot)
    const isRetry = /重试|retry/i.test(messageText)
    const isValidation = snapshot.currentStage === 'persisting' || /校验|验证|valid/i.test(messageText)
    const traceEvents = Array.isArray(snapshot.analysisTrace?.events) ? snapshot.analysisTrace.events : []
    const lastTraceEvent = traceEvents.length ? traceEvents[traceEvents.length - 1] : undefined
    const event: SemanticAuditEventView = {
      id: `${snapshot.jobId}-${lastTraceEvent?.id ?? `${snapshot.status}-${snapshot.currentStage}`}-${messageText}`,
      kind: isRetry ? 'retry' : isValidation ? 'validation' : 'stage',
      status: snapshot.status === 'completed'
        ? 'success'
        : snapshot.status === 'stopped'
          ? 'error'
          : isRetry
            ? 'warning'
            : snapshot.currentStage === 'persisting'
              ? 'running'
              : 'info',
      title: isRetry ? '模型重试' : isValidation ? '结构化结果校验' : semanticTaskStageLabels[snapshot.currentStage],
      detail: messageText,
      timestamp: snapshot.updatedAt
    }
    setSemanticAuditHistory((current) => current.some((item) => item.id === event.id)
      ? current
      : [...current, event].slice(-32))
    updateRecordsFromSemanticTask(snapshot)
    return true
  }, [updateRecordsFromSemanticTask])

  const hydrateSemanticTask = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await window.visslm.getRequirementSemanticizationTask()
      if (snapshot === null) {
        semanticTaskSnapshotSignatureRef.current = null
        setSemanticTask(null)
        return
      }
      applySemanticTaskSnapshot(snapshot)
    } catch {
      // The record workbench remains available if task recovery is temporarily unavailable.
    }
  }, [applySemanticTaskSnapshot])

  useEffect(() => {
    void hydrateSemanticTask()
  }, [hydrateSemanticTask, refreshKey])

  useEffect(() => window.visslm.onRequirementSemanticizationProgress((snapshot) => {
    const applied = applySemanticTaskSnapshot(snapshot)
    if (applied && (snapshot.status === 'completed' || snapshot.status === 'stopped') &&
      semanticTerminalRefreshJobRef.current !== snapshot.jobId) {
      semanticTerminalRefreshJobRef.current = snapshot.jobId
      void load()
    }
  }), [applySemanticTaskSnapshot, load])

  const startSemanticization = async (
    input: SemanticizationStartInput,
    source: 'toolbar' | 'row'
  ): Promise<void> => {
    const recordUids = [...new Set((input.recordUids ?? []).map((uid) => uid.trim()).filter(Boolean))]
    if (input.scope !== 'all_unready' && !recordUids.length) {
      message.info(source === 'toolbar' ? '当前范围没有可处理记录' : '这条记录当前无法执行 AI 语义化')
      return
    }
    if (semanticTaskIsActive) {
      message.info('当前已有语义化任务，请等待任务结束或先停止当前任务')
      return
    }
    if (source === 'toolbar') setSemanticSubmitting(true)
    setSemanticActionUids((current) => [...new Set([...current, ...recordUids])])
    setSemanticAuditHistory([])
    try {
      const result = await window.visslm.startRequirementSemanticization({
        ...input,
        ...(input.scope === 'selected' || input.scope === undefined ? { recordUids } : {}),
        // Keep the legacy deepThinking flag for older IPC consumers while
        // explicitly selecting the adaptive quality route when supported.
        deepThinking: semanticDeepThinking,
        qualityMode: semanticDeepThinking ? 'strict' : 'standard'
      })
      if (result.accepted > 0) {
        const timestamp = new Date().toISOString()
        const optimisticTask: SemanticizationTaskSnapshot = {
          jobId: result.jobId,
          status: 'queued',
          currentStage: 'queued',
          total: result.accepted,
          available: result.available,
          completed: 0,
          succeeded: 0,
          failed: 0,
          remaining: result.accepted,
          startedAt: timestamp,
          updatedAt: timestamp,
          message: `已提交 ${result.accepted} 条记录；${semanticTaskExecutionPolicyHint}，任务将按所选质量模式自适应处理`,
          recentItems: [],
          deepThinking: semanticDeepThinking,
          qualityMode: semanticDeepThinking ? 'strict' : 'standard'
        }
        semanticTaskSnapshotSignatureRef.current = semanticTaskSnapshotSignatureOf(optimisticTask)
        setSemanticTask(optimisticTask)
        message.success(`已提交 ${result.accepted} 条记录进行 AI 语义化`)
      } else if (result.skipped > 0) {
        message.info(`没有新的任务，已跳过 ${result.skipped} 条记录`)
      } else {
        message.info('当前没有未语义化、失败或已失效的记录')
      }
      if (result.skipped > 0 && result.accepted > 0) {
        message.info(`另有 ${result.skipped} 条记录未加入本次任务，可能已就绪、处理中或不可用`)
      }
      await hydrateSemanticTask()
      void load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (source === 'toolbar') setSemanticSubmitting(false)
      setSemanticActionUids((current) => current.filter((uid) => !recordUids.includes(uid)))
    }
  }

  const controlSemanticization = async (action: SemanticizationControlAction): Promise<void> => {
    if (!semanticTask || semanticControlPending) return
    setSemanticControlPending(action)
    try {
      const next = await window.visslm.controlRequirementSemanticization(action)
      if (next) applySemanticTaskSnapshot(next)
      if (action === 'pause') message.info('已请求暂停，当前 AI 阶段完成后生效')
      if (action === 'resume') message.success('已恢复语义化任务')
      if (action === 'stop') message.info('已请求停止，正在取消在途 AI 请求并安全退出')
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSemanticControlPending(null)
    }
  }

  const confirmStopSemanticization = (): void => {
    modal.confirm({
      title: '停止当前语义化任务？',
      content: '停止请求会在当前 AI 阶段安全完成后生效，已完成的记录会保留。',
      okText: '确认停止',
      okType: 'danger',
      cancelText: '继续执行',
      onOk: () => controlSemanticization('stop')
    })
  }

  const currentPageSemanticizableRows = records.filter((record) => {
    const status = normalizeSemanticStatus(record.semanticStatus)
    return status === 'pending' || status === 'failed'
  })
  const taskPercent = semanticTask && semanticTask.total > 0
    ? Math.min(100, Math.round((semanticTask.completed / semanticTask.total) * 100))
    : 0
  const taskCanPause = semanticTask?.status === 'queued' || semanticTask?.status === 'running'
  const taskCanResume = semanticTask?.status === 'paused'
  const taskCanStop = Boolean(
    semanticTask && semanticTaskActiveStatuses.includes(semanticTask.status) && semanticTask.status !== 'stopping'
  )
  const detailAuditTask = useMemo(
    () => detail ? persistedSemanticAuditTask(detail) : null,
    [detail]
  )
  const detailAuditRecords = useMemo(
    () => detail ? [detail] : [],
    [detail]
  )

  return (
    <div className="semanticization-page page-stack">
      <Card className="semanticization-launch-card">
          <div className="semanticization-card-heading">
            <div>
              <Text strong>任务配置与数据范围</Text>
              <Text type="secondary">批量任务会自动处理当前全部未就绪记录；在线模型自动并发处理，本地模型保持单路保护，并根据所选质量模式自适应执行。</Text>
            </div>
            <Button icon={<SettingOutlined />} onClick={onOpenSettings}>模型设置</Button>
          </div>
          <div className="page-toolbar semanticization-toolbar">
            <div className="semanticization-thinking-config">
            <div>
              <span>质量模式</span>
              <small>{semanticTaskModeDescriptionOf(semanticDeepThinking ? 'strict' : 'standard')}</small>
            </div>
            <Switch
              aria-label="语义化质量模式"
              checked={semanticDeepThinking}
              checkedChildren="严格"
              unCheckedChildren="标准"
              title={semanticTaskModeDescriptionOf(semanticDeepThinking ? 'strict' : 'standard')}
              disabled={semanticTaskIsActive}
              onChange={(checked) => {
                setSemanticDeepThinking(checked)
                writeSemanticDeepThinking(checked)
              }}
            />
          </div>
          <Button
            icon={<BulbOutlined />}
            loading={semanticSubmitting}
            disabled={!selectedRowKeys.length || semanticTaskIsActive}
            onClick={() => void startSemanticization({ scope: 'selected', recordUids: selectedRowKeys, force: true }, 'toolbar')}
          >
            处理所选（{selectedRowKeys.length}）
          </Button>
          <Button
            icon={<BulbOutlined />}
            loading={semanticSubmitting}
            disabled={!currentPageSemanticizableRows.length || semanticTaskIsActive}
            onClick={() => void startSemanticization({
              scope: 'selected',
              recordUids: currentPageSemanticizableRows.map((record) => record.uid)
            }, 'toolbar')}
          >
            当前页待处理{currentPageSemanticizableRows.length ? `（${currentPageSemanticizableRows.length}）` : ''}
          </Button>
          <Button
            type="primary"
            icon={<BulbOutlined />}
            loading={semanticSubmitting}
            disabled={semanticTaskIsActive}
            onClick={() => void startSemanticization({ scope: 'all_unready' }, 'toolbar')}
          >
            处理全部未语义化数据
          </Button>
        </div>
      </Card>

      {semanticTask ? (
        <div className={`asset-semantic-task-panel is-${semanticTask.status}`} role="region" aria-label="AI 语义化任务状态">
          <div className="asset-semantic-task-heading">
            <div className="asset-semantic-task-title">
              <Text strong>当前执行任务</Text>
              <span className={`asset-semantic-task-badge is-${semanticTask.status}`}>
                {semanticTask.status === 'running' && <SyncOutlined spin />}
                {semanticTask.status === 'completed' && <CheckCircleOutlined />}
                {semanticTask.status === 'stopped' && <StopOutlined />}
                {semanticTask.status === 'paused' && <PauseOutlined />}
                <span>{semanticTaskStatusLabels[semanticTask.status]}</span>
              </span>
            </div>
            <Text type="secondary" className="asset-semantic-task-message" aria-live="polite">
              {semanticTaskDisplayMessageOf(semanticTask)}
            </Text>
          </div>
          <div className="asset-semantic-task-controls">
            <div className="asset-semantic-task-actions">
              <Button size="small" icon={<PauseOutlined />} disabled={!taskCanPause || semanticControlPending !== null} loading={semanticControlPending === 'pause'} onClick={() => void controlSemanticization('pause')}>暂停</Button>
              <Button size="small" icon={<PlayCircleOutlined />} disabled={!taskCanResume || semanticControlPending !== null} loading={semanticControlPending === 'resume'} onClick={() => void controlSemanticization('resume')}>恢复</Button>
              <Button danger size="small" icon={<StopOutlined />} disabled={!taskCanStop || semanticControlPending !== null} loading={semanticControlPending === 'stop'} onClick={confirmStopSemanticization}>停止</Button>
            </div>
          </div>
          <div className="asset-semantic-task-current">
            <div><span className="asset-semantic-task-label">当前记录</span><strong title={semanticTaskCurrentName(semanticTask)}>{semanticTaskCurrentName(semanticTask)}</strong><span className="asset-semantic-task-index">{semanticTaskCurrentIndexLabelOf(semanticTask)}</span></div>
            <div>
              <div className="asset-semantic-task-stage-copy">
                <span className="asset-semantic-task-label">当前阶段</span>
                <strong>{semanticTaskStageLabels[semanticTask.currentStage]} · {semanticTaskModeLabelOf(semanticTaskModeOf(semanticTask))}</strong>
              </div>
              <span className="asset-semantic-task-performance" aria-label={`吞吐 ${semanticTaskThroughputLabelOf(semanticTask.recordsPerMinute)}，预计剩余 ${semanticTaskEtaLabelOf(semanticTask.estimatedRemainingMs)}`}>
                吞吐 {semanticTaskThroughputLabelOf(semanticTask.recordsPerMinute)} · ETA {semanticTaskEtaLabelOf(semanticTask.estimatedRemainingMs)}
              </span>
            </div>
          </div>
          <Tooltip title={`已完成 ${semanticTask.completed} / ${semanticTask.total} 条`}>
            <Progress percent={taskPercent} showInfo={false} status={semanticTask.status === 'completed' ? semanticTask.failed > 0 ? 'exception' : 'success' : semanticTask.status === 'stopped' ? 'exception' : 'active'} aria-label={`任务进度 ${taskPercent}%`} />
          </Tooltip>
          <div className="asset-semantic-task-metrics" aria-label="语义化任务统计">
            <span><strong>{semanticTask.completed}</strong><small>已处理</small></span>
            <span className="is-success"><strong>{semanticTask.succeeded}</strong><small>成功</small></span>
            <span className="is-error"><strong>{semanticTask.failed}</strong><small>失败</small></span>
            <span><strong>{semanticTask.remaining}</strong><small>剩余</small></span>
            {semanticTaskConcurrencyLimitOf(semanticTask) !== undefined
              ? <span><strong>{semanticTaskConcurrencyLimitOf(semanticTask)}</strong><small>并行</small></span>
              : <span><strong>{semanticTask.available}</strong><small>可用</small></span>}
          </div>
          <div className="asset-semantic-task-recent">
            <div className="asset-semantic-task-recent-heading"><span>最近记录结果</span><Text type="secondary">按最新进度更新</Text></div>
            {semanticTask.recentItems.length ? <ul>{semanticTask.recentItems.map((item) => {
              const failed = item.status === 'failed'
              return <li key={item.uid}><span className={`asset-semantic-recent-status ${failed ? 'is-error' : 'is-success'}`}>{failed ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />}{failed ? '失败' : '成功'}</span><span className="asset-semantic-recent-name" title={item.name || item.itemId || item.uid}>{item.name || item.itemId || item.uid}</span>{typeof item.durationMs === 'number' && <span className="asset-semantic-recent-duration">{(item.durationMs / 1000).toFixed(1)} 秒</span>}{item.error && <span className="asset-semantic-recent-message" title={item.error}>{item.error}</span>}</li>
            })}</ul> : <span className="asset-semantic-task-empty">任务完成记录后，这里会显示结果和错误信息。</span>}
          </div>
          <SemanticAuditPanel task={semanticTask} records={records} history={semanticAuditHistory} />
        </div>
      ) : (
        <Card className="semanticization-empty-task-card"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`尚未启动语义化任务；${semanticTaskExecutionPolicyHint}。请从下方选择数据范围。`} /></Card>
      )}

      <Card className="data-workbench-card semanticization-records-card">
        <div className="semanticization-card-heading">
          <div><Text strong>语义化数据范围</Text><Text type="secondary">查看状态、选择记录并执行生成、重试或重新生成。</Text></div>
        </div>
        <div className="filter-bar">
          <Input.Search allowClear placeholder="搜索名称、编号和正文" prefix={<SearchOutlined />} onSearch={(value) => { setSearch(value); setPage(1) }} style={{ width: 360 }} />
          <Select allowClear placeholder="全部项目" value={projectId} onChange={(value) => { setProjectId(value); setPage(1) }} options={projects.map((project) => ({ label: project.name, value: project.uid }))} style={{ width: 220 }} />
          <Select allowClear placeholder="全部类型" value={nodeType} onChange={(value) => { setNodeType(value); setPage(1) }} options={nodeTypes.map((type) => ({ label: type, value: type }))} style={{ width: 160 }} />
          <Select<RequirementSemanticizationStatus | 'all'> value={statusFilter} onChange={(value) => { setStatusFilter(value); setPage(1) }} options={[{ label: '全部状态', value: 'all' }, { label: '待语义化', value: 'pending' }, { label: '处理中', value: 'processing' }, { label: '已完成', value: 'ready' }, { label: '失败', value: 'failed' }]} style={{ width: 140 }} />
        </div>
        <ResizableTable<RecordRow>
          tableKey="semanticization-records"
          rowKey="uid"
          rowSelection={{ selectedRowKeys, preserveSelectedRowKeys: true, onChange: (keys) => setSelectedRowKeys(keys.map(String)) }}
          loading={loading}
          dataSource={records}
          scroll={{ x: 1120, y: appTableScrollY }}
          pagination={{ current: page, pageSize, total, showSizeChanger: true, showTotal: (count) => `共 ${count} 条` }}
          onChange={(pagination: TablePaginationConfig) => { setPage(pagination.current ?? 1); setPageSize(pagination.pageSize ?? 20) }}
          onRow={(record) => ({ onDoubleClick: () => void window.visslm.getRecord(record.uid).then(setDetail) })}
          columns={[
            { title: '名称', dataIndex: 'name', width: 280, ellipsis: true, render: (name: string, record) => <Button type="link" className="table-link" title={name || '未命名记录'} onClick={() => void window.visslm.getRecord(record.uid).then(setDetail)}>{name}</Button> },
            { title: '类型', dataIndex: 'nodeType', width: 140, render: (value) => <Tag>{value || '—'}</Tag> },
            { title: '对象编号', dataIndex: 'itemId', width: 180, ellipsis: true },
            { title: 'AI 语义化状态', key: 'semanticStatus', width: 150, render: (_value, record) => renderSemanticStatus(record) },
            { title: '最后修改', dataIndex: 'lastModifyTime', width: 180, render: formatDate },
            { title: '操作', key: 'action', width: 150, render: (_value, record) => {
              const status = normalizeSemanticStatus(record.semanticStatus)
              const running = status === 'processing' || semanticTaskCurrentUid(semanticTask) === record.uid
              if (running) return <Button type="link" disabled icon={<SyncOutlined spin />}>处理中</Button>
              const label = status === 'ready' ? '重新生成' : status === 'failed' ? '重试' : '生成语义卡片'
              return <Button type="link" icon={status === 'failed' ? <ReloadOutlined /> : <BulbOutlined />} loading={semanticActionUids.includes(record.uid)} disabled={semanticTaskIsActive} onClick={() => void startSemanticization({ scope: 'selected', recordUids: [record.uid], force: status === 'ready' }, 'row')}>{label}</Button>
            }}
          ]}
        />
      </Card>
      <Drawer
        rootClassName="record-detail-drawer-shell"
        className="record-detail-drawer"
        title={detail ? <div className="drawer-context-title"><BulbOutlined /><span>AI 语义化记录</span><strong title={detail.name}>{detail.name}</strong></div> : 'AI 语义化记录'}
        size={960}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
      >
        {detail && <div className="detail-stack">
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="对象编号">{detail.itemId || '—'}</Descriptions.Item>
            <Descriptions.Item label="类型">{detail.nodeType || '—'}</Descriptions.Item>
            <Descriptions.Item label="语义化状态">{renderSemanticStatus(detail)}</Descriptions.Item>
            <Descriptions.Item label="最后更新">{formatDate(detail.semanticUpdatedAt || detail.lastModifyTime)}</Descriptions.Item>
          </Descriptions>
          <Divider titlePlacement="start">AI 分析审计轨迹</Divider>
          {detailAuditTask
            ? <SemanticAuditPanel task={detailAuditTask} records={detailAuditRecords} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前记录尚无语义化审计轨迹" />}
          <Divider titlePlacement="start">语义化原文</Divider>
          <RichDescription html={detail.description} images={[]} />
        </div>}
      </Drawer>
    </div>
  )
}

const knowledgeStatusMeta: Record<KnowledgeDocument['status'], { label: string; color: string }> = {
  queued: { label: '排队中', color: 'default' },
  processing: { label: '处理中', color: 'processing' },
  ready: { label: '已就绪', color: 'success' },
  failed: { label: '失败', color: 'error' }
}

const knowledgeFileIcon = (extension: string): React.JSX.Element => {
  if (extension === '.pdf') return <FilePdfOutlined />
  if (extension === '.docx') return <FileWordOutlined />
  if (extension === '.xlsx' || extension === '.xls') return <FileExcelOutlined />
  return <FileTextOutlined />
}

const genericKnowledgeChunkLocationPattern = /^(?:文档)?正文(?:内容)?$|^(?:分块|chunk)(?:\s*[#：:.-]?\s*\d+)?$/i

const knowledgeChunkLocationLabelOf = (chunk: KnowledgeChunk): string => {
  if (typeof chunk.pageNumber === 'number' && Number.isFinite(chunk.pageNumber) && chunk.pageNumber > 0) {
    return `第${chunk.pageNumber}页`
  }
  const sheetName = chunk.sheetName?.trim()
  if (sheetName) return `工作表「${sheetName}」`
  const location = chunk.location?.trim()
  if (location && !genericKnowledgeChunkLocationPattern.test(location)) return location
  return '正文位置'
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function KnowledgeBasePage({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<KnowledgeDocument['status']>()
  const [extension, setExtension] = useState<string>()
  const [tag, setTag] = useState('')
  const [progress, setProgress] = useState<KnowledgeIndexProgress | null>(null)
  const [detail, setDetail] = useState<KnowledgeDocumentDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailPreview, setDetailPreview] = useState<KnowledgeDocumentPreview | null>(null)
  const [detailPreviewError, setDetailPreviewError] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'preview' | 'index'>('preview')
  const [chunkSearch, setChunkSearch] = useState('')
  const [chunkPage, setChunkPage] = useState(1)
  const [tagDraft, setTagDraft] = useState('')
  const detailRequestRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [pageResult, statsResult] = await Promise.all([
        window.visslm.listKnowledgeDocuments({ page, pageSize, search, status, extension, tag }),
        window.visslm.getKnowledgeStats()
      ])
      setDocuments(pageResult.rows)
      setTotal(pageResult.total)
      setStats(statsResult)
    } finally {
      setLoading(false)
    }
  }, [extension, page, pageSize, search, status, tag])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => window.visslm.onKnowledgeProgress((next) => {
    setProgress(next)
    if (next.phase === 'done' || next.phase === 'error') void load()
  }), [load])

  const upload = async (): Promise<void> => {
    setUploading(true)
    try {
      const result = await window.visslm.uploadKnowledgeDocuments()
      if (result.canceled) return
      result.ok ? message.success(result.message) : message.warning(result.message)
      if (result.skipped.length) {
        modal.warning({
          title: '部分文件未加入知识库',
          content: <pre className="knowledge-error-list">{result.skipped.map((item) => `${item.fileName}: ${item.reason}`).join('\n')}</pre>
        })
      }
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  const openDetail = async (id: string): Promise<void> => {
    const requestId = detailRequestRef.current + 1
    detailRequestRef.current = requestId
    setDetailOpen(true)
    setDetailLoading(true)
    setDetail(null)
    setDetailPreview(null)
    setDetailPreviewError(null)
    setDetailTab('preview')
    setChunkSearch('')
    setChunkPage(1)
    setTagDraft('')
    try {
      const [detailResult, previewResult] = await Promise.allSettled([
        window.visslm.getKnowledgeDocument(id),
        window.visslm.getKnowledgeDocumentPreview(id)
      ])
      if (requestId !== detailRequestRef.current) return
      const preview = previewResult.status === 'fulfilled' ? previewResult.value : null
      const result = preview?.document ?? (detailResult.status === 'fulfilled' ? detailResult.value : null)
      setDetail(result)
      setDetailPreview(preview)
      setTagDraft(result?.tags.join(', ') ?? '')
      if (preview?.errorMessage) {
        setDetailPreviewError(preview.errorMessage)
      } else if (!preview) {
        const previewFailure = previewResult.status === 'rejected'
          ? previewResult.reason instanceof Error ? previewResult.reason.message : String(previewResult.reason)
          : '原始文档预览内容不可用'
        setDetailPreviewError(result
          ? `在线预览暂不可用，已显示索引正文（${previewFailure}）`
          : `知识库文档加载失败：${previewFailure}`)
      }
      if (!result) message.warning('知识库文档不存在或已被删除')
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false)
    }
  }

  const closeDetail = (): void => {
    detailRequestRef.current += 1
    setDetailOpen(false)
    setDetailLoading(false)
    setDetail(null)
    setDetailPreview(null)
    setDetailPreviewError(null)
    setDetailTab('preview')
    setChunkSearch('')
    setChunkPage(1)
    setTagDraft('')
  }

  const retry = async (id: string): Promise<void> => {
    try {
      const result = await window.visslm.retryKnowledgeDocument(id)
      result ? message.success(`已重新处理 ${result.fileName}`) : message.error('文档不存在')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const remove = (document: KnowledgeDocument): void => {
    modal.confirm({
      title: `确认从知识库删除“${document.fileName}”？`,
      content: '只会移除知识库索引和元数据，不会删除电脑上的原始文件。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        const result = await window.visslm.deleteKnowledgeDocument(document.id)
        result.ok ? message.success(result.message) : message.error(result.message)
        if (detail?.id === document.id) closeDetail()
        await load()
      }
    })
  }

  const rebuild = async (): Promise<void> => {
    setRebuilding(true)
    try {
      const result = await window.visslm.rebuildKnowledgeIndex()
      message.success(result.message)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRebuilding(false)
    }
  }

  const cancelKnowledgeTask = async (): Promise<void> => {
    const taskId = progress?.taskId?.trim()
    if (!taskId || progress?.status !== 'running') return
    const cancelled = await window.visslm.cancelKnowledgeTask(taskId)
    if (cancelled) message.info('已请求停止知识库后台任务')
  }

  const saveTags = async (): Promise<void> => {
    if (!detail) return
    const result = await window.visslm.updateKnowledgeDocumentTags(
      detail.id,
      tagDraft.split(/[,，]/g)
    )
    if (result) {
      setDetail({ ...detail, tags: result.tags, updatedAt: result.updatedAt })
      setDetailPreview((current) => current && current.document.id === detail.id
        ? { ...current, document: { ...current.document, tags: result.tags, updatedAt: result.updatedAt } }
        : current)
      message.success('标签已保存')
      await load()
    }
  }

  const filteredDetailChunks = useMemo(() => {
    const chunks = detail?.chunks ?? []
    const keyword = chunkSearch.trim().toLocaleLowerCase()
    if (!keyword) return chunks
    return chunks.filter((chunk) => [
      chunk.content,
      chunk.location,
      chunk.sheetName,
      typeof chunk.pageNumber === 'number' ? `第${chunk.pageNumber}页` : ''
    ].some((value) => value?.toLocaleLowerCase().includes(keyword)))
  }, [chunkSearch, detail])
  const chunkPageSize = 20
  const pagedDetailChunks = useMemo(() => {
    const start = (chunkPage - 1) * chunkPageSize
    return filteredDetailChunks.slice(start, start + chunkPageSize)
  }, [chunkPage, filteredDetailChunks])

  return (
    <div className="knowledge-page page-stack">
      <div className="knowledge-toolbar page-toolbar">
        <Space wrap>
          <Button type="primary" icon={<CloudUploadOutlined />} loading={uploading} onClick={() => void upload()}>
            上传文档
          </Button>
          <Button icon={<ReloadOutlined />} loading={rebuilding} onClick={() => void rebuild()}>
            重建向量索引
          </Button>
          <Button
            danger
            icon={<StopOutlined />}
            disabled={!progress || progress.status !== 'running'}
            onClick={() => void cancelKnowledgeTask()}
          >
            停止后台任务
          </Button>
        </Space>
        <Text type="secondary">支持 DOCX、PDF、XLSX/XLS、TXT，单文件不超过 100 MB</Text>
      </div>
      <div className="knowledge-metric-grid">
        <Card size="small"><Statistic title="文档" value={stats?.documentCount ?? 0} /></Card>
        <Card size="small" className="knowledge-metric-card knowledge-metric-card-success"><Statistic title="已就绪" value={stats?.readyCount ?? 0} /></Card>
        <Card size="small"><Statistic title="索引分块" value={stats?.indexedChunkCount ?? 0} /></Card>
        <Card size="small"><Statistic title="采集记录" value={stats?.recordCount ?? 0} /></Card>
      </div>
      {(progress?.status === 'running' || progress?.phase === 'error') && (
        <div className={`knowledge-progress ${progress.phase === 'error' ? 'has-error' : ''}`}>
          <div className="knowledge-progress-heading">
            <Text strong>{progress.message}</Text>
            {progress.total > 0 && <Text type="secondary">{progress.current}/{progress.total}</Text>}
            {typeof progress.elapsedMs === 'number' && progress.elapsedMs >= 1000 && (
              <Text type="secondary">
                {(progress.elapsedMs / 1000).toFixed(1)} 秒
                {typeof progress.throughputPerSecond === 'number' && progress.throughputPerSecond > 0
                  ? ` · ${progress.throughputPerSecond.toFixed(1)}/秒`
                  : ''}
              </Text>
            )}
          </div>
          <Progress
            percent={progress.total ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : undefined}
            status={progress.status === 'failed' ? 'exception' : 'active'}
            showInfo={false}
          />
        </div>
      )}
      <Card className="knowledge-list-card">
        <div className="knowledge-filter-bar">
          <Input.Search
            allowClear
            placeholder="搜索文件名或失败原因"
            prefix={<SearchOutlined />}
            onSearch={(value) => { setSearch(value); setPage(1) }}
            style={{ width: 300 }}
          />
          <Select
            allowClear
            placeholder="全部状态"
            value={status}
            onChange={(value) => { setStatus(value); setPage(1) }}
            options={Object.entries(knowledgeStatusMeta).map(([value, item]) => ({ value, label: item.label }))}
            style={{ width: 140 }}
          />
          <Select
            allowClear
            placeholder="全部类型"
            value={extension}
            onChange={(value) => { setExtension(value); setPage(1) }}
            options={['.docx', '.pdf', '.xlsx', '.xls', '.txt'].map((value) => ({ value, label: value.toUpperCase() }))}
            style={{ width: 130 }}
          />
          <Input
            allowClear
            placeholder="标签"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            onPressEnter={() => setPage(1)}
            style={{ width: 160 }}
          />
        </div>
        <ResizableTable<KnowledgeDocument>
          tableKey="knowledge-documents"
          rowKey="id"
          loading={loading}
          dataSource={documents}
          scroll={{ x: 980, y: appTableScrollY }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 个文档`
          }}
          onChange={(pagination: TablePaginationConfig) => {
            setPage(pagination.current ?? 1)
            setPageSize(pagination.pageSize ?? 20)
          }}
          columns={[
            {
              title: '文档',
              key: 'fileName',
              width: 330,
              render: (_value, document) => (
                <Button type="link" className="knowledge-name-button" onClick={() => void openDetail(document.id)}>
                  <span className="knowledge-file-icon">{knowledgeFileIcon(document.extension)}</span>
                  <span>{document.fileName}</span>
                </Button>
              )
            },
            { title: '状态', dataIndex: 'status', width: 110, render: (value: KnowledgeDocument['status']) => <Tag color={knowledgeStatusMeta[value].color}>{knowledgeStatusMeta[value].label}</Tag> },
            { title: '分块', dataIndex: 'chunkCount', width: 80 },
            { title: '标签', dataIndex: 'tags', width: 200, render: (tags: string[]) => tags.length ? tags.map((item) => <Tag key={item}>{item}</Tag>) : <Text type="secondary">未设置</Text> },
            { title: '大小', dataIndex: 'byteSize', width: 100, render: formatBytes },
            { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: formatDate },
            {
              title: '操作',
              key: 'actions',
              fixed: 'right',
              width: 150,
              render: (_value, document) => (
                <Space size={4}>
                  {(document.status === 'failed' || document.status === 'ready') && (
                    <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void retry(document.id)}>
                      {document.status === 'failed' ? '重试' : '重新解析'}
                    </Button>
                  )}
                  <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => remove(document)}>删除</Button>
                </Space>
              )
            }
          ]}
        />
      </Card>
      <Drawer
        className="knowledge-detail-drawer"
        rootClassName="knowledge-detail-preview-drawer"
        title={detail ? (
          <div className="drawer-context-title">
            <BulbOutlined />
            <span>知识库文档</span>
            <strong title={detail.fileName}>{detail.fileName}</strong>
          </div>
        ) : '知识库文档'}
        size={960}
        open={detailOpen}
        onClose={closeDetail}
        destroyOnHidden
      >
        {detailLoading && !detail && (
          <div className="knowledge-document-preview__loading" role="status" aria-live="polite">
            <Spin size="small" />
            <Text type="secondary">正在读取知识库文档…</Text>
          </div>
        )}
        {!detailLoading && !detail && detailPreviewError && (
          <Alert type="error" showIcon title="知识库文档加载失败" description={detailPreviewError} />
        )}
        {detail && (
          <div className="knowledge-detail-stack">
            <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
              <Descriptions.Item label="格式">{detail.extension.toUpperCase()}</Descriptions.Item>
              <Descriptions.Item label="大小">{formatBytes(detail.byteSize)}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={knowledgeStatusMeta[detail.status].color}>{knowledgeStatusMeta[detail.status].label}</Tag></Descriptions.Item>
              <Descriptions.Item label="页数/工作表">{detail.pageCount || '-'}</Descriptions.Item>
              <Descriptions.Item label="SHA-256" span={2}><Text copyable ellipsis>{detail.sha256}</Text></Descriptions.Item>
            </Descriptions>
            {detail.errorMessage && <Alert type="error" showIcon title={detail.errorMessage} />}
            <div className="knowledge-tag-editor">
              <Text strong>标签</Text>
              <Input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="用逗号分隔多个标签" />
              <Button onClick={() => void saveTags()}>保存标签</Button>
            </div>
            <Tabs
              className="knowledge-detail-tabs"
              animated={false}
              activeKey={detailTab}
              onChange={(key) => setDetailTab(key === 'index' ? 'index' : 'preview')}
              items={[
                {
                  key: 'preview',
                  label: '在线预览',
                  children: (
                    <div className="knowledge-detail-preview-surface">
                      <Suspense
                        fallback={(
                          <div className="knowledge-document-preview__loading" role="status" aria-live="polite">
                            <Spin size="small" />
                            <Text type="secondary">正在加载预览模块…</Text>
                          </div>
                        )}
                      >
                        <KnowledgeDocumentPreviewer
                          preview={detailPreview}
                          fallbackDocument={detail}
                          loading={detailLoading}
                          error={detailPreviewError}
                          showHeader={false}
                        />
                      </Suspense>
                    </div>
                  )
                },
                {
                  key: 'index',
                  label: `解析与索引（${detail.chunks.length}）`,
                  children: (
                    <section className="knowledge-detail-index-panel" aria-label="文档解析与索引信息">
                      <Descriptions className="knowledge-index-summary" bordered size="small" column={{ xs: 1, sm: 2 }}>
                        <Descriptions.Item label="解析状态">
                          <Tag color={knowledgeStatusMeta[detail.status].color}>{knowledgeStatusMeta[detail.status].label}</Tag>
                        </Descriptions.Item>
                        <Descriptions.Item label="索引分块">{detail.chunkCount} 个</Descriptions.Item>
                        <Descriptions.Item label="页数/工作表">{detail.pageCount || '-'}</Descriptions.Item>
                        <Descriptions.Item label="向量模型"><Text ellipsis title={detail.modelVersion}>{detail.modelVersion || '-'}</Text></Descriptions.Item>
                        <Descriptions.Item label="处理完成">{detail.processedAt ? formatDate(detail.processedAt) : '-'}</Descriptions.Item>
                        <Descriptions.Item label="最后更新">{formatDate(detail.updatedAt)}</Descriptions.Item>
                      </Descriptions>
                      <div className="knowledge-index-toolbar">
                        <Input.Search
                          allowClear
                          value={chunkSearch}
                          prefix={<SearchOutlined />}
                          placeholder="搜索页码、工作表、位置或正文"
                          onChange={(event) => { setChunkSearch(event.target.value); setChunkPage(1) }}
                          style={{ width: 360 }}
                        />
                        <Text type="secondary">找到 {filteredDetailChunks.length} 个分块</Text>
                      </div>
                      {pagedDetailChunks.length ? (
                        <div className="knowledge-index-chunk-list">
                          {pagedDetailChunks.map((chunk) => (
                            <article className="knowledge-index-chunk-card" key={chunk.id}>
                              <div className="knowledge-index-chunk-heading">
                                <Space size={8} wrap>
                                  <Tag color="purple">{knowledgeChunkLocationLabelOf(chunk)}</Tag>
                                  <Text strong>索引分块 {chunk.chunkIndex + 1}</Text>
                                </Space>
                                <Text type="secondary">字符 {chunk.charStart}–{chunk.charEnd}</Text>
                              </div>
                              <Paragraph className="knowledge-index-chunk-content" ellipsis={{ rows: 6, expandable: true }}>
                                {chunk.content || '当前分块没有文本内容'}
                              </Paragraph>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的索引分块" />
                      )}
                      {filteredDetailChunks.length > chunkPageSize && (
                        <Pagination
                          className="knowledge-index-pagination"
                          current={chunkPage}
                          pageSize={chunkPageSize}
                          total={filteredDetailChunks.length}
                          showSizeChanger={false}
                          showTotal={(count) => `共 ${count} 个分块`}
                          onChange={setChunkPage}
                        />
                      )}
                    </section>
                  )
                }
              ]}
            />
          </div>
        )}
      </Drawer>
    </div>
  )
}

function ChatPage({
  messages,
  setMessages,
  question,
  setQuestion,
  loading,
  setLoading,
  onOpenDashboard,
  onDashboardUpdate,
  activeArtifact,
  activeArtifactVersion,
  dataScope,
  dataScopeSummary,
  onClearDataScope,
  onRestoreDataScope,
  conversationId,
  onConversationIdChange,
  modelOnline,
  onOpenSettings,
  onOpenAssetCenter,
  refreshKey
}: {
  messages: ChatMessage[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  question: string
  setQuestion: React.Dispatch<React.SetStateAction<string>>
  loading: boolean
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
  onOpenDashboard: (dashboard: DashboardSpec, version?: number) => void
  onDashboardUpdate: (dashboard: DashboardSpec, version?: number) => void
  activeArtifact: DashboardSpec | null
  activeArtifactVersion?: number
  dataScope: DataScope | null
  dataScopeSummary: string
  onClearDataScope: () => void
  onRestoreDataScope: (scope: DataScope, summary: string) => void
  conversationId: string
  onConversationIdChange: (id: string) => void
  modelOnline: boolean | null
  onOpenSettings: () => void
  onOpenAssetCenter: (tab: 'data' | 'knowledge') => void
  refreshKey: number
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const messageListRef = useRef<HTMLDivElement>(null)
  const [activeDataView, setActiveDataView] = useState<ChatDataView | null>(null)
  const [activeDataGroup, setActiveDataGroup] = useState('')
  const [dataViewPage, setDataViewPage] = useState(1)
  const [dataViewPageSize, setDataViewPageSize] = useState(20)
  const [dataViewPageLoading, setDataViewPageLoading] = useState(false)
  const dataViewPageRequestRef = useRef(0)
  const [activeRecordDetail, setActiveRecordDetail] = useState<RecordDetail | null>(null)
  const [recordDetailModalOpen, setRecordDetailModalOpen] = useState(false)
  const [activeKnowledgeDetail, setActiveKnowledgeDetail] = useState<KnowledgeDocumentDetail | null>(null)
  const [activeKnowledgePreview, setActiveKnowledgePreview] = useState<KnowledgeDocumentPreview | null>(null)
  const [activeKnowledgeChunkId, setActiveKnowledgeChunkId] = useState<string | null>(null)
  const [knowledgePreviewOpen, setKnowledgePreviewOpen] = useState(false)
  const [knowledgePreviewLoading, setKnowledgePreviewLoading] = useState(false)
  const [knowledgePreviewError, setKnowledgePreviewError] = useState<string | null>(null)
  const knowledgePreviewRequestRef = useRef(0)
  const [recordDetailLoading, setRecordDetailLoading] = useState(false)
  const [recordImagePage, setRecordImagePage] = useState<RecordImagePage | null>(null)
  const [recordImagesLoading, setRecordImagesLoading] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [agentProgress, setAgentProgress] = useState<Array<Extract<AgentEvent, { type: 'status' }>>>([])
  const [agentRunMetadata, setAgentRunMetadata] = useState<AgentRunMetadata>({})
  const [agentRunStatus, setAgentRunStatus] = useState<AgentRunStatus>('idle')
  const [agentDetailsOpen, setAgentDetailsOpen] = useState(false)
  const [agentTaskTrace, setAgentTaskTrace] = useState<AssistantTaskView | null>(null)
  const [activeExecutionSummary, setActiveExecutionSummary] = useState<AssistantExecutionSummary | null>(null)
  const executionSummaryRef = useRef<AssistantExecutionSummary | null>(null)
  const [planAwaitingConfirmation, setPlanAwaitingConfirmation] = useState(false)
  const [planConfirming, setPlanConfirming] = useState(false)
  const [planExpired, setPlanExpired] = useState(false)
  const [planValidationErrors, setPlanValidationErrors] = useState<AssistantPlanValidationIssue[]>([])
  const [planWarnings, setPlanWarnings] = useState<AssistantPlanValidationIssue[]>([])
  const [planProjects, setPlanProjects] = useState<ProjectRow[]>([])
  const [planNodeTypes, setPlanNodeTypes] = useState<string[]>([])
  const [planMetadataLoading, setPlanMetadataLoading] = useState(false)
  const [planMetadataError, setPlanMetadataError] = useState<string>()
  const planMetadataRequestRef = useRef(0)
  const [messageRunMetadata, setMessageRunMetadata] = useState<Record<string, AgentRunMetadata>>({})
  const [clarificationByMessageId, setClarificationByMessageId] = useState<Record<string, string>>({})
  const activeRunRef = useRef<ActiveChatRun | null>(null)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const answerStreamRef = useRef<AnswerStreamBuffer | null>(null)
  const answerStreamFlushFrameRef = useRef<number | null>(null)
  const [streamingAnswer, setStreamingAnswer] = useState<StreamingAnswerView | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [cancelPendingRunId, setCancelPendingRunId] = useState<string | null>(null)
  const [artifactAttached, setArtifactAttached] = useState(Boolean(activeArtifact))
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [historySessions, setHistorySessions] = useState<ChatSessionSummary[]>([])
  const [historyRefreshing, setHistoryRefreshing] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyCollapsed, setHistoryCollapsed] = useState(false)
  const [historyMobileOpen, setHistoryMobileOpen] = useState(false)
  const [showScrollLatest, setShowScrollLatest] = useState(false)
  const [userNearBottom, setUserNearBottom] = useState(true)
  const userNearBottomRef = useRef(true)
  const [workspaceStats, setWorkspaceStats] = useState<KnowledgeStats | null>(null)
  const [workspaceDataStats, setWorkspaceDataStats] = useState<DashboardStats | null>(null)
  const [workspaceProgress, setWorkspaceProgress] = useState<KnowledgeIndexProgress | null>(null)
  const [workspaceStatusLoading, setWorkspaceStatusLoading] = useState(true)
  const [workspaceStatusFailed, setWorkspaceStatusFailed] = useState(false)
  const [workspaceIndexRebuilding, setWorkspaceIndexRebuilding] = useState(false)
  const [artifactPreview, setArtifactPreview] = useState<AssistantArtifactPreview | null>(null)
  const [artifactSaving, setArtifactSaving] = useState(false)
  const [artifactExportFormat, setArtifactExportFormat] = useState<ArtifactExportFormat>('docx')
  const [artifactGenerationStatus, setArtifactGenerationStatus] = useState<ArtifactExportGenerationStatus>('idle')
  const [artifactGenerationMessage, setArtifactGenerationMessage] = useState('')
  const [artifactHistoryOpen, setArtifactHistoryOpen] = useState(false)
  const [assistantArtifacts, setAssistantArtifacts] = useState<AssistantArtifact[]>([])
  const [artifactHistoryLoading, setArtifactHistoryLoading] = useState(false)
  const [artifactExporting, setArtifactExporting] = useState<string | null>(null)
  const [runHistoryOpen, setRunHistoryOpen] = useState(false)
  const [runHistoryLoading, setRunHistoryLoading] = useState(false)
  const [assistantRunHistory, setAssistantRunHistory] = useState<AssistantRunHistory[]>([])
  const [assistantRunStats, setAssistantRunStats] = useState<AssistantRunHistoryStats | null>(null)
  const workspaceStatusRequestRef = useRef(0)
  const selectedDataGroup = activeDataView?.groups.find(
    (group) => group.name === activeDataGroup
  ) ?? activeDataView?.groups[0]
  const selectedDataGroupRecordUids = activeDataView && selectedDataGroup
    ? chatDataViewRecordUidsForGroup(activeDataView, selectedDataGroup.name)
    : undefined
  const selectedDataGroupPageable = Boolean(selectedDataGroupRecordUids?.length)

  const filteredHistorySessions = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase()
    if (!query) return historySessions
    return historySessions.filter((session) => (
      `${session.title ?? ''} ${session.preview ?? ''}`.toLocaleLowerCase().includes(query)
    ))
  }, [historyQuery, historySessions])

  const updateMessageScrollState = useCallback((): void => {
    const container = messageListRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const nearBottom = distanceFromBottom <= 64
    userNearBottomRef.current = nearBottom
    setUserNearBottom(nearBottom)
    setShowScrollLatest(!nearBottom && container.scrollHeight > container.clientHeight + 8)
  }, [])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth'): void => {
    const container = messageListRef.current
    if (!container) return
    userNearBottomRef.current = true
    setUserNearBottom(true)
    setShowScrollLatest(false)
    container.scrollTo({ top: container.scrollHeight, behavior })
  }, [])

  const handleMessageScroll = useCallback((): void => {
    updateMessageScrollState()
  }, [updateMessageScrollState])

  useEffect(() => {
    if (!historyMobileOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setHistoryMobileOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [historyMobileOpen])

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistoryRefreshing(true)
    try {
      setHistorySessions(await window.visslm.listChatSessions(50))
    } catch (error) {
      message.warning(`历史会话加载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setHistoryRefreshing(false)
    }
  }, [message])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  const refreshWorkspaceStatus = useCallback(async (): Promise<void> => {
    const requestId = ++workspaceStatusRequestRef.current
    setWorkspaceStatusLoading(true)
    const [knowledgeResult, dataResult] = await Promise.allSettled([
      window.visslm.getKnowledgeStats(),
      window.visslm.getStats()
    ])
    if (requestId !== workspaceStatusRequestRef.current) return
    setWorkspaceStats(knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : null)
    setWorkspaceDataStats(dataResult.status === 'fulfilled' ? dataResult.value : null)
    setWorkspaceStatusFailed(knowledgeResult.status === 'rejected' || dataResult.status === 'rejected')
    setWorkspaceStatusLoading(false)
  }, [])

  useEffect(() => {
    void refreshWorkspaceStatus()
  }, [refreshKey, refreshWorkspaceStatus])

  useEffect(() => window.visslm.onKnowledgeProgress((next) => {
    setWorkspaceProgress(next)
    if (next.status !== 'running') void refreshWorkspaceStatus()
  }), [refreshWorkspaceStatus])

  useEffect(() => {
    setArtifactAttached(Boolean(activeArtifact))
  }, [activeArtifact])

  // Project and node-type choices are metadata only.  Load them when a plan
  // arrives so range edits cannot invent IDs through a free-text control.
  useEffect(() => {
    const summary = activeExecutionSummary
    if (!summary || !planAwaitingConfirmation || (summary.sourceMode !== 'records' && summary.sourceMode !== 'mixed')) {
      return
    }
    const requestId = ++planMetadataRequestRef.current
    setPlanMetadataLoading(true)
    setPlanMetadataError(undefined)
    void Promise.all([window.visslm.listProjects(), window.visslm.listNodeTypes()])
      .then(([projects, nodeTypes]) => {
        if (requestId !== planMetadataRequestRef.current) return
        setPlanProjects(projects)
        setPlanNodeTypes(nodeTypes)
      })
      .catch((error) => {
        if (requestId !== planMetadataRequestRef.current) return
        setPlanMetadataError(`范围目录加载失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (requestId === planMetadataRequestRef.current) setPlanMetadataLoading(false)
      })
    return () => {
      if (requestId === planMetadataRequestRef.current) planMetadataRequestRef.current += 1
    }
  }, [activeExecutionSummary, planAwaitingConfirmation, refreshKey])

  const openDataView = (view: ChatDataView): void => {
    dataViewPageRequestRef.current += 1
    setDataViewPageLoading(false)
    setActiveDataView(view)
    const firstGroup = view.groups[0]
    const firstGroupName = firstGroup?.name ?? ''
    setActiveDataGroup(firstGroupName)
    setDataViewPage(1)
    setDataViewPageSize(20)
    setActiveRecordDetail(null)
    setRecordImagePage(null)
    setRecordDetailModalOpen(false)
    if (firstGroup && chatDataViewRecordUidsForGroup(view, firstGroupName)?.length) {
      void loadDataViewPage(view, firstGroupName, 1, 20)
    }
  }

  const changeActiveDataGroup = (groupName: string): void => {
    dataViewPageRequestRef.current += 1
    setDataViewPageLoading(false)
    setActiveDataGroup(groupName)
    setDataViewPage(1)
    setDataViewPageSize(20)
    if (activeDataView && chatDataViewRecordUidsForGroup(activeDataView, groupName)?.length) {
      void loadDataViewPage(activeDataView, groupName, 1, 20)
    }
  }

  const loadDataViewPage = async (
    view: ChatDataView,
    groupName: string,
    page: number,
    pageSize: number
  ): Promise<void> => {
    const pageScope = chatDataViewPageScopeForGroup(view, groupName)
    const recordUids = pageScope?.recordUids
    if (!recordUids?.length) return
    const requestId = ++dataViewPageRequestRef.current
    setDataViewPageLoading(true)
    try {
      const result: ChatDataViewPage = await window.visslm.getChatDataViewPage(
        { ...pageScope, fields: view.fields },
        page,
        pageSize
      )
      if (requestId !== dataViewPageRequestRef.current) return
      setDataViewPage(result.page)
      setDataViewPageSize(result.pageSize)
      setActiveDataView((current) => {
        if (!current || current.id !== view.id) return current
        const targetGroupIndex = current.groups.findIndex((group) => group.name === groupName)
        if (targetGroupIndex === -1) return current
        const groupedRecordUids = current.groups.some(
          (group) => chatDataGroupRecordUidsOf(group) !== undefined
        )
        const nextGroups = [...current.groups]
        const targetGroup = nextGroups[targetGroupIndex]
        if (!targetGroup) return current
        nextGroups[targetGroupIndex] = {
          ...targetGroup,
          count: result.total,
          rows: result.rows
        }
        return {
          ...current,
          // Keep the view-level preview metadata for legacy flat views only;
          // grouped views have independent row/count snapshots per group.
          ...(groupedRecordUids
            ? {}
            : {
                loadedRows: result.rows.length,
                isPreview: result.rows.length < result.total
              }),
          groups: nextGroups
        }
      })
    } catch (error) {
      if (requestId !== dataViewPageRequestRef.current) return
      message.warning(`查询数据分页加载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (requestId === dataViewPageRequestRef.current) setDataViewPageLoading(false)
    }
  }

  const closeKnowledgePreview = (): void => {
    knowledgePreviewRequestRef.current += 1
    setKnowledgePreviewOpen(false)
    setKnowledgePreviewLoading(false)
    setKnowledgePreviewError(null)
    setActiveKnowledgePreview(null)
    setActiveKnowledgeDetail(null)
    setActiveKnowledgeChunkId(null)
  }

  const closeDataView = (): void => {
    dataViewPageRequestRef.current += 1
    setDataViewPageLoading(false)
    setActiveDataView(null)
    setActiveDataGroup('')
    setDataViewPage(1)
    setDataViewPageSize(20)
    setActiveRecordDetail(null)
    setRecordDetailModalOpen(false)
    closeKnowledgePreview()
    setRecordDetailLoading(false)
    setRecordImagePage(null)
    setRecordImagesLoading(false)
  }

  const persistSession = useCallback((sessionId: string, sessionMessages: ChatMessage[]): Promise<void> => {
    if (!sessionMessages.length) return Promise.resolve()
    const firstUserMessage = sessionMessages.find((item) => item.role === 'user')
    const save = async (): Promise<void> => {
      try {
        await window.visslm.saveChatSession({
          id: sessionId,
          title: firstUserMessage?.content,
          messages: sessionMessages
        })
        await refreshHistory()
      } catch (error) {
        message.warning(`历史会话保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    persistQueueRef.current = persistQueueRef.current.then(save, save)
    return persistQueueRef.current
  }, [message, refreshHistory])

  const isCurrentRun = (runId: string): boolean => {
    const activeRun = activeRunRef.current
    return activeRun?.runId === runId && activeRun.sessionId === conversationIdRef.current
  }

  const clearAnswerStream = useCallback((runId?: string): void => {
    const current = answerStreamRef.current
    if (runId && current?.runId !== runId) {
      // A stale continuation may only clear its own snapshot.  This keeps a
      // newer run's visible buffer isolated even if an old promise settles
      // after the user has started another request.
      setStreamingAnswer((snapshot) => snapshot?.runId === runId ? null : snapshot)
      return
    }
    if (answerStreamFlushFrameRef.current !== null) {
      cancelAnimationFrame(answerStreamFlushFrameRef.current)
      answerStreamFlushFrameRef.current = null
    }
    answerStreamRef.current = null
    setStreamingAnswer((snapshot) => {
      if (!runId || snapshot?.runId === runId) return null
      return snapshot
    })
  }, [])

  const scheduleAnswerStreamFlush = useCallback((): void => {
    if (answerStreamFlushFrameRef.current !== null) return
    answerStreamFlushFrameRef.current = requestAnimationFrame(() => {
      answerStreamFlushFrameRef.current = null
      const current = answerStreamRef.current
      const activeRun = activeRunRef.current
      if (!current || !activeRun || current.runId !== activeRun.runId ||
        current.sessionId !== conversationIdRef.current) {
        setStreamingAnswer((snapshot) => (
          snapshot && (!current || snapshot.runId === current.runId) ? null : snapshot
        ))
        return
      }
      setStreamingAnswer({
        runId: current.runId,
        sessionId: current.sessionId,
        content: current.content
      })
    })
  }, [])

  const beginAnswerStream = useCallback((run: Pick<ActiveChatRun, 'runId' | 'sessionId'>): void => {
    clearAnswerStream()
    answerStreamRef.current = {
      runId: run.runId,
      sessionId: run.sessionId,
      content: '',
      lastSequence: null,
      done: false
    }
  }, [clearAnswerStream])

  const acceptAnswerTextEvent = useCallback((
    run: Pick<ActiveChatRun, 'runId' | 'sessionId'>,
    event: Extract<AgentEvent, { type: 'text' }>
  ): void => {
    const current = answerStreamRef.current
    if (!current || current.runId !== run.runId || current.sessionId !== run.sessionId ||
      current.sessionId !== conversationIdRef.current || current.done) return

    const sequence = event.sequence
    if (sequence !== undefined) {
      // Modern producers are strictly monotonic.  The first numbered event
      // establishes the stream's baseline; all following events must be the
      // immediate successor so duplicates and gaps cannot reorder the answer.
      if (!Number.isSafeInteger(sequence) || sequence < 0) return
      if (current.lastSequence !== null && sequence !== current.lastSequence + 1) return
      current.lastSequence = sequence
    } else if (current.lastSequence !== null) {
      // Legacy unsequenced events are accepted only before a numbered event;
      // once sequencing starts, an unnumbered event is unsafe to merge.
      return
    }

    if (event.replace || event.reset) {
      current.content = event.content
    } else if (event.content) {
      current.content += event.content
    }
    if (event.done) current.done = true
    if (current.content || event.done || event.replace || event.reset) {
      scheduleAnswerStreamFlush()
    }
  }, [scheduleAnswerStreamFlush])

  const clearActiveRun = (runId: string): boolean => {
    if (!isCurrentRun(runId)) return false
    activeRunRef.current = null
    setActiveRunId(null)
    setCancelPendingRunId(null)
    setPlanAwaitingConfirmation(false)
    setPlanConfirming(false)
    setPlanExpired(false)
    setPlanValidationErrors([])
    setPlanWarnings([])
    return true
  }

  const finalizeCancelledRun = (run: ActiveChatRun, responseTaskTrace?: AssistantTaskTrace): void => {
    if (!isCurrentRun(run.runId)) return
    clearAnswerStream(run.runId)
    executionSummaryRef.current = null
    setActiveExecutionSummary(null)
    const completedAt = new Date().toISOString()
    const cancellationMetadata = mergeAgentRunMetadata(run.initialMetadata, agentRunMetadata)
    const metadataTaskTrace = assistantTaskTraceViewFromObject({
      runId: run.runId,
      status: 'cancelled',
      ...(canonicalAssistantExecutionAgentOf(cancellationMetadata.skill)
        ? { primaryAgent: canonicalAssistantExecutionAgentOf(cancellationMetadata.skill) }
        : {}),
      ...(cancellationMetadata.taskType ? { taskType: cancellationMetadata.taskType } : {}),
      ...(cancellationMetadata.sourceMode ? { sourceMode: cancellationMetadata.sourceMode } : {}),
      ...(cancellationMetadata.resultMode ? { resultMode: cancellationMetadata.resultMode } : {})
    }, 'cancelled')
    const explicitExpertTaskTrace = cancellationMetadata.skill
      ? assistantExpertTaskTraceViewOf({ expertId: cancellationMetadata.skill }, 'cancelled')
      : undefined
    const responseTask = responseTaskTrace
      ? assistantTaskTraceViewOf({ taskTrace: responseTaskTrace }, 'cancelled')
      : undefined
    const fallbackTaskTrace: AssistantTaskView = {
      runId: run.runId,
      status: 'cancelled',
      primaryAgent: 'conversation',
      invokedAgents: [],
      taskType: 'conversation',
      sourceMode: 'conversation',
      resultMode: 'answer',
      startedAt: run.startedAt,
      completedAt
    }
    const mergedTaskTrace = mergeAssistantTaskTraceViews(fallbackTaskTrace, agentTaskTrace, responseTask, explicitExpertTaskTrace, metadataTaskTrace, {
      runId: run.runId,
      status: 'cancelled',
      invokedAgents: []
    })
    const cancelledTaskTrace: AssistantTaskView = {
      ...(mergedTaskTrace ?? { invokedAgents: [] }),
      runId: run.runId,
      status: 'cancelled',
      invokedAgents: mergedTaskTrace?.invokedAgents ?? [],
      startedAt: mergedTaskTrace?.startedAt ?? run.startedAt,
      completedAt
    }
    const persistedTaskTrace = assistantTaskTracePayloadOf(cancelledTaskTrace, 'cancelled')
    const assistantMessageId = crypto.randomUUID()
    const cancelledMessages: ChatMessage[] = [
      ...run.baseMessages,
      { ...run.userMessage, contextOutcome: 'undone' },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '本次任务已停止，可修改问题后重试。',
        retryQuestion: run.question,
        ...(persistedTaskTrace ? { taskTrace: persistedTaskTrace } : {}),
        createdAt: completedAt,
        contextOutcome: 'undone'
      }
    ]

    // Invalidate the awaiting askAgent continuation before any state update.
    // Its catch/finally handlers will then become no-ops for this run.
    clearActiveRun(run.runId)
    setLoading(false)
    setQuestion(run.question)
    setMentionOpen(false)
    setAgentProgress([])
    setAgentRunMetadata(cancellationMetadata)
    setAgentRunStatus('cancelled')
    setAgentTaskTrace(cancelledTaskTrace)
    setAgentDetailsOpen(false)
    setMessages(cancelledMessages)
    setMessageRunMetadata((current) => ({ ...current, [assistantMessageId]: cancellationMetadata }))
    void persistSession(run.sessionId, cancelledMessages)
  }

  const cancelActiveRun = async (): Promise<void> => {
    const run = activeRunRef.current
    if (!run || run.cancelRequested || cancelPendingRunId === run.runId) return
    run.cancelRequested = true
    setCancelPendingRunId(run.runId)
    try {
      const result = await window.visslm.cancelAgentRun(run.runId)
      if (!isCurrentRun(run.runId)) return
      if (result.runId && result.runId !== run.runId) {
        run.cancelRequested = false
        setCancelPendingRunId(null)
        message.warning('停止请求未匹配当前任务，请继续等待结果')
        return
      }
      const cancelStatus = String(result.status ?? '').trim().toLocaleLowerCase()
      const accepted = result.ok || [
        'cancel_requested',
        'cancelling',
        'canceling',
        'stopping',
        'requested'
      ].includes(cancelStatus)
      if (accepted) {
        finalizeCancelledRun(run)
        return
      }
      run.cancelRequested = false
      setCancelPendingRunId(null)
      message.info(result.message ?? '任务已完成或暂时无法停止，请等待最终结果')
    } catch (error) {
      if (!isCurrentRun(run.runId)) return
      run.cancelRequested = false
      setCancelPendingRunId(null)
      message.warning(`停止任务失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const resetConversation = (successMessage = '已开始新会话'): void => {
    if (activeRunRef.current) {
      message.info('请先停止当前任务，再切换会话')
      return
    }
    const nextConversationId = crypto.randomUUID()
    clearAnswerStream()
    onConversationIdChange(nextConversationId)
    setMessages([])
    setQuestion('')
    userNearBottomRef.current = true
    setUserNearBottom(true)
    setShowScrollLatest(false)
    setHistoryMobileOpen(false)
    setMentionOpen(false)
    setAgentProgress([])
    setAgentRunMetadata({})
    setAgentRunStatus('idle')
    setAgentDetailsOpen(false)
    setAgentTaskTrace(null)
    executionSummaryRef.current = null
    setActiveExecutionSummary(null)
    setPlanAwaitingConfirmation(false)
    setPlanConfirming(false)
    setPlanExpired(false)
    setPlanValidationErrors([])
    setPlanWarnings([])
    setMessageRunMetadata({})
    setClarificationByMessageId({})
    setArtifactAttached(false)
    onClearDataScope()
    closeDataView()
    message.success(successMessage)
  }

  const mentionCandidates = useMemo(
    () => chatExperts.filter((expert) =>
      `${expert.name}${expert.mention}`.toLocaleLowerCase().includes(mentionQuery.toLocaleLowerCase())
    ),
    [mentionQuery]
  )

  const updateQuestion = (value: string): void => {
    setQuestion(value)
    const match = value.match(/(?:^|\s)@([^@\s]*)$/)
    setMentionOpen(Boolean(match))
    setMentionQuery(match?.[1] ?? '')
    setMentionIndex(0)
  }

  const selectExpert = (expert: (typeof chatExperts)[number]): void => {
    setQuestion((current) => {
      const match = current.match(/(^|\s)@[^@\s]*$/)
      if (!match || match.index === undefined) return `${expert.mention} ${current}`.trimStart()
      const prefix = current.slice(0, match.index) + match[1]
      return `${prefix}${expert.mention} `
    })
    setMentionOpen(false)
  }

  const startNewConversation = (): void => {
    if (loading || activeRunRef.current || cancelPendingRunId) return
    if (messages.length === 0 && !question.trim()) {
      resetConversation()
      return
    }
    modal.confirm({
      title: '开始新会话？',
      content: '当前消息和未发送内容将被清空，后续提问不会沿用本次会话上下文。',
      okText: '开始新会话',
      cancelText: '取消',
      onOk: resetConversation
    })
  }

  const loadSessionById = async (sessionId: string): Promise<void> => {
    if (activeRunRef.current) {
      message.info('请先停止当前任务，再切换会话')
      return
    }
    clearAnswerStream()
    setHistoryLoading(true)
    try {
      const session = await window.visslm.getChatSession(sessionId)
      if (!session) {
        message.warning('历史会话不存在或已被清理')
        await refreshHistory()
        return
      }
      onConversationIdChange(session.id)
      setMessages(session.messages)
      setQuestion('')
      userNearBottomRef.current = true
      setUserNearBottom(true)
      setShowScrollLatest(false)
      setHistoryMobileOpen(false)
      setMentionOpen(false)
      setAgentProgress([])
      setAgentRunMetadata({})
      setAgentRunStatus('idle')
      setAgentDetailsOpen(false)
      setAgentTaskTrace(null)
      executionSummaryRef.current = null
      setActiveExecutionSummary(null)
      setPlanAwaitingConfirmation(false)
      setPlanConfirming(false)
      setPlanExpired(false)
      setPlanValidationErrors([])
      setPlanWarnings([])
      setMessageRunMetadata({})
      setClarificationByMessageId({})
      const latestScopedMessage = [...session.messages].reverse().find((item) => item.dataScope)
      if (latestScopedMessage?.dataScope) {
        onRestoreDataScope(latestScopedMessage.dataScope, latestScopedMessage.dataScopeSummary || '已恢复会话数据范围')
      } else {
        onClearDataScope()
      }
      closeDataView()
      const latestDashboardMessage = [...session.messages]
        .reverse()
        .find((item) => item.dashboard)
      if (latestDashboardMessage?.dashboard) {
        onDashboardUpdate(latestDashboardMessage.dashboard, latestDashboardMessage.dashboardVersion)
        setArtifactAttached(true)
      } else {
        setArtifactAttached(false)
      }
      message.success(`已加载历史会话：${session.title}`)
    } catch (error) {
      message.error(`历史会话加载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setHistoryLoading(false)
    }
  }

  const requestLoadSession = (session: ChatSessionSummary): void => {
    if (loading || activeRunRef.current || cancelPendingRunId || historyLoading || session.id === conversationId) return
    const load = (): Promise<void> => loadSessionById(session.id)
    if (!messages.length && !question.trim()) {
      void load()
      return
    }
    modal.confirm({
      title: '切换历史会话？',
      content: '当前会话中的草稿和未保存内容将被清空。',
      okText: '加载会话',
      cancelText: '继续当前会话',
      onOk: load
    })
  }

  const requestDeleteSession = (session: ChatSessionSummary): void => {
    if (loading || activeRunRef.current || cancelPendingRunId || historyLoading) return
    modal.confirm({
      title: '删除历史会话？',
      content: `“${session.title}”及其消息记录将被删除，无法恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setHistoryLoading(true)
        try {
          const result = await window.visslm.deleteChatSession(session.id)
          if (!result.ok) {
            message.warning(result.message)
            return
          }
          setHistorySessions((items) => items.filter((item) => item.id !== session.id))
          if (session.id === conversationId) {
            resetConversation('当前会话已删除，已开始新会话')
          } else {
            message.success('历史会话已删除')
          }
        } catch (error) {
          message.error(`历史会话删除失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setHistoryLoading(false)
        }
      }
    })
  }

  const openRecordDetail = async (row: ChatDataRow, standalone = false): Promise<void> => {
    if (standalone) {
      dataViewPageRequestRef.current += 1
      setDataViewPageLoading(false)
      setActiveDataView(null)
      setActiveDataGroup('')
      setRecordDetailModalOpen(true)
    }
    setActiveRecordDetail(null)
    setRecordImagePage(null)
    setRecordDetailLoading(true)
    try {
      const detail = await window.visslm.getRecordForChat(row.uid)
      if (detail) {
        setActiveRecordDetail(detail)
        if (detail.imageCount > 0) {
          setRecordImagesLoading(true)
          try {
            setRecordImagePage(await window.visslm.getRecordImagePage(row.uid, 1, MAX_CHAT_DETAIL_IMAGES))
          } finally {
            setRecordImagesLoading(false)
          }
        }
      } else {
        message.warning('回答依据对应的记录不存在或已被删除')
        if (standalone) setRecordDetailModalOpen(false)
      }
    } catch (error) {
      message.error(`记录详情加载失败：${error instanceof Error ? error.message : String(error)}`)
      if (standalone) setRecordDetailModalOpen(false)
    } finally {
      setRecordDetailLoading(false)
    }
  }

  const openKnowledgeDetail = async (documentId: string, chunkId?: string): Promise<void> => {
    const normalizedDocumentId = documentId.trim()
    const normalizedChunkId = chunkId?.trim() || undefined
    if (!normalizedDocumentId) {
      message.warning('该知识文档依据缺少文档标识，暂时无法打开详情')
      return
    }
    const requestId = knowledgePreviewRequestRef.current + 1
    knowledgePreviewRequestRef.current = requestId
    setKnowledgePreviewOpen(true)
    setKnowledgePreviewLoading(true)
    setKnowledgePreviewError(null)
    setActiveKnowledgePreview(null)
    setActiveKnowledgeDetail(null)
    setActiveKnowledgeChunkId(normalizedChunkId ?? null)
    try {
      const preview = await window.visslm.getKnowledgeDocumentPreview(normalizedDocumentId)
      if (requestId !== knowledgePreviewRequestRef.current) return
      if (preview) {
        setActiveKnowledgePreview(preview)
        setActiveKnowledgeDetail(preview.document)
        if (preview.errorMessage) setKnowledgePreviewError(preview.errorMessage)
        return
      }
      const detail = await window.visslm.getKnowledgeDocument(normalizedDocumentId)
      if (requestId !== knowledgePreviewRequestRef.current) return
      if (detail) {
        setActiveKnowledgeDetail(detail)
        setKnowledgePreviewError('原始文档预览不可用，当前仅能查看索引正文')
      } else {
        setKnowledgePreviewError('回答依据对应的知识文档不存在或已被删除')
        message.warning('回答依据对应的知识文档不存在或已被删除')
      }
    } catch (error) {
      if (requestId !== knowledgePreviewRequestRef.current) return
      const previewError = error instanceof Error ? error.message : String(error)
      try {
        const detail = await window.visslm.getKnowledgeDocument(normalizedDocumentId)
        if (requestId !== knowledgePreviewRequestRef.current) return
        if (detail) {
          setActiveKnowledgeDetail(detail)
          setKnowledgePreviewError(`原始文档预览不可用，已显示索引正文（${previewError}）`)
        } else {
          setKnowledgePreviewError(`知识文档详情加载失败：${previewError}`)
          message.error(`知识文档详情加载失败：${previewError}`)
        }
      } catch (fallbackError) {
        if (requestId !== knowledgePreviewRequestRef.current) return
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        setKnowledgePreviewError(`知识文档详情加载失败：${previewError}；索引回退也失败：${fallbackMessage}`)
        message.error(`知识文档详情加载失败：${previewError}`)
      }
    } finally {
      if (requestId === knowledgePreviewRequestRef.current) setKnowledgePreviewLoading(false)
    }
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = messageListRef.current
      if (!container) return
      // New messages follow the user's viewport only while they are already
      // near the latest reply. Once they browse older messages, incoming
      // progress and answers must not take control of the scroll position.
      if (userNearBottomRef.current) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      }
      updateMessageScrollState()
    })
    return () => cancelAnimationFrame(frame)
  }, [messages.length, loading, conversationId, updateMessageScrollState])

  useEffect(() => {
    if (!streamingAnswer?.content) return
    const frame = requestAnimationFrame(() => {
      const container = messageListRef.current
      if (!container || !userNearBottomRef.current) return
      // Stream updates follow the viewport only when the user is already at
      // the latest message; browsing history must never be interrupted.
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
      updateMessageScrollState()
    })
    return () => cancelAnimationFrame(frame)
  }, [streamingAnswer?.content, updateMessageScrollState])

  useEffect(() => window.visslm.onAgentEvent((update) => {
    const activeRun = activeRunRef.current
    if (!activeRun || update.runId !== activeRun.runId) return
    if (activeRun.sessionId !== conversationId) return
    if (update.conversationId && update.conversationId !== conversationId) return
    const event = update.event
    if (event.type === 'text') {
      acceptAnswerTextEvent(activeRun, event)
      return
    }
    if (event.type === 'plan') {
      executionSummaryRef.current = event.summary
      setActiveExecutionSummary(event.summary)
      setPlanAwaitingConfirmation(event.requiresConfirmation)
      setPlanConfirming(false)
      setPlanExpired(false)
      setPlanValidationErrors([])
      setPlanWarnings([])
      setAgentRunStatus('running')
      return
    }
    const statusEvent = event
    if (statusEvent.type !== 'status') return
    setAgentProgress((items) => [...items, statusEvent].slice(-80))
    const eventMetadata = agentRunMetadataOf(statusEvent)
    if (Object.keys(eventMetadata).length) {
      setAgentRunMetadata((current) => mergeAgentRunMetadata(current, eventMetadata))
    }
    const eventTaskTrace = assistantEventTaskTraceViewOf(statusEvent, 'running')
    if (eventTaskTrace) {
      setAgentTaskTrace((current) => mergeAssistantTaskTraceViews(current, eventTaskTrace) ?? eventTaskTrace)
    }
    setAgentRunStatus('running')
  }), [acceptAnswerTextEvent, conversationId])

  const confirmExecutionPlan = async (patch: AssistantPlanPatchInput = {}): Promise<void> => {
    const run = activeRunRef.current
    if (!run || !planAwaitingConfirmation || planConfirming || planExpired) return
    setPlanConfirming(true)
    try {
      // Keep the call scoped to the run and send only the changed, editable
      // patch.  The main process owns all normalization and authorization.
      const confirmAgentPlan = window.visslm.confirmAgentPlan as unknown as (
        runId: string,
        planPatch?: AssistantPlanPatchInput
      ) => Promise<ConfirmAgentPlanResult>
      const result = await confirmAgentPlan(
        run.runId,
        Object.keys(patch).length ? patch : undefined
      )
      if (!isCurrentRun(run.runId)) return
      if (result.status === 'invalid') {
        setPlanValidationErrors(result.errors ?? [])
        setPlanWarnings(result.warnings ?? [])
        message.warning('执行计划校验未通过，请修正标记字段后重试')
        return
      }
      if (result.status === 'not_found') {
        setPlanExpired(true)
        setPlanAwaitingConfirmation(false)
        setPlanValidationErrors([])
        setPlanWarnings([])
        message.warning('执行计划已失效，请重新提交问题')
        return
      }
      const effectiveSummary = result.effectiveSummary
      if (effectiveSummary) {
        executionSummaryRef.current = effectiveSummary
        setActiveExecutionSummary(effectiveSummary)
      }
      setPlanExpired(false)
      setPlanValidationErrors([])
      setPlanWarnings(result.warnings ?? [])
      setPlanAwaitingConfirmation(false)
    } catch (error) {
      if (!isCurrentRun(run.runId)) return
      message.error(`确认执行计划失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (isCurrentRun(run.runId)) setPlanConfirming(false)
    }
  }

  const send = async (overrideQuestion?: string): Promise<void> => {
    const text = (overrideQuestion ?? question).trim()
    if (!text || loading || activeRunRef.current) return
    if (modelOnline !== true) {
      message.warning('模型未连接，请先完成系统配置')
      return
    }
    const sessionId = conversationId
    const runId = crypto.randomUUID()
    const startedAt = new Date().toISOString()
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      ...(dataScope ? { dataScope, dataScopeSummary } : {})
    }
    const next = [...messages, userMessage]
    const explicitSkill = explicitAgentSkillOf(text)
    const isFollowUp = followUpQuestionOf(text) && messages.some((item) => item.role === 'assistant')
    const initialRunMetadata = mergeAgentRunMetadata(
      explicitSkill ? { skill: explicitSkill } : {},
      isFollowUp ? { followUp: true } : {}
    )
    activeRunRef.current = {
      runId,
      sessionId,
      question: text,
      userMessage,
      baseMessages: [...messages],
      startedAt,
      initialMetadata: initialRunMetadata,
      cancelRequested: false
    }
    beginAnswerStream({ runId, sessionId })
    setActiveRunId(runId)
    setCancelPendingRunId(null)
    setMessages(next)
    setQuestion('')
    setMentionOpen(false)
    setAgentProgress([])
    setAgentRunMetadata(initialRunMetadata)
    setAgentRunStatus('running')
    setAgentDetailsOpen(false)
    executionSummaryRef.current = null
    setActiveExecutionSummary(null)
    setPlanAwaitingConfirmation(false)
    setPlanConfirming(false)
    setPlanExpired(false)
    setPlanValidationErrors([])
    setPlanWarnings([])
    setLoading(true)
    try {
      const hasExplicitExpertMention = /@(?:数据可视化专家|通用数据助手|需求分析专家|知识库专家|交付物专家)(?:\s|$)/.test(text)
      const requestsVisualization = /@数据可视化专家(?:\s|$)/.test(text)
      const requestsArtifactExport = /@交付物专家(?:\s|$)/.test(text)
      const requestArtifact = requestsVisualization && artifactAttached ? activeArtifact : null
      const artifactSourceMessage = requestsArtifactExport
        ? [...messages].reverse().find((item) => (
            item.role === 'assistant' && item.contextOutcome !== 'failed' &&
            item.contextOutcome !== 'undone' && item.evidenceBlocks?.length
          ))
        : undefined
      const artifactSourceIndex = artifactSourceMessage
        ? messages.findIndex((item) => item.id === artifactSourceMessage.id)
        : -1
      const artifactSourceQuestion = artifactSourceIndex > 0
        ? [...messages.slice(0, artifactSourceIndex)].reverse().find((item) => item.role === 'user')?.content
        : undefined
      const requestedArtifactFormat: AssistantArtifactOutputFormat = /(?:xlsx|excel|表格)/i.test(text)
        ? 'xlsx'
        : /(?:pptx|ppt|演示|汇报)/i.test(text)
          ? 'pptx'
          : /(?:zip|导出包|打包)/i.test(text)
            ? 'zip'
            : 'docx'
      const contextMessages = messages
        .filter((message) => message.contextOutcome !== 'failed' && message.contextOutcome !== 'undone')
        .map(({ role, content, contextOutcome, contextRefs }) => ({
          role,
          content,
          ...(contextOutcome ? { outcome: contextOutcome } : {}),
          ...(contextRefs?.length ? { contextRefs } : {})
        }))
      const response = await window.visslm.askAgent({
        runId,
        question: text,
        conversationId: sessionId,
        entrypoint: 'chat',
        expertId: 'general',
        chatMode: hasExplicitExpertMention ? 'expert' : 'auto',
        ...(dataScope ? { dataScope } : {}),
        ...(requestArtifact
          ? {
              activeArtifact: {
                artifactId: requestArtifact.id,
                ...(activeArtifactVersion === undefined ? {} : { version: activeArtifactVersion }),
                dashboard: requestArtifact
              }
          }
          : {}),
        ...(artifactSourceMessage?.evidenceBlocks?.length
          ? {
              artifactSource: {
                type: 'delivery_draft' as const,
                conversationId: sessionId,
                messageId: artifactSourceMessage.id,
                title: `交付物 · ${artifactSourceQuestion ?? artifactSourceMessage.content}`.slice(0, 120),
                question: artifactSourceQuestion ?? artifactSourceMessage.content,
                answer: artifactSourceMessage.content,
                executionSummary: artifactSourceMessage.executionSummary,
                evidenceBlocks: artifactSourceMessage.evidenceBlocks,
                dataViews: artifactSourceMessage.dataViews ?? [],
                sources: artifactSourceMessage.sources ?? [],
                outputFormat: requestedArtifactFormat,
                instructions: text.replace(/@交付物专家\s*/g, '').trim()
              }
            }
          : {}),
        history: requestArtifact ? contextMessages : contextMessages.slice(-8)
      })
      if (!isCurrentRun(runId)) return
      if (response.taskTrace?.runId && response.taskTrace.runId !== runId) return
      if (response.cancelled || response.taskTrace?.status === 'cancelled') {
        const currentRun = activeRunRef.current
        if (currentRun) finalizeCancelledRun(currentRun, response.taskTrace)
        return
      }
      // The final response is authoritative.  Clear the transient buffer in
      // the same update as the persisted message below so the answer never
      // flashes through an empty state and no partial is saved to history.
      clearAnswerStream(runId)
      const responseError = response.events?.find((event) => event.type === 'error')
      if (response.artifactPreview) {
        setArtifactExportFormat(response.artifactPreview.input.outputFormat ?? requestedArtifactFormat)
        setArtifactGenerationStatus('idle')
        setArtifactGenerationMessage('')
        setArtifactPreview(response.artifactPreview)
      }
      if (responseError?.recoverable) {
        setQuestion(text)
      }
      if (requestArtifact && (responseError || !response.dashboard)) {
        throw new Error(responseError?.message ?? response.answer)
      }
      const dashboardVersion = artifactVersionOf(response.events)
      if (response.dashboard) {
        onDashboardUpdate(response.dashboard, dashboardVersion)
        setArtifactAttached(true)
      }
      const responseMetadata = mergeAgentRunMetadata(
        initialRunMetadata,
        ...agentProgress.map((event) => agentRunMetadataOf(event)),
        ...(response.events ?? []).map((event) => agentRunMetadataOf(event)),
        agentRunMetadataOf(response),
        response.expertId ? { skill: response.expertId } : {}
      )
      const responseTaskStatus: AssistantTaskStatus = responseError
        ? 'failed'
        : response.needsClarification
          ? 'clarification'
          : 'completed'
      const responseTaskTraceCandidate = mergeAssistantTaskTraceViews(
        agentTaskTrace,
        assistantExpertTaskTraceViewOf(response, responseTaskStatus),
        ...(response.events ?? []).map((event) => assistantEventTaskTraceViewOf(event, 'running')),
        assistantIntentTaskTraceViewOf(response, responseTaskStatus),
        assistantTaskTraceViewOf(response, responseTaskStatus)
      )
      const responseTaskTrace = responseTaskTraceCandidate
        ? {
            ...responseTaskTraceCandidate,
            status: responseTaskStatus,
            ...(responseTaskStatus === 'clarification'
              ? { invokedAgents: [] as AssistantExecutionAgentId[] }
              : {})
          }
        : undefined
      const persistedTaskTrace = response.taskTrace ?? assistantTaskTracePayloadOf(responseTaskTrace, responseTaskStatus)
      if (response.artifactPreview) setArtifactPreview(response.artifactPreview)
      const assistantMessageId = crypto.randomUUID()
      const clarificationQuestion = response.clarificationQuestion?.trim() ||
        (response.needsClarification ? response.answer.trim() : '')
      const completedMessages: ChatMessage[] = [
        ...messages,
        { ...userMessage, contextOutcome: responseError ? 'failed' : 'success' },
        {
          id: assistantMessageId,
          role: 'assistant',
          content: response.answer,
          ...(responseError ? { retryQuestion: text } : {}),
          sources: response.sources,
          dataViews: response.dataViews,
          dashboard: response.dashboard,
          dashboardVersion,
          expertId: response.expertId,
          assistantIntent: response.assistantIntent,
          executionSummary: response.executionSummary ?? executionSummaryRef.current ?? undefined,
          recoverySuggestions: response.recoverySuggestions,
          evidenceBlocks: response.evidenceBlocks,
          ...(dataScope ? { dataScope, dataScopeSummary } : {}),
          ...(persistedTaskTrace ? { taskTrace: persistedTaskTrace } : {}),
          contextRefs: response.contextRefs,
          contextStats: response.contextStats,
          createdAt: new Date().toISOString(),
          contextOutcome: responseError ? 'failed' : 'success'
        }
      ]
      setMessages(completedMessages)
      setMessageRunMetadata((current) => ({ ...current, [assistantMessageId]: responseMetadata }))
      if (clarificationQuestion) {
        setClarificationByMessageId((current) => ({ ...current, [assistantMessageId]: clarificationQuestion }))
      }
      setAgentRunMetadata(responseMetadata)
      setAgentTaskTrace(responseTaskTrace ?? null)
      setAgentRunStatus(response.needsClarification ? 'clarification' : responseError ? 'failed' : 'idle')
      void persistSession(sessionId, completedMessages)
    } catch (error) {
      if (!isCurrentRun(runId)) return
      const currentRun = activeRunRef.current
      if (currentRun?.cancelRequested) {
        finalizeCancelledRun(currentRun)
        return
      }
      clearAnswerStream(runId)
      const rawMessage = error instanceof Error ? error.message : String(error)
      const errorMessage = rawMessage.replace(
        /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
        ''
      )
      setQuestion(text)
      const failedMessages: ChatMessage[] = [
        ...messages,
        { ...userMessage, contextOutcome: 'failed' },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `请求失败：${errorMessage}`,
          retryQuestion: text,
          createdAt: new Date().toISOString(),
          contextOutcome: 'failed'
        }
      ]
      setMessages(failedMessages)
      setAgentRunStatus('failed')
      void persistSession(sessionId, failedMessages)
  } finally {
      if (isCurrentRun(runId)) {
        clearAnswerStream(runId)
        clearActiveRun(runId)
        setLoading(false)
      }
    }
  }

  const copyAnswer = async (content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      message.success('回答已复制')
    } catch {
      message.warning('当前环境无法访问剪贴板，请手动选择文本复制')
    }
  }

  const artifactTypeLabel = (type: AssistantArtifactType): string => ({
    analysis_snapshot: '分析快照',
    saved_filter: '筛选视图',
    report_draft: '报告草稿',
    delivery_draft: '文件交付草稿'
  })[type]

  const commitArtifact = async (): Promise<void> => {
    if (!artifactPreview || artifactSaving) return
    setArtifactSaving(true)
    setArtifactGenerationStatus('generating')
    setArtifactGenerationMessage(`正在生成 ${artifactExportFormat.toUpperCase()} 文件`)
    let saved: AssistantArtifact | null = null
    try {
      // Rebuild the signed preview after a format switch so the persisted
      // artifact history reflects the file that is actually generated.
      const confirmedPreview = artifactPreview.input.outputFormat === artifactExportFormat
        ? artifactPreview
        : await window.visslm.previewAssistantArtifact({
            ...artifactPreview.input,
            outputFormat: artifactExportFormat
          })
      const committed = await window.visslm.commitAssistantArtifact(confirmedPreview)
      saved = committed
      setAssistantArtifacts((current) => [committed, ...current.filter((item) => item.id !== committed.id)])
      const result = await window.visslm.exportAssistantArtifact({
        artifactId: committed.id,
        format: artifactExportFormat
      })
      if (!result.ok || result.canceled) {
        const reverted = await window.visslm.revertAssistantArtifact(committed.id)
        setAssistantArtifacts((current) => current.map((item) => item.id === committed.id ? reverted : item))
        setArtifactGenerationStatus('cancelled')
        setArtifactGenerationMessage(result.message || '已取消生成，交付物记录已撤销')
        return
      }
      setArtifactGenerationStatus('succeeded')
      setArtifactGenerationMessage(result.message)
      setArtifactPreview(null)
      message.success(result.message)
    } catch (error) {
      if (saved) {
        try {
          const reverted = await window.visslm.revertAssistantArtifact(saved.id)
          setAssistantArtifacts((current) => current.map((item) => item.id === saved!.id ? reverted : item))
        } catch {
          // Preserve the original export error; the history view exposes any active record for manual revert.
        }
      }
      setArtifactGenerationStatus('failed')
      setArtifactGenerationMessage(error instanceof Error ? error.message : String(error))
      message.error(`保存交付物失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setArtifactSaving(false)
    }
  }

  const loadArtifactHistory = async (): Promise<void> => {
    setArtifactHistoryLoading(true)
    try {
      setAssistantArtifacts(await window.visslm.listAssistantArtifacts(100))
      setArtifactHistoryOpen(true)
    } catch (error) {
      message.error(`读取交付物记录失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setArtifactHistoryLoading(false)
    }
  }

  const revertArtifact = async (id: string): Promise<void> => {
    try {
      const reverted = await window.visslm.revertAssistantArtifact(id)
      setAssistantArtifacts((current) => current.map((item) => item.id === id ? reverted : item))
      message.success('交付物已撤销，原始数据未发生变化')
    } catch (error) {
      message.error(`撤销交付物失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const exportArtifact = async (
    artifact: AssistantArtifact,
    format: AssistantArtifactOutputFormat
  ): Promise<void> => {
    const exportKey = `${artifact.id}:${format}`
    setArtifactExporting(exportKey)
    try {
      const result = await window.visslm.exportAssistantArtifact({ artifactId: artifact.id, format })
      if (result.ok) message.success(result.message)
    } catch (error) {
      message.error(`导出交付物失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setArtifactExporting(null)
    }
  }

  const loadRunHistory = async (): Promise<void> => {
    setRunHistoryLoading(true)
    try {
      const [runs, stats] = await Promise.all([
        window.visslm.listAssistantRunHistory(200),
        window.visslm.getAssistantRunHistoryStats()
      ])
      setAssistantRunHistory(runs)
      setAssistantRunStats(stats)
      setRunHistoryOpen(true)
    } catch (error) {
      message.error(`读取 Agent 运行历史失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRunHistoryLoading(false)
    }
  }

  const rebuildWorkspaceIndex = async (): Promise<void> => {
    if (workspaceIndexRebuilding) return
    setWorkspaceIndexRebuilding(true)
    try {
      const result = await window.visslm.rebuildKnowledgeIndex()
      message.success(result.message)
      setWorkspaceProgress(null)
    } catch (error) {
      message.error(`索引重建失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setWorkspaceIndexRebuilding(false)
      await refreshWorkspaceStatus()
    }
  }

  const dataRecordCount = workspaceDataStats?.recordCount ?? 0
  const hasData = dataRecordCount > 0
  const workspaceReadiness = deriveAssistantWorkspaceReadiness({
    dataRecordCount: workspaceDataStats?.recordCount,
    knowledgeStats: workspaceStats,
    liveProgress: workspaceProgress,
    loadFailed: workspaceStatusFailed
  })
  const workspaceReadinessCopy = (() => {
    switch (workspaceReadiness.state) {
      case 'loading':
        return { title: '正在检查数据与索引', detail: '确认 Agent 当前可用的数据来源。' }
      case 'unavailable':
        return { title: '状态读取失败', detail: '暂时无法确认数据与索引状态，请刷新后再试。' }
      case 'no_data':
        return { title: '还没有可查询的数据', detail: '先同步或导入数据，也可以上传知识库文档。' }
      case 'indexing': {
        const progress = workspaceReadiness.progress
        const count = progress?.total ? `（${progress.current}/${progress.total}）` : ''
        return { title: '索引正在建立', detail: `${progress?.message || '数据已进入索引队列'}${count}` }
      }
      case 'index_failed':
        return {
          title: '索引建立失败',
          detail: workspaceReadiness.progress?.message || '数据仍然保留，可以重建索引后继续提问。'
        }
      case 'index_missing':
        return { title: '数据尚未建立索引', detail: '重建索引后，Agent 才能执行正文与知识语义检索。' }
      default:
        return { title: '数据与索引已就绪', detail: 'Agent 可以查询数据中心和知识库。' }
    }
  })()
  const latestStatus = agentProgress.at(-1)
  const activeAgentControlStep = agentControlStepOfStage(latestStatus?.stage) ?? 'understand'
  const observedAgentControlSteps = useMemo(
    () => new Set(agentProgress.map((event) => agentControlStepOfStage(event.stage)).filter(
      (step): step is AgentControlStepKey => Boolean(step)
    )),
    [agentProgress]
  )
  const agentControlFlow = useMemo(() => {
    const activeIndex = agentControlStepOrder.indexOf(activeAgentControlStep)
    const selectedSkill = Boolean(agentSkillLabelOf(agentRunMetadata))
    return agentControlStepOrder.map((step, index) => {
      let state: AgentControlStepState = 'pending'
      if (index < activeIndex || observedAgentControlSteps.has(step)) state = 'complete'
      if (step === activeAgentControlStep && agentRunStatus === 'running') state = 'active'
      if (step === 'skill' && selectedSkill && index <= activeIndex) state = 'complete'
      return { step, state }
    })
  }, [activeAgentControlStep, agentRunMetadata, agentRunStatus, observedAgentControlSteps])
  const visibleAgentProgress = useMemo(() => {
    const latestByStage = new Map<string, Extract<AgentEvent, { type: 'status' }>>()
    agentProgress.forEach((event) => {
      // Keep the original event key so existing requirement-matching labels
      // remain visible, while the ranker places legacy sub-stages under the
      // corresponding global phase.
      latestByStage.set(event.stage.trim().toLocaleLowerCase(), event)
    })
    return [...latestByStage.entries()]
      .sort(([left], [right]) => agentStageRankOf(left) - agentStageRankOf(right))
      .map(([, event]) => event)
  }, [agentProgress])
  const overallProgress = useMemo(() => requirementAnalysisProgressOf(agentProgress), [agentProgress])
  const matchProgress = useMemo(() => parseRequirementMatchProgress(agentProgress), [agentProgress])

  const matchProgressCount = (current?: number, total?: number): string => {
    if (current === undefined && total === undefined) return '—'
    if (current === undefined) return `待处理 / ${total}`
    return total === undefined ? String(current) : `${current} / ${total}`
  }

  const promptSuggestions = [
    {
      prompt: '@需求分析专家 分析需求编号 VISSLM-TSIS-3959',
      title: '分析需求匹配'
    },
    {
      prompt: '按类型统计当前数据',
      title: '分析数据分布'
    },
    {
      prompt: '有哪些最近修改的任务？',
      title: '查找最近变更'
    },
    {
      prompt: '知识库中有多少张图片？',
      title: '统计图片资源'
    }
  ]
  const notify = message
  const activeHistorySession = historySessions.find((session) => session.id === conversationId)
  const chatTitle = chatSessionTitleOf(activeHistorySession, messages)
  const isCancelling = Boolean(activeRunId && cancelPendingRunId === activeRunId)
  const activeStreamingAnswer = streamingAnswer && streamingAnswer.runId === activeRunId &&
    streamingAnswer.sessionId === conversationId && streamingAnswer.content.length > 0
    ? streamingAnswer
    : null
  const chatStatusLabel = activeStreamingAnswer
    ? '正在生成回答'
    : loading
    ? isCancelling
      ? '正在停止任务'
      : 'Agent 执行中'
    : agentRunStatus === 'failed'
      ? '上次任务失败，可重试'
      : agentRunStatus === 'clarification'
        ? '等待补充信息'
        : agentRunStatus === 'cancelled'
          ? '任务已停止，可重试'
          : messages.length
            ? '可继续提问'
            : '准备就绪'

  const assistantMarkdownComponents = {
    a: (props: AssistantMarkdownLinkProps) => renderAssistantMarkdownLink(props, openKnowledgeDetail)
  }

  return (
    <div className={`chat-page chat-workspace-v2 ${historyCollapsed ? 'history-collapsed' : ''} ${historyMobileOpen ? 'history-mobile-open' : ''} ${userNearBottom ? 'user-near-bottom' : 'user-browsing'}`}>
      <aside
        className={`chat-history-panel ${historyCollapsed ? 'is-collapsed' : ''} ${historyMobileOpen ? 'is-mobile-open' : ''}`}
        aria-label="历史会话"
        aria-hidden={historyCollapsed && !historyMobileOpen ? true : undefined}
      >
        <div className="chat-history-panel-header">
          <div className="chat-history-title">
            <HistoryOutlined />
            <span>历史会话</span>
          </div>
          <div className="chat-history-panel-actions">
            <Button
              type="text"
              icon={<ReloadOutlined />}
              loading={historyRefreshing}
              aria-label="刷新历史会话"
              onClick={() => void refreshHistory()}
            />
            <Button
              className="chat-history-toggle"
              type="text"
              icon={<LeftOutlined />}
              aria-label={historyMobileOpen ? '关闭历史会话' : '收起历史会话'}
              title={historyMobileOpen ? '关闭历史会话' : '收起历史会话'}
              onClick={() => {
                if (historyMobileOpen) setHistoryMobileOpen(false)
                else setHistoryCollapsed(true)
              }}
            />
          </div>
        </div>
        <div className="chat-history-panel-body">
          <div className="chat-history-tools">
            <Input
              className="chat-history-search"
              allowClear
              prefix={<SearchOutlined aria-hidden="true" />}
              value={historyQuery}
              aria-label="搜索历史会话"
              placeholder="搜索标题或预览"
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
            <div className="chat-history-result-row" aria-live="polite">
              <Text type="secondary" className="chat-history-result-count">
                {historyQuery.trim()
                  ? `找到 ${filteredHistorySessions.length} / ${historySessions.length} 个会话`
                  : `${historySessions.length} 个会话`}
              </Text>
              {historyQuery.trim() && (
                <Button type="link" size="small" onClick={() => setHistoryQuery('')}>
                  清除搜索
                </Button>
              )}
            </div>
            <Button
              size="small"
              icon={<FileTextOutlined />}
              loading={artifactHistoryLoading}
              onClick={() => void loadArtifactHistory()}
            >
              交付物记录
            </Button>
            <Button
              size="small"
              icon={<HistoryOutlined />}
              loading={runHistoryLoading}
              onClick={() => void loadRunHistory()}
            >
              运行历史
            </Button>
          </div>
          {historyLoading ? (
            <div className="chat-history-loading"><Spin /></div>
          ) : filteredHistorySessions.length ? (
            <div className="chat-history-list">
              {filteredHistorySessions.map((session) => (
                <div
                  role="button"
                  tabIndex={loading || Boolean(activeRunId) || historyLoading ? -1 : 0}
                  aria-disabled={loading || Boolean(activeRunId) || historyLoading}
                  aria-label={`打开历史会话：${session.title}`}
                  className={`chat-history-item ${session.id === conversationId ? 'active' : ''}`}
                  key={session.id}
                  onClick={() => requestLoadSession(session)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      requestLoadSession(session)
                    }
                  }}
                >
                  <span className="chat-history-item-main">
                    <strong>{session.title}</strong>
                    <small>{session.preview || '暂无消息预览'}</small>
                  </span>
                  <span className="chat-history-item-meta">
                    <span>{session.messageCount} 条</span>
                    <time>{formatChatSessionTime(session.updatedAt)}</time>
                  </span>
                  <Button
                    className="chat-history-delete"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={loading || Boolean(activeRunId) || historyLoading}
                    aria-label={`删除历史会话：${session.title}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestDeleteSession(session)
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                </div>
              ))}
            </div>
          ) : (
            <Empty
              className="chat-history-empty"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={historySessions.length ? '没有匹配的历史会话' : '暂无历史会话'}
            />
          )}
        </div>
      </aside>
      {historyMobileOpen && (
        <button
          type="button"
          className="chat-history-backdrop"
          tabIndex={-1}
          aria-label="关闭历史会话"
          onClick={() => setHistoryMobileOpen(false)}
        />
      )}
      <Card className="chat-card">
	        <div className="chat-toolbar chat-toolbar-v2">
          <Button
            className="chat-history-toggle chat-history-reopen"
            type="text"
            icon={<RightOutlined />}
            aria-label="展开历史会话"
            title="展开历史会话"
            onClick={() => setHistoryCollapsed(false)}
          />
          <Button
            className="chat-history-mobile-toggle"
            type="text"
            icon={<HistoryOutlined />}
            aria-label={historyMobileOpen ? '关闭历史会话' : '打开历史会话'}
            aria-expanded={historyMobileOpen}
            onClick={() => setHistoryMobileOpen((open) => !open)}
          />
          <div className="chat-session-label">
            <MessageOutlined />
            <div className="chat-session-copy">
              <Text
                strong
                className="chat-session-title"
                data-chat-session-title={chatTitle}
                title={chatTitle}
              >
                {chatTitle}
              </Text>
              <span className={`chat-session-status ${loading ? (isCancelling ? 'stopping' : 'running') : agentRunStatus === 'failed' ? 'failed' : agentRunStatus === 'clarification' ? 'waiting' : agentRunStatus === 'cancelled' ? 'stopped' : 'ready'}`}>
                <span className="chat-session-status-dot" aria-hidden="true" />
                <span>{messages.length ? `${messages.length} 条消息 · ${chatStatusLabel}` : chatStatusLabel}</span>
              </span>
            </div>
          </div>
          <div className="chat-toolbar-actions">
            <div className="chat-health-strip" aria-label="AI 工作区状态">
              <span className={`chat-health-item ${modelOnline === true ? 'success' : modelOnline === false ? 'error' : 'pending'}`}>
                {modelOnline === true ? <CheckCircleOutlined /> : modelOnline === false ? <ExclamationCircleOutlined /> : <InfoCircleOutlined />}
                <span>{modelOnline === true ? '模型可用' : modelOnline === false ? '模型离线' : '检测模型'}</span>
              </span>
            </div>
            <Button
              className="new-conversation-button"
              type="text"
              icon={<PlusOutlined />}
              disabled={loading || Boolean(activeRunId)}
              onClick={startNewConversation}
            >
              新建会话
            </Button>
          </div>
	        </div>
          {workspaceReadiness.state !== 'ready' && (
            <div
              className={`chat-workspace-readiness is-${workspaceReadiness.state}`}
              role={workspaceReadiness.state === 'index_failed' || workspaceReadiness.state === 'unavailable' ? 'alert' : 'status'}
              aria-live="polite"
            >
              <span className="chat-workspace-readiness-icon" aria-hidden="true">
                {workspaceReadiness.state === 'loading' || workspaceReadiness.state === 'indexing'
                  ? <SyncOutlined spin />
                  : workspaceReadiness.state === 'index_failed' || workspaceReadiness.state === 'unavailable'
                    ? <ExclamationCircleOutlined />
                    : <DatabaseOutlined />}
              </span>
              <span className="chat-workspace-readiness-copy">
                <strong>{workspaceReadinessCopy.title}</strong>
                <small>{workspaceReadinessCopy.detail}</small>
              </span>
              <span className="chat-workspace-readiness-actions">
                {workspaceReadiness.state === 'no_data' && (
                  <>
                    <Button size="small" type="primary" onClick={() => onOpenAssetCenter('data')}>准备数据</Button>
                    <Button size="small" onClick={() => onOpenAssetCenter('knowledge')}>上传文档</Button>
                  </>
                )}
                {(workspaceReadiness.state === 'index_failed' || workspaceReadiness.state === 'index_missing') && (
                  <Button
                    size="small"
                    type="primary"
                    icon={<ReloadOutlined />}
                    loading={workspaceIndexRebuilding}
                    onClick={() => void rebuildWorkspaceIndex()}
                  >
                    重建索引
                  </Button>
                )}
                {workspaceReadiness.state === 'index_failed' && (
                  <Button size="small" onClick={() => onOpenAssetCenter('knowledge')}>查看知识库</Button>
                )}
                {workspaceReadiness.state !== 'no_data' && (
                  <Button
                    size="small"
                    icon={<SyncOutlined />}
                    loading={workspaceStatusLoading}
                    onClick={() => void refreshWorkspaceStatus()}
                  >
                    刷新状态
                  </Button>
                )}
              </span>
            </div>
          )}
	        <div className="chat-message-region">
        <div
          className="message-list"
          ref={messageListRef}
          role="log"
          aria-label="当前会话消息"
          aria-live="polite"
          onScroll={handleMessageScroll}
        >
          {messages.length === 0 ? (
            <div className="chat-empty chat-welcome chat-minimal-welcome">
              <div className="chat-minimal-intro">
                <Title level={3}>把数据问题交给 Agent</Title>
                <Text type="secondary" className="chat-empty-description">
                  先确认事实，再给出结论；需要时可展开查看依据。
                </Text>
              </div>
              <div className="chat-minimal-status" aria-label="AI 工作区状态">
                <span className={`chat-minimal-status-item ${modelOnline === true ? 'ready' : modelOnline === false ? 'blocked' : 'pending'}`}>
                  {modelOnline === true ? <CheckCircleOutlined aria-hidden="true" /> : modelOnline === false ? <ExclamationCircleOutlined aria-hidden="true" /> : <InfoCircleOutlined aria-hidden="true" />}
                  <span>{modelOnline === true ? '模型可用' : modelOnline === false ? '模型未连接' : '检测模型'}</span>
                  {modelOnline === false && <Button type="link" size="small" onClick={onOpenSettings}>配置</Button>}
                </span>
                <span className={`chat-minimal-status-item ${hasData ? 'ready' : 'blocked'}`}>
                  {hasData ? <CheckCircleOutlined aria-hidden="true" /> : <ExclamationCircleOutlined aria-hidden="true" />}
                  <span>{hasData ? `${dataRecordCount} 条数据` : '暂无数据'}</span>
                  {!hasData && <Button type="link" size="small" onClick={() => onOpenAssetCenter('data')}>准备</Button>}
                </span>
                <span className={`chat-minimal-status-item ${workspaceReadiness.state === 'ready' ? 'ready' : workspaceReadiness.state === 'indexing' || workspaceReadiness.state === 'loading' ? 'pending' : 'blocked'}`}>
                  {workspaceReadiness.state === 'ready' ? <CheckCircleOutlined aria-hidden="true" /> : workspaceReadiness.state === 'indexing' || workspaceReadiness.state === 'loading' ? <SyncOutlined spin aria-hidden="true" /> : <BulbOutlined aria-hidden="true" />}
                  <span>{workspaceReadiness.state === 'ready' ? '索引就绪' : workspaceReadinessCopy.title}</span>
                </span>
              </div>
              <div className="prompt-grid chat-minimal-prompts" aria-label="快捷问题">
                {promptSuggestions.map((item) => (
                  <Button
                    className="prompt-card chat-minimal-prompt"
                    key={item.prompt}
                    aria-label={`填入快捷问题：${item.title}`}
                    onClick={() => {
                      setQuestion(item.prompt)
                      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
                    }}
                  >
                    <span className="chat-minimal-prompt-label">{item.title}</span>
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message, messageIndex) => {
              const messageMetadata = mergeAgentRunMetadata(
                agentRunMetadataOf(message),
                messageRunMetadata[message.id] ?? {}
              )
              const messageTaskTrace = assistantTaskTraceForMessage(message, messageMetadata)
              const clarificationQuestion = messageTaskTrace?.clarificationQuestion ||
                clarificationByMessageId[message.id]
              return (
              <div className={`message-row ${message.role}`} key={message.id}>
                <div className="message-avatar">
                  {message.role === 'assistant'
                    ? <ThemedAppIcon alt="VISSLM AI" />
                    : <UserOutlined />}
                </div>
                <div className="message-content">
                  <div className="message-meta">
                    <Text strong>{message.role === 'assistant' ? 'VISSLM AI' : '你'}</Text>
                    <Text type="secondary">
                      {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </Text>
                  </div>
                  <div
                    className="message-bubble"
                    role={message.contextOutcome === 'failed' ? 'alert' : undefined}
                  >
                    <div className="message-body">
                      {message.role === 'assistant' ? (
                        <div className="chat-markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={assistantMarkdownComponents}
                          >
                            {assistantMessageMarkdownOf(message)}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <Paragraph>{message.content}</Paragraph>
                      )}
                    </div>
                    {message.role === 'assistant' && messageTaskTrace ? (
                      <AgentTaskSummary task={messageTaskTrace} className="chat-answer-task-summary" />
                    ) : null}
                    {message.role === 'assistant' && message.executionSummary ? (
                      <details className="agent-execution-summary is-persisted">
                        <summary><span>本轮实际执行范围</span><small>展开核对检索计划</small></summary>
                        <div className="agent-execution-summary-body">
                          <div className="agent-execution-summary-grid">
                            <span><small>检索词</small><strong>{message.executionSummary.searchTerms.join('、') || '无全文检索词'}</strong></span>
                            <span><small>读取字段</small><strong>{message.executionSummary.fields.join('、') || '按任务所需字段'}</strong></span>
                            <span><small>项目</small><strong>{message.executionSummary.scope.projectIds.join('、') || '全部项目'}</strong></span>
                            <span><small>类型</small><strong>{message.executionSummary.scope.nodeTypes.join('、') || '全部类型'}</strong></span>
                            <span><small>记录</small><strong>{message.executionSummary.scope.recordCount === undefined ? '当前范围全部记录' : `${message.executionSummary.scope.recordCount} 条指定记录`}</strong></span>
                            <span><small>结果上限</small><strong>{message.executionSummary.limit} 条</strong></span>
                          </div>
                        </div>
                      </details>
                    ) : null}
                    {message.role === 'assistant' && !messageTaskTrace && (
                      agentSkillLabelOf(messageMetadata, message.expertId) ||
                      agentTaskTypeLabelOf(messageMetadata, message)
                    ) ? (
                      <div className="chat-answer-meta" aria-label="本次 Agent 任务信息">
                        {agentSkillLabelOf(messageMetadata, message.expertId) && (
                          <span className="chat-answer-meta-item">
                            <span>技能</span>
                            <strong>{agentSkillLabelOf(messageMetadata, message.expertId)}</strong>
                          </span>
                        )}
                        {agentTaskTypeLabelOf(messageMetadata, message) && (
                          <span className="chat-answer-meta-item">
                            <span>任务类型</span>
                            <strong>{agentTaskTypeLabelOf(messageMetadata, message)}</strong>
                          </span>
                        )}
                      </div>
                    ) : null}
                    {message.role === 'assistant' && clarificationQuestion ? (
                      <div className="chat-clarification" role="status" aria-live="polite">
                        <div className="chat-clarification-heading">
                          <InfoCircleOutlined aria-hidden="true" />
                          <strong>需要补充信息</strong>
                        </div>
                        <span>{clarificationQuestion}</span>
                        <small>已暂停工具执行，补充范围、字段或来源后可继续。</small>
                      </div>
                    ) : null}
                    {message.role === 'assistant' && message.recoverySuggestions?.length ? (
                      <div className="chat-recovery-suggestions" role="group" aria-label="安全改写建议">
                        <div className="chat-recovery-suggestions-heading">
                          <BulbOutlined aria-hidden="true" />
                          <strong>可安全重试</strong>
                          <span>只使用本轮已确认的字段、检索词和范围</span>
                        </div>
                        <div className="chat-recovery-suggestion-list">
                          {message.recoverySuggestions.map((suggestion) => (
                            <Button
                              key={suggestion.id}
                              disabled={loading}
                              onClick={() => {
                                setQuestion(suggestion.prompt)
                                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
                              }}
                            >
                              <strong>{suggestion.label}</strong>
                              <small>{suggestion.reason}</small>
                            </Button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {message.role === 'assistant' && message.contextStats &&
                      (message.contextStats.detailOmittedCount > 0 || message.contextStats.requestOmittedCount > 0) && (
                        <div className="chat-context-summary" role="status">
                          <InfoCircleOutlined aria-hidden="true" />
                          <span>
                            上下文已压缩：保留 {message.contextStats.detailIncludedCount} 条完整详情，
                            省略 {message.contextStats.detailOmittedCount} 条；
                            {message.contextStats.requestOmittedCount > 0
                              ? `另有 ${message.contextStats.requestOmittedCount} 条请求超出单次上限。`
                              : '完整编号索引仍可核验。'}
                            {message.contextStats.recoveryHint ? ` ${message.contextStats.recoveryHint}` : ''}
                          </span>
                        </div>
                      )}
                    {message.role === 'assistant' && (
                      <div className="message-tools">
                        <Tooltip title="复制回答">
                          <Button
                            className="message-copy-button"
                            type="text"
                            size="small"
                            icon={<CopyOutlined />}
                            aria-label="复制回答"
                            onClick={() => void copyAnswer(assistantMessageMarkdownOf(message))}
                          />
                        </Tooltip>
                        {message.retryQuestion && (
                          <Button
                            type="link"
                            size="small"
                            icon={<ReloadOutlined />}
                            onClick={() => void send(message.retryQuestion)}
                            disabled={loading}
                          >
                            重试本次任务
                          </Button>
                        )}
                        {message.contextOutcome === 'failed' && (
                          <Tag color="error">未完成</Tag>
                        )}
                        {message.contextOutcome === 'undone' && (
                          <Tag>已停止</Tag>
                        )}
                      </div>
                    )}
                    {message.dashboard ? (
                      <div className="chat-data-action">
                        <Button
                          type="primary"
                          icon={<FundProjectionScreenOutlined />}
                          onClick={() => onOpenDashboard(message.dashboard!, message.dashboardVersion)}
                        >
                          打开可视化大屏
                        </Button>
                        <Text type="secondary">
                          {message.dashboard.components.length} 个组件
                        </Text>
                      </div>
                      ) : null}
                      {message.role === 'assistant' && message.evidenceBlocks?.length ? (
                        <section className="chat-evidence-block" aria-label="回答证据区">
                          <div className="chat-evidence-block-heading">
                            <BulbOutlined aria-hidden="true" />
                            <strong>证据区</strong>
                            <span>记录、文档、聚合与查询明细使用同一核验入口</span>
                          </div>
                          <div className="chat-evidence-block-grid">
                            {message.evidenceBlocks.map((block) => {
                              const view = block.dataViewId
                                ? message.dataViews?.find((item) => item.id === block.dataViewId)
                                : undefined
                              const icon = block.kind === 'document'
                                ? <FileTextOutlined aria-hidden="true" />
                                : block.kind === 'record'
                                  ? <DatabaseOutlined aria-hidden="true" />
                                  : <EyeOutlined aria-hidden="true" />
                              const body = (
                                <>
                                  {icon}
                                  <span>
                                    <strong>{block.title}</strong>
                                    <small>{block.summary}</small>
                                    <em>
                                      {block.matchedCount === undefined
                                        ? `${block.count} 项`
                                        : `命中 ${block.matchedCount} 项${block.returnedCount === undefined ? '' : `，当前载入 ${block.returnedCount} 项`}`}
                                      {block.truncated ? ' · 可分页核验' : ''}
                                    </em>
                                  </span>
                                </>
                              )
                              return view ? (
                                <Button
                                  key={block.id}
                                  type="text"
                                  className={`chat-evidence-block-item ${block.kind}`}
                                  aria-label={`打开${block.title}：${block.summary}`}
                                  onClick={() => openDataView(view)}
                                >
                                  {body}
                                </Button>
                              ) : (
                                <div key={block.id} className={`chat-evidence-block-item ${block.kind}`}>
                                  {body}
                                </div>
                              )
                            })}
                          </div>
                        </section>
                      ) : null}
                      {message.role === 'assistant' && message.sources?.length ? (
                        <details className="source-list">
                          <summary className="source-list-title">
                            <BulbOutlined />
                            <Text strong>回答依据</Text>
                            <div
                              className="source-list-count"
                              aria-label={`回答依据：${[
                                chatSourceSummaryOf(message.sources).records
                                  ? `${chatSourceSummaryOf(message.sources).records} 条数据记录`
                                  : '',
                                chatSourceSummaryOf(message.sources).documents
                                  ? `${chatSourceSummaryOf(message.sources).documents} 份知识文档`
                                  : ''
                              ].filter(Boolean).join('，')}`}
                            >
                              {chatSourceSummaryOf(message.sources).records > 0 && (
                                <span className="source-kind-count record">
                                  <DatabaseOutlined aria-hidden="true" />
                                  <span>{chatSourceSummaryOf(message.sources).records} 条记录</span>
                                </span>
                              )}
                              {chatSourceSummaryOf(message.sources).documents > 0 && (
                                <span className="source-kind-count document">
                                  <FileTextOutlined aria-hidden="true" />
                                  <span>{chatSourceSummaryOf(message.sources).documents} 份文档</span>
                                </span>
                              )}
                            </div>
                            <span className="source-list-action" aria-hidden="true">
                              <span className="source-list-action-open">查看列表</span>
                              <span className="source-list-action-close">收起列表</span>
                              <DownOutlined />
                            </span>
                          </summary>
                          <div className="source-chips">
                            {message.sources.map((source, index) => {
                              const sourceIsDocument = source.sourceType === 'document'
                              const sourceTypeLabel = sourceIsDocument ? '知识文档' : '数据记录'
                              const sourceLocation = sourceIsDocument
                                ? knowledgeSourceLocationLabelOf(source)
                                : source.location || source.fileName || source.nodeType || '来源详情'
                              const snippet = source.snippet?.trim()
                              return (
                                <Button
                                  type="text"
                                  className={`source-chip ${sourceIsDocument ? 'document' : 'record'}`}
                                  key={`${source.chunkId ?? source.uid}-${index}`}
                                  aria-label={`打开${sourceTypeLabel}依据：${source.name}`}
                                  data-source-type={sourceIsDocument ? 'document' : 'record'}
                                  onClick={() => {
                                    if (sourceIsDocument) {
                                      if (source.documentId) void openKnowledgeDetail(source.documentId, source.chunkId)
                                      else notify.warning('该知识文档依据缺少文档标识，暂时无法打开详情')
                                      return
                                    }
                                    void openRecordDetail({
                                      uid: source.uid,
                                      name: source.name,
                                      nodeType: source.nodeType,
                                      itemId: source.itemId,
                                      values: {}
                                    }, true)
                                  }}
                                >
                                  {sourceIsDocument ? <FileTextOutlined aria-hidden="true" /> : <DatabaseOutlined aria-hidden="true" />}
                                  <span>
                                    <strong>[{index + 1}] {source.name}</strong>
                                    <small>
                                      <span className="source-chip-type">{sourceTypeLabel}</span>
                                      <span className="source-chip-location"> · {sourceLocation}</span>
                                      {snippet && !sourceIsDocument ? ` · 原文片段：${snippet.slice(0, 80)}` : ''}
                                    </small>
                                  </span>
                                </Button>
                              )
                            })}
                          </div>
                        </details>
                      ) : null}
                  </div>
                </div>
              </div>
              )
            })
          )}
          {loading && (
            <>
            {!activeStreamingAnswer && (
            <div className="message-row assistant">
              <div className="message-avatar">
                <ThemedAppIcon alt="VISSLM AI" />
              </div>
              <div className="message-content">
                <div className="message-meta">
                  <Text strong>VISSLM AI</Text>
                  <Text type="secondary">{agentRunMetadata.followUp ? '追问处理中' : '正在处理'}</Text>
                </div>
                <div className="message-bubble thinking">
                  <div className="agent-run-panel" aria-live="polite">
                    <div className="agent-run-current">
                      <span className="thinking-dots"><i /><i /><i /></span>
                      <span>{latestStatus?.message ?? '正在准备任务'}</span>
                      <Tag>{agentStageLabelOf(latestStatus?.stage)}</Tag>
                    </div>
                    {activeExecutionSummary && (
                      <AssistantExecutionPlanCard
                        summary={activeExecutionSummary}
                        pending={planAwaitingConfirmation}
                        confirming={planConfirming}
                        cancelling={isCancelling}
                        expired={planExpired}
                        projects={planProjects}
                        nodeTypes={planNodeTypes}
                        metadataLoading={planMetadataLoading}
                        metadataError={planMetadataError}
                        errors={planValidationErrors}
                        warnings={planWarnings}
                        onConfirm={confirmExecutionPlan}
                        onCancel={() => void cancelActiveRun()}
                        onClearIssues={() => {
                          setPlanValidationErrors([])
                          setPlanWarnings([])
                        }}
                      />
                    )}
                    {overallProgress && (
                      <div className="agent-run-progress-compact" aria-label={`整体进度 ${overallProgress.percent}%`}>
                        <div className="agent-run-progress-compact-heading">
                          <span>整体进度</span>
                          <strong>{overallProgress.percent}%</strong>
                        </div>
                        <Progress
                          percent={overallProgress.percent}
                          showInfo={false}
                          aria-label={`整体进度 ${overallProgress.percent}%`}
                        />
                      </div>
                    )}
                    <div className="agent-details-disclosure">
                      <button
                        type="button"
                        className="agent-details-toggle"
                        aria-expanded={agentDetailsOpen}
                        onClick={() => setAgentDetailsOpen((open) => !open)}
                      >
                        {agentDetailsOpen ? '收起执行详情' : '查看执行详情'}
                      </button>
                      {agentDetailsOpen && (
                      <div className="agent-details-content">
                    <div className="agent-run-context" aria-label="本次 Agent 任务信息">
                      <div className="agent-run-context-item">
                        <span>任务类型</span>
                        <strong>
                          {agentTaskTypeLabelOf(agentRunMetadata) ?? (latestStatus ? '识别中' : '待识别')}
                        </strong>
                      </div>
                      <div className="agent-run-context-item">
                        <span>选择技能</span>
                        <strong>{agentSkillLabelOf(agentRunMetadata) ?? '自动选择中'}</strong>
                      </div>
                      {agentRunMetadata.followUp && (
                        <Tag className="agent-run-follow-up" icon={<HistoryOutlined />}>
                          追问 · 沿用会话上下文
                        </Tag>
                      )}
                    </div>
                    <div className="agent-control-flow" aria-label="Agent 控制流">
                      {agentControlFlow.map(({ step, state }) => (
                        <span
                          className={`agent-control-step ${state}`}
                          key={step}
                          aria-current={state === 'active' ? 'step' : undefined}
                          title={`${agentControlStepLabels[step]}：${agentControlStepDescriptions[step]}`}
                        >
                          {state === 'complete'
                            ? <CheckCircleOutlined aria-hidden="true" />
                            : state === 'active'
                              ? <InfoCircleOutlined aria-hidden="true" />
                              : <span className="agent-control-step-index" aria-hidden="true">{agentControlStepOrder.indexOf(step) + 1}</span>}
                          <span className="agent-control-step-label">{agentControlStepLabels[step]}</span>
                          <small>{agentControlStepDescriptions[step]}</small>
                        </span>
                      ))}
                    </div>
                    <div className="agent-run-detail-heading">执行阶段</div>
                    <div className="agent-run-steps" aria-label="Agent 详细执行阶段">
                      {(visibleAgentProgress.length ? visibleAgentProgress : [{ stage: 'classify', message: '准备执行' }]).map((event, index) => {
                        const isActive = latestStatus ? event === latestStatus : index === 0
                        return (
                          <span
                            className={isActive ? 'active' : 'complete'}
                            key={`${event.stage}-${index}`}
                            aria-current={isActive ? 'step' : undefined}
                            title={event.message}
                          >
                            {isActive ? <InfoCircleOutlined /> : <CheckCircleOutlined />}
                            <span>{agentStageLabelOf(event.stage)}</span>
                          </span>
                        )
                      })}
                    </div>
                    {matchProgress.hasMatch && (
                      <div className="agent-review-progress" aria-label="需求分析进度">
                        <div className="agent-review-progress-heading">
                          <strong>{matchProgress.hasMatch ? '需求分析匹配进度' : '需求分析进度'}</strong>
                          {matchProgress.hasMatch && <Tag>逐条处理</Tag>}
                        </div>
                        {matchProgress.hasMatch && (
                          <div className="agent-review-progress-metrics">
                            <div className="agent-review-progress-metric">
                              <span>召回候选</span>
                              <strong>{matchProgress.recallTotal ?? '—'}</strong>
                            </div>
                            <div className="agent-review-progress-metric">
                              <span>重排候选</span>
                              <strong>{matchProgressCount(matchProgress.rerankCurrent, matchProgress.rerankTotal)}</strong>
                            </div>
                            <div className="agent-review-progress-metric">
                              <span>评分完成</span>
                              <strong>{matchProgressCount(matchProgress.scoredCurrent, matchProgress.scoredTotal)}</strong>
                            </div>
                            <div className="agent-review-progress-metric">
                              <span>解释完成</span>
                              <strong>{matchProgressCount(matchProgress.explanationDone, matchProgress.explanationTotal)}</strong>
                            </div>
                            <div className="agent-review-progress-metric">
                              <span>缓存命中</span>
                              <strong>{matchProgress.cacheHits ?? '—'}</strong>
                            </div>
                            <div className="agent-review-progress-metric">
                              <span>失败隔离</span>
                              <strong>{matchProgress.isolated ?? '—'}</strong>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                      </div>
                      )}
                    </div>
                </div>
              </div>
              </div>
            </div>
            )}
            {activeStreamingAnswer && (
                <div className="message-row assistant streaming-answer-row">
                  <div className="message-avatar">
                    <ThemedAppIcon alt="VISSLM AI" />
                  </div>
                  <div className="message-content">
                    <div className="message-meta">
                      <Text strong>VISSLM AI</Text>
                      <Text type="secondary">正在生成回答</Text>
                    </div>
                    <div
                      className="message-bubble streaming-answer-bubble"
                      role="status"
                      aria-live="polite"
                      aria-atomic="false"
                      aria-label="正在生成回答"
                    >
                      <div className="message-body">
                        <div className="chat-markdown">
                           <ReactMarkdown
                             remarkPlugins={[remarkGfm]}
                             components={assistantMarkdownComponents}
                           >
                            {restoreLegacyAssistantMarkdown(activeStreamingAnswer.content)}
                          </ReactMarkdown>
                        </div>
                        <span className="streaming-answer-cursor" aria-hidden="true" />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {showScrollLatest && (
          <Button
            className="chat-scroll-latest"
            type="default"
            icon={<DownOutlined aria-hidden="true" />}
            aria-label="回到最新"
            onClick={() => scrollToLatest('smooth')}
          >
            回到最新
          </Button>
        )}
        </div>
        <div className="composer">
          {(dataScope || (artifactAttached && activeArtifact)) && (
            <div className="chat-context-row">
              {dataScope && (
                <div className="chat-data-scope">
                  <span>
                    <DatabaseOutlined />
                    <strong>可视化范围</strong>
                    <Text type="secondary">{dataScopeSummary}</Text>
                  </span>
                  <Button type="text" size="small" onClick={onClearDataScope}>
                    清除
                  </Button>
                </div>
              )}
              {artifactAttached && activeArtifact && (
                <Tag className="chat-artifact-context" icon={<FundProjectionScreenOutlined />}>
                  已附加大屏：{activeArtifact.title}
                </Tag>
              )}
            </div>
          )}
          <div className="composer-input">
            {mentionOpen && (
              <div className="expert-mention-menu" role="listbox" aria-label="选择专家">
                {mentionCandidates.length ? mentionCandidates.map((expert, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === mentionIndex}
                    className={index === mentionIndex ? 'selected' : ''}
                    key={expert.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectExpert(expert)}
                  >
                    <span className="expert-mention-icon">
                      {expert.id === 'visualization'
                        ? <FundProjectionScreenOutlined />
                        : expert.id === 'requirement-analysis'
                          ? <FileSearchOutlined />
                          : <MessageOutlined />}
                    </span>
                    <span>
                      <strong>{expert.name}</strong>
                      <small>{expert.description}</small>
                    </span>
                    <Tag>{expert.mention}</Tag>
                  </button>
                )) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的专家" />
                )}
              </div>
            )}
            <Input.TextArea
              value={question}
              onChange={(event) => updateQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (mentionOpen && mentionCandidates.length) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const direction = event.key === 'ArrowDown' ? 1 : -1
                    setMentionIndex((index) =>
                      (index + direction + mentionCandidates.length) % mentionCandidates.length
                    )
                    return
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault()
                    selectExpert(mentionCandidates[mentionIndex] ?? mentionCandidates[0])
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setMentionOpen(false)
                    return
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (modelOnline !== true) {
                    message.warning('模型未连接，请先完成系统配置')
                    return
                  }
                  void send()
                }
              }}
              autoSize={{ minRows: 1, maxRows: 5 }}
              variant="borderless"
              aria-label="输入问题"
              placeholder="直接向 VISSLM AI 提问；需要专业数据处理时 @ 专家…"
            />
              <div className="composer-footer composer-toolbar">
                <div className="composer-toolbar-start">
                  <Button
                    className="chat-expert-button"
                    size="small"
                    icon={<FundProjectionScreenOutlined aria-hidden="true" />}
                    aria-label="选择专家"
                    onClick={() => {
                      const prefix = question && !question.endsWith(' ') ? `${question} ` : question
                      updateQuestion(`${prefix}@`)
                    }}
                  >
                    选择专家
                  </Button>
                  <span className="composer-hint">
                    <kbd>Enter</kbd> 发送
                    <span className="composer-hint-divider">·</span>
                    <kbd>Shift + Enter</kbd> 换行
                  </span>
                </div>
                <div className="composer-toolbar-end">
                  <span className={`composer-model-state ${modelOnline === true ? 'online' : modelOnline === false ? 'offline' : 'checking'}`} role="status" aria-live="polite">
                    <span className="composer-model-dot" aria-hidden="true" />
                    <span className="composer-model-note composer-disclaimer">
                      {modelOnline === false
                        ? '模型未连接'
                        : modelOnline === true
                          ? '模型可用'
                          : '正在检测模型'}
                    </span>
                  </span>
                  {modelOnline === false && (
                    <Button type="link" size="small" aria-label="配置模型" onClick={onOpenSettings}>
                      配置
                    </Button>
                  )}
                  <Button
                    className={`chat-send-button ${isCancelling ? 'is-stopping' : ''}`.trim()}
                    type={loading ? 'default' : 'primary'}
                    danger={loading}
                    icon={loading
                      ? <StopOutlined aria-hidden="true" />
                      : <SendOutlined aria-hidden="true" />}
                    aria-label={loading
                      ? (isCancelling ? '正在停止当前任务' : '停止当前任务')
                      : '发送'}
                    loading={isCancelling}
                    disabled={loading
                      ? isCancelling || !activeRunId
                      : !question.trim() || modelOnline !== true}
                    onClick={() => {
                      if (loading) void cancelActiveRun()
                      else void send()
                    }}
                  >
                    {loading ? (isCancelling ? '正在停止' : '停止') : '发送'}
                  </Button>
                </div>
              </div>
           </div>
         </div>
      </Card>
      <Modal
        title={null}
        open={Boolean(artifactPreview)}
        footer={null}
        width="min(1040px, calc(100vw - 32px))"
        closable={!artifactSaving}
        maskClosable={!artifactSaving}
        destroyOnHidden
        onCancel={() => {
          if (artifactSaving) return
          setArtifactPreview(null)
          setArtifactGenerationStatus('cancelled')
          setArtifactGenerationMessage('已取消')
        }}
      >
        <ArtifactExportPanel
          preview={artifactPreview}
          format={artifactExportFormat}
          onFormatChange={(format) => {
            setArtifactExportFormat(format)
            setArtifactGenerationStatus('idle')
            setArtifactGenerationMessage('')
          }}
          busy={artifactSaving}
          generationStatus={artifactGenerationStatus}
          statusMessage={artifactGenerationMessage}
          history={assistantArtifacts.map((artifact) => ({
            id: artifact.id,
            title: artifact.title,
            format: artifact.payload.outputFormat ?? 'docx',
            status: artifact.status,
            updatedAt: artifact.updatedAt,
            evidenceCount: artifact.payload.evidenceBlocks.length,
            dataRowCount: artifact.payload.dataViews.reduce((sum, view) => sum + view.total, 0)
          }))}
          onConfirm={commitArtifact}
          onCancel={() => {
            if (artifactSaving) return
            setArtifactPreview(null)
            setArtifactGenerationStatus('cancelled')
            setArtifactGenerationMessage('已取消')
          }}
          onHistorySelect={(item) => {
            const artifact = assistantArtifacts.find((candidate) => candidate.id === item.id)
            if (!artifact) return
            void window.visslm.previewAssistantArtifact(artifact.payload).then((preview) => {
              setArtifactPreview(preview)
              setArtifactExportFormat(artifact.payload.outputFormat ?? 'docx')
              setArtifactGenerationStatus('idle')
              setArtifactGenerationMessage('')
            })
          }}
        />
      </Modal>
      <Drawer
        title="AI 交付物记录"
        size={880}
        open={artifactHistoryOpen}
        onClose={() => setArtifactHistoryOpen(false)}
      >
        <div className="assistant-artifact-history">
          <Alert
            type="info"
            showIcon
            message="交付物是 EvidenceBlock 的本地版本，不会修改数据中心或知识库。撤销操作保留版本记录。"
          />
          <ResizableTable<AssistantArtifact>
            tableKey="assistant-artifact-history"
            rowKey="id"
            dataSource={assistantArtifacts}
            loading={artifactHistoryLoading}
            pagination={{ pageSize: 20 }}
            scroll={{ x: 1160, y: 'min(560px, max(260px, calc(100vh - 260px)))' }}
            columns={[
              { title: '标题', dataIndex: 'title', width: 320, ellipsis: true },
              { title: '类型', dataIndex: 'type', width: 120, render: (type: AssistantArtifactType) => artifactTypeLabel(type) },
              { title: '版本', dataIndex: 'version', width: 80, render: (version: number) => `v${version}` },
              { title: '状态', dataIndex: 'status', width: 100, render: (status: AssistantArtifact['status']) => <Tag color={status === 'active' ? 'success' : 'default'}>{status === 'active' ? '有效' : '已撤销'}</Tag> },
              { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: formatDate },
              {
                title: '操作',
                key: 'actions',
                width: 300,
                render: (_value, artifact) => artifact.status === 'active'
                  ? (
                    <Space size={4} wrap={false}>
                      {(['docx', 'xlsx', 'pptx', 'zip'] as const).map((format) => (
                        <Button
                          key={format}
                          type="link"
                          size="small"
                          loading={artifactExporting === `${artifact.id}:${format}`}
                          disabled={Boolean(artifactExporting && artifactExporting !== `${artifact.id}:${format}`)}
                          onClick={() => void exportArtifact(artifact, format)}
                        >
                          {format.toUpperCase()}
                        </Button>
                      ))}
                      <Button danger type="link" size="small" onClick={() => void revertArtifact(artifact.id)}>撤销</Button>
                    </Space>
                  )
                  : '—'
              }
            ]}
          />
        </div>
      </Drawer>
      <Drawer
        title="Agent 运行历史与质量指标"
        size={1040}
        open={runHistoryOpen}
        onClose={() => setRunHistoryOpen(false)}
      >
        <div className="assistant-run-history">
          {assistantRunStats && (
            <div className="assistant-run-stats" aria-label="Agent 运行统计">
              <Statistic title="运行总数" value={assistantRunStats.total} />
              <Statistic title="完成" value={assistantRunStats.completed} />
              <Statistic title="失败" value={assistantRunStats.failed} />
              <Statistic title="平均耗时" value={formatDurationSeconds(assistantRunStats.averageDurationMs)} />
              <Statistic title="工具阶段" value={assistantRunStats.totalToolCalls} />
              <Statistic title="累计命中" value={assistantRunStats.totalMatchedCount} />
            </div>
          )}
          <ResizableTable<AssistantRunHistoryWithTokenMetrics>
            tableKey="assistant-run-history-v2"
            rowKey="runId"
            dataSource={assistantRunHistory}
            loading={runHistoryLoading}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            scroll={{ x: 1700, y: 'min(540px, max(260px, calc(100vh - 360px)))' }}
            columns={[
              { title: '状态', dataIndex: 'status', width: 100, render: (status: AssistantRunHistory['status']) => <Tag color={status === 'completed' ? 'success' : status === 'failed' ? 'error' : status === 'clarification' ? 'warning' : 'default'}>{({ completed: '完成', failed: '失败', cancelled: '已取消', clarification: '待澄清' } as const)[status]}</Tag> },
              { title: '任务 / 来源', key: 'task', width: 200, render: (_value, run) => `${run.taskType} · ${run.sourceMode}` },
              { title: '主 Agent', dataIndex: 'primaryAgent', width: 140 },
              { title: '耗时', dataIndex: 'durationMs', width: 110, align: 'right', render: (value: number) => formatDurationSeconds(value) },
              { title: '输入 Token', dataIndex: 'inputTokenCount', width: 120, align: 'right', render: (value: number | undefined) => formatRunMetric(value) },
              { title: '输出 Token', dataIndex: 'outputTokenCount', width: 120, align: 'right', render: (value: number | undefined) => formatRunMetric(value) },
              { title: 'Tokens/s', dataIndex: 'tokensPerSecond', width: 110, align: 'right', render: (value: number | undefined) => formatRunMetric(value, 1) },
              { title: '工具阶段', dataIndex: 'toolCallCount', width: 100 },
              { title: '命中数', dataIndex: 'matchedCount', width: 90 },
              { title: '记录 / 文档依据', key: 'evidence', width: 140, render: (_value, run) => `${run.recordEvidenceCount} / ${run.documentEvidenceCount}` },
              { title: '失败阶段', dataIndex: 'failedStage', width: 120, render: (value: string) => value || '—' },
              { title: '完成时间', dataIndex: 'completedAt', width: 170, render: formatDate },
              { title: 'Run ID', dataIndex: 'runId', width: 180, ellipsis: true }
            ]}
          />
        </div>
      </Drawer>
      <Drawer
        className="knowledge-document-preview-drawer-panel"
        rootClassName="knowledge-document-preview-drawer"
        title={(
          <div className="knowledge-document-preview-drawer-title">
            <FileTextOutlined aria-hidden="true" />
            <span title={activeKnowledgePreview?.document.fileName ?? activeKnowledgeDetail?.fileName ?? '知识库文档'}>
              知识库文档 · {activeKnowledgePreview?.document.fileName ?? activeKnowledgeDetail?.fileName ?? '预览'}
            </span>
          </div>
        )}
        size={720}
        open={knowledgePreviewOpen}
        onClose={closeKnowledgePreview}
        destroyOnHidden
      >
        <Suspense
          fallback={(
            <div className="knowledge-document-preview__loading" role="status" aria-live="polite">
              <Spin size="small" />
              <Text type="secondary">正在加载预览模块…</Text>
            </div>
          )}
        >
          <KnowledgeDocumentPreviewer
            preview={activeKnowledgePreview}
            fallbackDocument={activeKnowledgeDetail}
            targetChunkId={activeKnowledgeChunkId}
            loading={knowledgePreviewLoading}
            error={knowledgePreviewError}
          />
        </Suspense>
      </Drawer>
      <Modal
        className="chat-data-modal"
        width="min(1120px, calc(100vw - 48px))"
        centered
        footer={null}
        open={Boolean(activeDataView || recordDetailModalOpen)}
        onCancel={closeDataView}
        destroyOnHidden
        title={
          <div className="chat-data-modal-title">
            <DatabaseOutlined />
            <span title={activeRecordDetail?.name ?? activeDataView?.title ?? '查询数据'}>
              {activeRecordDetail
                ? `数据中心记录 · ${activeRecordDetail.name}`
                : activeDataView?.title ?? '查询数据'}
            </span>
          </div>
        }
      >
        {(activeDataView || recordDetailModalOpen) && (
          <Spin spinning={recordDetailLoading}>
            {activeRecordDetail ? (
              <div className="chat-record-detail">
                <Button
                  className="chat-record-back"
                  type="link"
                  icon={<LeftOutlined />}
                  onClick={() => activeDataView ? setActiveRecordDetail(null) : closeDataView()}
                >
                  {activeDataView ? '返回查询列表' : '关闭详情'}
                </Button>
                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="名称" span={2}>
                    {activeRecordDetail.name}
                  </Descriptions.Item>
                  <Descriptions.Item label="UID">
                    {activeRecordDetail.uid}
                  </Descriptions.Item>
                  <Descriptions.Item label="类型">
                    {activeRecordDetail.nodeType}
                  </Descriptions.Item>
                  <Descriptions.Item label="业务编号">
                    {activeRecordDetail.itemId || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="项目 UID">
                    {activeRecordDetail.projectId || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="最后修改时间" span={2}>
                    {formatDate(activeRecordDetail.lastModifyTime)}
                  </Descriptions.Item>
                </Descriptions>
                {activeRecordDetail.imageCount > 0 && (
                  <>
                    <Divider titlePlacement="start">图片资源</Divider>
                    {activeRecordDetail.imageCount > MAX_CHAT_DETAIL_IMAGES && (
                      <Text type="secondary">
                        当前记录包含 {activeRecordDetail.imageCount} 个图片资源，按页加载，每页最多 {MAX_CHAT_DETAIL_IMAGES} 个。
                      </Text>
                    )}
                    <Spin spinning={recordImagesLoading}>
                      <Image.PreviewGroup>
                        <div className="image-grid">
                          {(recordImagePage?.images ?? []).map((image) => (
                            <div className="image-tile" key={image.id}>
                              <Image
                                loading="lazy"
                                src={image.assetUrl ?? ''}
                                alt={image.name}
                                fallback=""
                              />
                              <div>{image.name}</div>
                            </div>
                          ))}
                        </div>
                      </Image.PreviewGroup>
                    </Spin>
                    {(recordImagePage?.total ?? 0) > (recordImagePage?.pageSize ?? MAX_CHAT_DETAIL_IMAGES) && (
                      <div className="chat-image-pagination">
                        <Button
                          disabled={(recordImagePage?.page ?? 1) <= 1 || recordImagesLoading}
                          onClick={() => {
                            if (!activeRecordDetail || !recordImagePage) return
                            setRecordImagesLoading(true)
                            void window.visslm.getRecordImagePage(
                              activeRecordDetail.uid,
                              recordImagePage.page - 1,
                              recordImagePage.pageSize
                            ).then(setRecordImagePage).finally(() => setRecordImagesLoading(false))
                          }}
                        >上一页</Button>
                        <Text type="secondary">
                          第 {recordImagePage?.page ?? 1} / {Math.ceil((recordImagePage?.total ?? 0) / (recordImagePage?.pageSize ?? MAX_CHAT_DETAIL_IMAGES))} 页
                        </Text>
                        <Button
                          disabled={!recordImagePage || recordImagePage.page * recordImagePage.pageSize >= recordImagePage.total || recordImagesLoading}
                          onClick={() => {
                            if (!activeRecordDetail || !recordImagePage) return
                            setRecordImagesLoading(true)
                            void window.visslm.getRecordImagePage(
                              activeRecordDetail.uid,
                              recordImagePage.page + 1,
                              recordImagePage.pageSize
                            ).then(setRecordImagePage).finally(() => setRecordImagesLoading(false))
                          }}
                        >下一页</Button>
                      </div>
                    )}
                  </>
                )}
                <Divider titlePlacement="start">知识文本</Divider>
                <pre className="text-preview">
                  {activeRecordDetail.normalizedText || '暂无可索引文本'}
                </pre>
                <Collapse
                  className="chat-raw-details"
                  items={[{
                    key: 'raw',
                    label: '查看完整属性（原始 JSON）',
                    children: (
                      <pre className="json-preview">
                        {JSON.stringify(activeRecordDetail.raw, null, 2)}
                      </pre>
                    )
                  }]}
                />
              </div>
            ) : activeDataView ? (
              <div className="chat-data-modal-content">
                <div className="chat-data-summary">
                  <div>
                    <strong>{activeDataView.total}</strong>
                    <span>查询命中{activeDataView.isPreview ? '（当前为摘要预览）' : ''}</span>
                  </div>
                  <Text type="secondary">{activeDataView.description}</Text>
                </div>
                {activeDataView.groups.length > 1 && (
                  <div className="chat-data-group-picker">
                    <Text strong>查看分组</Text>
                    <Select
                      value={selectedDataGroup?.name}
                      onChange={changeActiveDataGroup}
                      options={activeDataView.groups.map((group) => ({
                        value: group.name,
                        label: `${group.name}（${group.count} 条）`
                      }))}
                      style={{ width: 280 }}
                    />
                  </div>
                )}
                {selectedDataGroup && (
                  <>
                    <div className="chat-data-table-meta">
                      <Text strong>{selectedDataGroup.name}</Text>
                      <Text type="secondary">
                        共 {selectedDataGroup.count} 条，当前展示{' '}
                        {selectedDataGroup.rows.length} 条
                        {(activeDataView.isPreview || selectedDataGroupPageable) && selectedDataGroup.rows.length < selectedDataGroup.count
                          ? '（其余记录按需查询）'
                          : ''}
                      </Text>
                    </div>
                    <ResizableTable<ChatDataRow>
                      tableKey="chat-data-results"
                      rowKey="uid"
                      size="small"
                      dataSource={selectedDataGroup.rows}
                      scroll={{ x: 960, y: appTableScrollY }}
                      pagination={{
                        current: selectedDataGroupPageable ? dataViewPage : undefined,
                        pageSize: 20,
                        ...(selectedDataGroupPageable
                          ? {
                              pageSize: dataViewPageSize,
                              total: selectedDataGroup.count,
                              onChange: (page: number, nextPageSize: number) => {
                                void loadDataViewPage(activeDataView, selectedDataGroup.name, page, nextPageSize)
                              }
                            }
                          : {}),
                        showSizeChanger: true,
                        pageSizeOptions: [20, 50, 100],
                        showTotal: (count) => `当前清单 ${count} 条`
                      }}
                      loading={dataViewPageLoading}
                      columns={[
                        {
                          title: '名称',
                          dataIndex: 'name',
                          width: 280,
                          ellipsis: true,
                          render: (name: string, row: ChatDataRow) => (
                            <Button
                              className="chat-data-name-button"
                              type="link"
                              title={name}
                              onClick={() => void openRecordDetail(row)}
                            >
                              {name || '未命名记录'}
                            </Button>
                          )
                        },
                        {
                          title: '类型',
                          dataIndex: 'nodeType',
                          width: 110
                        },
                        {
                          title: '业务编号',
                          dataIndex: 'itemId',
                          width: 160,
                          ellipsis: true
                        },
                        {
                          title: 'UID',
                          dataIndex: 'uid',
                          width: 100
                        },
                        ...activeDataView.fields.map((field) => ({
                          title: activeDataView.fieldLabels?.[field] ?? field,
                          key: field,
                          width: 180,
                          ellipsis: true,
                          render: (_value: unknown, row: ChatDataRow) => {
                            const value = row.values[field]
                            return Array.isArray(value) ? value.join('、') : value || '—'
                          }
                        }))
                      ]}
                    />
                  </>
                )}
              </div>
            ) : (
              <div className="chat-record-detail chat-record-detail-loading">
                <Text type="secondary">正在加载记录详情...</Text>
              </div>
            )}
          </Spin>
        )}
      </Modal>
    </div>
  )
}

function SyncPage({
  syncing,
  onSync,
  onDataChanged
}: {
  syncing: boolean
  onSync: (config: SyncScopeConfig) => Promise<SyncResult | null>
  onDataChanged: () => void
}): React.JSX.Element {
  const { message } = AntApp.useApp()
  const progress = useSyncProgress()
  const [config, setConfig] = useState<SyncScopeConfig>({ selectedTypes: [], rules: [] })
  const [typeInput, setTypeInput] = useState('')
  const [activeTypes, setActiveTypes] = useState<string[]>([])
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<SyncPreviewResult | null>(null)
  const [savedSignature, setSavedSignature] = useState('')
  const [activeTab, setActiveTab] = useState<'config' | 'logs'>('config')
  const [requestLogs, setRequestLogs] = useState<CollectionRequestLogRow[]>([])
  const [requestLogTotal, setRequestLogTotal] = useState(0)
  const [requestLogsLoading, setRequestLogsLoading] = useState(false)
  const [review, setReview] = useState<{ batchId: string; items: DataReviewItem[] } | null>(null)

  const configSignature = useMemo(() => JSON.stringify(config), [config])
  const isConfigSaved = Boolean(savedSignature) && savedSignature === configSignature

  useEffect(() => {
    void window.visslm
      .getSyncConfig()
      .then((saved) => {
        if (!saved) return
        setConfig(saved)
        setSavedSignature(JSON.stringify(saved))
        setActiveTypes(saved.selectedTypes.slice(0, 1))
      })
      .catch((error) => {
        message.error(`读取采集配置失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => setLoadingConfig(false))
  }, [message])

  useEffect(() => {
    if (!isConfigSaved) setPreview(null)
  }, [isConfigSaved])

  const loadRequestLogs = useCallback(async (): Promise<void> => {
    setRequestLogsLoading(true)
    try {
      const data = await window.visslm.listCollectionRequestLogs(1, 50)
      setRequestLogs(data.rows)
      setRequestLogTotal(data.total)
    } finally {
      setRequestLogsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRequestLogs()
  }, [loadRequestLogs])

  useEffect(() => {
    if (progress?.phase === 'done' || progress?.phase === 'error') {
      void loadRequestLogs()
    }
  }, [progress?.phase, loadRequestLogs])

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0

  const progressState = progress?.phase === 'error'
    ? 'error'
    : progress?.phase === 'done'
      ? 'done'
      : 'active'
  const progressStateLabel = progressState === 'error'
    ? '采集失败'
    : progressState === 'done'
      ? '采集完成'
      : '采集中'
  const progressMessage = progress?.message ?? '准备采集'

  const filtersFor = (nodeType: string): SyncFieldFilter[] =>
    config.rules.find((rule) => rule.nodeType === nodeType)?.filters ?? []

  const returnPropertyFor = (nodeType: string): string =>
    config.rules.find((rule) => rule.nodeType === nodeType)?.returnProperty ?? ''

  const updateFilters = (nodeType: string, filters: SyncFieldFilter[]): void => {
    setConfig((current) => ({
      ...current,
      rules: [
        ...current.rules.filter((rule) => rule.nodeType !== nodeType),
        {
          nodeType,
          returnProperty:
            current.rules.find((rule) => rule.nodeType === nodeType)?.returnProperty ?? '',
          filters
        }
      ]
    }))
  }

  const updateReturnProperty = (nodeType: string, returnProperty: string): void => {
    setConfig((current) => ({
      ...current,
      rules: [
        ...current.rules.filter((rule) => rule.nodeType !== nodeType),
        {
          nodeType,
          returnProperty,
          filters: current.rules.find((rule) => rule.nodeType === nodeType)?.filters ?? []
        }
      ]
    }))
  }

  const returnPropertiesFor = (nodeType: string): string[] =>
    [...new Set(
      returnPropertyFor(nodeType)
        .split(/[,，]/g)
        .map((field) => field.trim())
        .filter(Boolean)
    )]

  const updateReturnProperties = (nodeType: string, properties: string[]): void => {
    updateReturnProperty(
      nodeType,
      [...new Set(properties.map((field) => field.trim()).filter(Boolean))].join(',')
    )
  }

  const addType = (): void => {
    const nodeType = typeInput.trim()
    if (!nodeType) {
      message.warning('请输入数据类型')
      return
    }
    if (config.selectedTypes.includes(nodeType)) {
      message.warning(`数据类型 ${nodeType} 已存在`)
      setActiveTypes((current) => [...new Set([...current, nodeType])])
      return
    }
    setConfig((current) => ({
      selectedTypes: [...current.selectedTypes, nodeType],
      rules: [...current.rules, { nodeType, returnProperty: '', filters: [] }]
    }))
    setActiveTypes((current) => [...new Set([...current, nodeType])])
    setTypeInput('')
  }

  const removeType = (nodeType: string): void => {
    setConfig((current) => ({
      selectedTypes: current.selectedTypes.filter((item) => item !== nodeType),
      rules: current.rules.filter((rule) => rule.nodeType !== nodeType)
    }))
    setActiveTypes((current) => current.filter((item) => item !== nodeType))
  }

  const addFilter = (nodeType: string): void => {
    updateFilters(nodeType, [
      ...filtersFor(nodeType),
      { id: crypto.randomUUID(), field: '', operator: 'equals', value: '' }
    ])
  }

  const updateFilter = (
    nodeType: string,
    filterId: string,
    patch: Partial<SyncFieldFilter>
  ): void => {
    updateFilters(
      nodeType,
      filtersFor(nodeType).map((filter) =>
        filter.id === filterId ? { ...filter, ...patch } : filter
      )
    )
  }

  const validateConfig = (): boolean => {
    if (!config.selectedTypes.length) {
      message.warning('请至少添加一种采集数据类型')
      return false
    }
    for (const rule of config.rules) {
      const invalidReturnProperty = (rule.returnProperty ?? '')
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean)
        .find((field) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field))
      if (invalidReturnProperty) {
        message.warning(`${rule.nodeType} 的 ReturnProperty 字段 ${invalidReturnProperty} 格式无效`)
        return false
      }
      for (const filter of rule.filters) {
        if (!filter.field.trim()) {
          message.warning(`${rule.nodeType} 的过滤条件尚未填写字段 Key`)
          return false
        }
        if (
          !['empty', 'notEmpty'].includes(filter.operator) &&
          !filter.value.trim()
        ) {
          message.warning(`${rule.nodeType} 的过滤条件尚未填写属性值`)
          return false
        }
      }
    }
    return true
  }

  const saveConfig = async (): Promise<boolean> => {
    if (!validateConfig()) return false
    setSaving(true)
    try {
      await window.visslm.saveSyncConfig(config)
      setSavedSignature(configSignature)
      message.success('采集范围已保存')
      return true
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }

  const previewConfig = async (): Promise<void> => {
    if (!isConfigSaved) {
      message.warning('采集范围已修改，请先保存后再测试预览')
      return
    }
    setPreviewing(true)
    try {
      const result = await window.visslm.previewSync()
      setPreview(result)
      message.success(`预览完成，命中 ${result.matchedCount} 条记录`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewing(false)
    }
  }

  const startConfiguredSync = async (): Promise<void> => {
    if (!validateConfig()) return
    try {
      await window.visslm.saveSyncConfig(config)
      setSavedSignature(configSignature)
      const result = await onSync(config)
      if (result?.reviewBatchId && result.duplicates.length) {
        setReview({ batchId: result.reviewBatchId, items: result.duplicates })
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const operatorOptions = [
    { label: '等于', value: 'equals' },
    { label: '不等于', value: 'notEquals' },
    { label: '包含', value: 'contains' },
    { label: '不包含', value: 'notContains' },
    { label: '为空', value: 'empty' },
    { label: '不为空', value: 'notEmpty' },
    { label: '大于', value: 'greaterThan' },
    { label: '大于等于', value: 'greaterThanOrEqual' },
    { label: '小于', value: 'lessThan' },
    { label: '小于等于', value: 'lessThanOrEqual' }
  ]

  const commonReturnPropertyOptions = [
    '_valm_Name',
    '_valm_Description',
    '_valm_Status',
    'Priority',
    'IssueType',
    'Source',
    '_valm_AssignedTo',
    '_valm_Release',
    '_valm_CreateBy'
  ].map((field) => ({ label: field, value: field }))

  const collapseItems = config.selectedTypes.map((nodeType) => {
    const filters = filtersFor(nodeType)
    return {
      key: nodeType,
      label: (
        <div className="type-collapse-label">
          <Text strong>{nodeType}</Text>
          {filters.length > 0 && <Tag color="processing">{filters.length} 个条件</Tag>}
          <Button
            danger
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={(event) => {
              event.stopPropagation()
              removeType(nodeType)
            }}
          >
            删除类型
          </Button>
        </div>
      ),
      children: (
        <div className="type-scope-content">
          <div className="return-property-config">
            <div className="return-property-heading">
              <div>
                <Text strong>ReturnProperty</Text>
                <Text type="secondary">
                  选择或输入需要采集的字段 Key；系统会自动补充必要字段
                </Text>
              </div>
              <Tag color="blue">已选 {returnPropertiesFor(nodeType).length} 个字段</Tag>
            </div>
            <Select
              className="return-property-editor"
              mode="tags"
              value={returnPropertiesFor(nodeType)}
              options={commonReturnPropertyOptions}
              tokenSeparators={[',', '，']}
              optionFilterProp="label"
              allowClear
              maxTagCount="responsive"
              placeholder="输入字段 Key，按 Enter 或逗号添加"
              notFoundContent="按 Enter 添加自定义字段"
              onChange={(values) =>
                updateReturnProperties(nodeType, Array.isArray(values) ? values : [values])
              }
            />
            <Text className="return-property-hint" type="secondary">
              支持一次粘贴多个逗号分隔的字段；下拉菜单提供常用字段建议，也可以直接输入自定义字段
            </Text>
          </div>
          <div className="scope-subheading">
            <div>
              <Text strong>过滤条件列表</Text>
              <Text type="secondary">字段 Key 必须与 VISSLM 平台字段标识完全一致，多个条件按“并且”执行</Text>
            </div>
            <Button
              icon={<PlusOutlined />}
              onClick={() => addFilter(nodeType)}
            >
              添加条件
            </Button>
          </div>

          <ResizableTable<SyncFieldFilter>
            tableKey="data-sync-filter-config"
            className="filter-config-table"
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={filters}
            locale={{ emptyText: '尚未添加业务过滤条件，将按 _valm_ItemID 强制规则采集有效数据' }}
            scroll={{ x: 760, y: compactTableScrollY }}
            columns={[
              {
                title: '字段 Key',
                dataIndex: 'field',
                width: 280,
                render: (_field: string, filter) => (
                  <Input
                    value={filter.field}
                    placeholder="例如：_valm_Name"
                    onChange={(event) =>
                      updateFilter(nodeType, filter.id, { field: event.target.value })
                    }
                  />
                )
              },
              {
                title: '过滤方式',
                dataIndex: 'operator',
                width: 160,
                render: (_operator: string, filter) => (
                  <Select
                    value={filter.operator}
                    onChange={(operator) =>
                      updateFilter(nodeType, filter.id, {
                        operator,
                        value: ['empty', 'notEmpty'].includes(operator) ? '' : filter.value
                      })
                    }
                    options={operatorOptions}
                  />
                )
              },
              {
                title: '匹配值',
                dataIndex: 'value',
                render: (_value: string, filter) => {
                const noValue = filter.operator === 'empty' || filter.operator === 'notEmpty'
                return (
                  <Input
                    value={filter.value}
                    disabled={noValue}
                    placeholder={noValue ? '该方式无需匹配值' : '输入匹配值'}
                    onChange={(event) =>
                      updateFilter(nodeType, filter.id, { value: event.target.value })
                    }
                  />
                )
                }
              },
              {
                title: '操作',
                key: 'action',
                width: 70,
                align: 'center',
                render: (_value, filter) => (
                  <Button
                    danger
                    type="text"
                    aria-label="删除过滤条件"
                    icon={<DeleteOutlined />}
                    onClick={() =>
                      updateFilters(
                        nodeType,
                        filters.filter((item) => item.id !== filter.id)
                      )
                    }
                  />
                )
              }
            ]}
          />
        </div>
      )
    }
  })

  return (
    <div className="page-stack">
      <div className="page-toolbar">
        {activeTab === 'config' && <Space>
          <Button loading={saving} onClick={() => void saveConfig()}>
            保存采集范围
          </Button>
          <Button
            icon={<EyeOutlined />}
            loading={previewing}
            disabled={!isConfigSaved || !config.selectedTypes.length}
            onClick={() => void previewConfig()}
          >
            测试预览
          </Button>
          <Button
            type="primary"
            icon={<SyncOutlined spin={syncing} />}
            loading={syncing}
            disabled={loadingConfig}
            onClick={() => void startConfiguredSync()}
          >
            {syncing ? '正在采集' : '开始采集'}
          </Button>
        </Space>}
      </div>

      <Tabs
        className="page-inner-tabs"
        activeKey={activeTab}
        onChange={(key) => {
          const next = key as 'config' | 'logs'
          setActiveTab(next)
          if (next === 'logs') void loadRequestLogs()
        }}
        items={[
          { key: 'config', label: '采集配置' },
          {
            key: 'logs',
            label: requestLogTotal ? `请求日志（${requestLogTotal}）` : '请求日志'
          }
        ]}
      />

      {activeTab === 'config' && <Card
        className="sync-scope-card"
        title={
          <Space>
            <FilterOutlined />
            采集范围
          </Space>
        }
      >
        <Spin spinning={loadingConfig} description="正在读取采集配置">
          <div className="sync-scope-form">
            <div className="manual-type-entry">
              <div>
                <Text strong>手动添加数据类型</Text>
                <Paragraph type="secondary">
                  输入 VISSLM 数据类型的准确标识，例如 Project、Task 或 Requirement。
                </Paragraph>
              </div>
              <Space.Compact className="manual-type-input">
                <Input
                  value={typeInput}
                  placeholder="输入数据类型"
                  onChange={(event) => setTypeInput(event.target.value)}
                  onPressEnter={addType}
                />
                <Button type="primary" icon={<PlusOutlined />} onClick={addType}>
                  新增类型
                </Button>
              </Space.Compact>
            </div>
            {collapseItems.length ? (
              <Collapse
                className="sync-type-collapse"
                activeKey={activeTypes}
                onChange={(keys) => setActiveTypes(Array.isArray(keys) ? keys : [keys])}
                items={collapseItems}
              />
            ) : (
              <Empty description="尚未配置数据类型，请先手动新增" />
            )}
            <Alert
              showIcon
              type="info"
              title="_valm_ItemID 强制校验"
              description="系统只采集 _valm_ItemID 非空的数据；本地已存在的编号会自动过滤，并在采集完成后进入审查清单。"
            />
            <Text type="secondary">
              {isConfigSaved
                ? '采集范围已保存，可以测试预览或开始采集。'
                : config.selectedTypes.length
                  ? '当前配置尚未保存，保存后才能测试预览。'
                  : '默认不配置任何数据类型，请手动新增后保存。'}
            </Text>
          </div>
        </Spin>
      </Card>}

      {activeTab === 'config' && preview && (
        <Card
          className="sync-preview-card"
          title={
            <Space>
              <EyeOutlined />
              测试预览
            </Space>
          }
          extra={<Text type="secondary">仅预览，不写入本地知识库</Text>}
        >
          <Row gutter={[16, 16]} className="preview-metrics">
            <Col xs={24} sm={8}>
              <Statistic title="检查记录" value={preview.scannedCount} />
            </Col>
            <Col xs={24} sm={8}>
              <Statistic title="匹配记录" value={preview.matchedCount} />
            </Col>
            <Col xs={24} sm={8}>
              <Statistic title="缺少 _valm_ItemID" value={preview.invalidItemIdCount} />
            </Col>
          </Row>
          <div className="preview-type-summary">
            <Text type="secondary">类型分布：</Text>
            {preview.byType.length ? (
              preview.byType.map((item) => (
                <Tag color="blue" key={item.name}>
                  {item.name} · {item.value}
                </Tag>
              ))
            ) : (
              <Text type="secondary">当前条件未命中数据</Text>
            )}
          </div>
          <ResizableTable<SyncPreviewResult['samples'][number]>
            tableKey="data-sync-preview"
            className="sync-preview-table"
            rowKey="uid"
            size="small"
            pagination={false}
            dataSource={preview.samples}
            scroll={{ x: 1120, y: compactTableScrollY }}
            locale={{ emptyText: '没有匹配的样例记录' }}
            columns={[
              { title: '名称', dataIndex: 'name', width: 240, ellipsis: true },
              { title: '类型', dataIndex: 'nodeType', width: 130 },
              { title: '对象编号', dataIndex: 'itemId', width: 190, ellipsis: true },
              {
                title: '描述',
                dataIndex: 'description',
                width: 360,
                ellipsis: true,
                render: (description: string) => {
                  const text = plainTextFromHtml(description)
                  return <span title={text}>{text || '—'}</span>
                }
              },
              { title: 'UID', dataIndex: 'uid', width: 120 },
              { title: '项目 UID', dataIndex: 'projectId', width: 130 }
            ]}
          />
          {preview.matchedCount > preview.samples.length && (
            <Text type="secondary">
              当前仅展示前 {preview.samples.length} 条样例记录。
            </Text>
          )}
          <Divider />
          <div className="scope-subheading">
            <div>
              <Text strong>请求调试信息</Text>
              <Text type="secondary">
                共 {preview.requests.length} 次接口请求，认证 Token 已脱敏
              </Text>
            </div>
          </div>
          <Collapse
            className="preview-request-collapse"
            items={preview.requests.map((request) => ({
              key: String(request.id),
              label: (
                <div className="preview-request-label">
                  <Tag color={request.error ? 'error' : 'success'}>{request.method}</Tag>
                  <Text ellipsis title={request.endpoint}>{request.endpoint}</Text>
                  <Tag color={request.error ? 'error' : 'default'}>
                    {request.error ? '失败' : '成功'}
                  </Tag>
                </div>
              ),
              children: (
                <div className="preview-request-detail">
                  <Text strong>请求参数</Text>
                  <pre className="json-preview">
                    {JSON.stringify(request.params, null, 2)}
                  </pre>
                  <Text strong>{request.error ? '错误信息' : '返回值'}</Text>
                  <pre className="json-preview">
                    {request.error ?? JSON.stringify(request.response, null, 2)}
                  </pre>
                </div>
              )
            }))}
          />
        </Card>
      )}

      {activeTab === 'logs' && (
        <Card
          title="真实采集请求日志"
          extra={<Text type="secondary">共 {requestLogTotal} 条，显示最近 50 条</Text>}
        >
          <Alert
            showIcon
            type="info"
            title="这里只记录点击“开始采集”后实际发送的接口请求；测试预览不会写入日志"
            style={{ marginBottom: 16 }}
          />
          <ResizableTable<CollectionRequestLogRow>
            tableKey="data-collection-request-logs"
            rowKey="id"
            loading={requestLogsLoading}
            dataSource={requestLogs}
            scroll={{ y: appTableScrollY }}
            pagination={false}
            locale={{ emptyText: '暂无真实数据采集请求日志' }}
            expandable={{
              expandedRowRender: (log) => (
                <div className="preview-request-detail">
                  <Text strong>请求接口</Text>
                  <pre className="json-preview">{log.endpoint}</pre>
                  <Text strong>请求参数（Token 已脱敏）</Text>
                  <pre className="json-preview">{JSON.stringify(log.params, null, 2)}</pre>
                  <Text strong>{log.errorMessage ? '错误与返回摘要' : '返回摘要'}</Text>
                  <pre className="json-preview">
                    {JSON.stringify(
                      log.errorMessage
                        ? { error: log.errorMessage, response: log.response }
                        : log.response,
                      null,
                      2
                    )}
                  </pre>
                </div>
              )
            }}
            columns={[
              {
                title: '请求时间',
                dataIndex: 'createdAt',
                width: 180,
                render: formatDate
              },
              {
                title: '数据类型',
                dataIndex: 'nodeType',
                width: 170,
                ellipsis: true
              },
              {
                title: '请求接口',
                dataIndex: 'endpoint',
                ellipsis: true
              },
              {
                title: 'HTTP',
                dataIndex: 'httpStatus',
                width: 90,
                render: (status: number) => status || '—'
              },
              {
                title: '返回记录',
                dataIndex: 'recordCount',
                width: 110
              },
              {
                title: '请求状态',
                dataIndex: 'status',
                width: 110,
                render: (status: CollectionRequestLogRow['status']) => (
                  <Tag
                    color={
                      status === 'success'
                        ? 'success'
                        : status === 'failed'
                          ? 'error'
                          : 'processing'
                    }
                  >
                    {status === 'success' ? '成功' : status === 'failed' ? '失败' : '执行中'}
                  </Tag>
                )
              }
            ]}
          />
        </Card>
      )}

      {activeTab === 'config' && (progress || syncing) && (
        <Card
          className="sync-progress-card"
          title={
            <Space>
              <CloudDownloadOutlined />
              采集进度
            </Space>
          }
        >
          <div
            className={`sync-progress sync-progress--${progressState}`}
            role={progressState === 'error' ? 'alert' : 'status'}
            aria-live={progressState === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
            aria-label={`${progressStateLabel}：${progressMessage}`}
          >
            <Progress
              percent={progress?.phase === 'done' ? 100 : percent}
              status={
                progress?.phase === 'error'
                  ? 'exception'
                  : progress?.phase === 'done'
                    ? 'success'
                    : 'active'
              }
              aria-label={`${progressStateLabel}，${progress?.current ?? 0} / ${progress?.total ?? 0}`}
            />
            <div className="sync-progress-message">
              <span className="sync-progress-state" aria-hidden="true">
                {progressStateLabel}
              </span>
              <Text className="sync-progress-message-text" title={progressMessage}>
                {progressMessage}
              </Text>
            </div>
          </div>
        </Card>
      )}

      {activeTab === 'config' && <Alert
        showIcon
        type="info"
        title="安全说明"
        description="数据采集只读访问 VISSLM，不会修改平台数据。图片会保存为按 SHA-256 去重的本地二进制资源，导出时写入 .visslmpack；平台当前使用 HTTP，正式环境建议启用 HTTPS。"
      />}
      {review && (
        <DataReviewModal
          source="sync"
          batchId={review.batchId}
          items={review.items}
          onClose={() => setReview(null)}
          onApplied={(result) => {
            if (result.updatedCount > 0) onDataChanged()
            setReview((current) => {
              if (!current) return current
              const resolved = new Set(result.resolvedReviewIds)
              const items = current.items.filter((item) => !resolved.has(item.id))
              return items.length ? { ...current, items } : null
            })
          }}
        />
      )}
    </div>
  )
}

function PushPage({
  refreshKey,
  onPushed
}: {
  refreshKey: number
  onPushed: () => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [storedDraft] = useState<PushConfigDraft | null>(() => readPushConfigDraft())
  const [form] = Form.useForm<PushFormValues>()
  const [formValues, setFormValues] = useState<Partial<PushFormValues>>(() => ({
    insertAfterId: '-1',
    ...(storedDraft?.formValues ?? {})
  }))
  const [fieldMappings, setFieldMappings] = useState<PushFieldMapping[]>(() => storedDraft?.fieldMappings ?? [])
  const mappingInitializedRef = useRef(storedDraft?.mappingInitialized ?? false)
  const mappingMigrationPendingRef = useRef(storedDraft?.mappingMigrationPending ?? false)
  const [records, setRecords] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(storedDraft?.page ?? 1)
  const [pageSize, setPageSize] = useState(storedDraft?.pageSize ?? 20)
  const [search, setSearch] = useState(storedDraft?.search ?? '')
  const [releaseText, setReleaseText] = useState<string | undefined>(storedDraft?.releaseText)
  const [releaseValues, setReleaseValues] = useState<RecordReleaseValue[]>([])
  const [releaseValuesLoading, setReleaseValuesLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>(() => storedDraft?.selectedRowKeys ?? [])
  const [selectingAll, setSelectingAll] = useState(false)
  const [result, setResult] = useState<PushResult | null>(null)
  const [pushLogs, setPushLogs] = useState<PushLogRow[]>([])
  const [pushLogTotal, setPushLogTotal] = useState(0)
  const [logsLoading, setLogsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'config' | 'logs'>('config')

  useEffect(() => {
    const draft: PushConfigDraft = {
      version: 2,
      formValues,
      fieldMappings,
      mappingInitialized: mappingInitializedRef.current,
      ...(mappingMigrationPendingRef.current ? { mappingMigrationPending: true } : {}),
      selectedRowKeys,
      search,
      ...(releaseText !== undefined ? { releaseText } : {}),
      page,
      pageSize
    }
    writePushConfigDraft(draft)
    return () => writePushConfigDraft(draft)
  }, [fieldMappings, formValues, page, pageSize, releaseText, search, selectedRowKeys])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await window.visslm.listRecords({
        page,
        pageSize,
        search,
        ...(releaseText !== undefined ? { releaseText } : {})
      })
      setRecords(data.rows)
      setTotal(data.total)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, releaseText])

  const loadReleaseValues = useCallback(async (): Promise<void> => {
    setReleaseValuesLoading(true)
    try {
      setReleaseValues(await window.visslm.listRecordReleaseValues())
    } catch (error) {
      message.error(`读取发布属性候选失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setReleaseValuesLoading(false)
    }
  }, [message])

  const loadPushLogs = useCallback(async (): Promise<void> => {
    setLogsLoading(true)
    try {
      const data = await window.visslm.listPushLogs(1, 50)
      setPushLogs(data.rows)
      setPushLogTotal(data.total)
    } finally {
      setLogsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadPushLogs()
  }, [load, loadPushLogs, refreshKey])

  useEffect(() => {
    void loadReleaseValues()
  }, [loadReleaseValues, refreshKey])

  // The first visible record is the source of the initial field list. If the
  // current page is temporarily empty, fall back to the first selected UID
  // so a restored draft can still initialize while the table is loading.
  const firstMappingRecordUid = records[0]?.uid ?? selectedRowKeys[0]

  useEffect(() => {
    const initializingDefaults = !mappingInitializedRef.current
    const inspectingLegacyDefaults = !initializingDefaults &&
      mappingMigrationPendingRef.current &&
      fieldMappings.length > 0 &&
      fieldMappings.every((mapping) => mapping.sourceField === mapping.targetField)
    if ((!initializingDefaults && !inspectingLegacyDefaults) || !firstMappingRecordUid) return
    let canceled = false
    // The mapping needs only raw attributes; avoid loading the record's image
    // collection just to build the initial key list.
    const loadRecord = window.visslm.getRecordForChat ?? window.visslm.getRecord
    if (typeof loadRecord !== 'function') return
    void loadRecord(firstMappingRecordUid)
      .then((detail) => {
        if (canceled || !detail) return
        if (initializingDefaults && mappingInitializedRef.current) return
        const raw = isRecordObject(detail.raw) ? detail.raw : {}
        if (inspectingLegacyDefaults && !isLegacyDefaultPushFieldMappings(fieldMappings, raw)) return
        mappingInitializedRef.current = true
        mappingMigrationPendingRef.current = false
        setFieldMappings(buildDefaultPushFieldMappings(raw))
        setResult(null)
      })
      .catch(() => {
        // A transient detail lookup failure should not prevent a manual mapping.
      })
    return () => {
      canceled = true
    }
  }, [fieldMappings, firstMappingRecordUid, refreshKey])

  const clearSelection = (): void => {
    setSelectedRowKeys([])
    setResult(null)
  }

  const applyRecordFilter = (nextSearch: string, nextReleaseText?: string): void => {
    setSearch(nextSearch)
    setReleaseText(nextReleaseText)
    setPage(1)
    clearSelection()
  }

  const selectAllFiltered = async (): Promise<void> => {
    if (!total) {
      clearSelection()
      message.info('当前筛选范围没有可选择的数据')
      return
    }
    setSelectingAll(true)
    try {
      const uids = await window.visslm.listRecordUids({
        search,
        ...(releaseText !== undefined ? { releaseText } : {})
      })
      const uniqueUids = [...new Set(uids.map(String))]
      setSelectedRowKeys(uniqueUids)
      setResult(null)
      if (uniqueUids.length) {
        message.success(`已选择当前筛选结果 ${uniqueUids.length} 条`)
      } else {
        message.info('当前筛选范围没有可选择的数据')
      }
    } catch (error) {
      message.error(`选择筛选结果失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSelectingAll(false)
    }
  }

  const getConfig = async (): Promise<PushConfig> => {
    const values = await form.validateFields()
    if (!selectedRowKeys.length) throw new Error('请至少选择一条待推送数据')
    for (const mapping of fieldMappings) {
      if (!mapping.sourceField.trim() || !mapping.targetField.trim()) {
        throw new Error('请完整填写字段映射的源属性 Key 和目标属性 Key')
      }
      if (!pushMappingIdentifierPattern.test(mapping.sourceField.trim())) {
        throw new Error(`源属性 Key ${mapping.sourceField} 格式无效`)
      }
      if (pushForbiddenSourceFields.has(mapping.sourceField.trim())) {
        throw new Error(`源属性 Key ${mapping.sourceField} 是消息体禁止字段`)
      }
      if (!pushMappingIdentifierPattern.test(mapping.targetField.trim())) {
        throw new Error(`目标属性 Key ${mapping.targetField} 格式无效`)
      }
      if (pushForbiddenTargetFields.has(mapping.targetField.trim())) {
        throw new Error(`目标属性 Key ${mapping.targetField} 是消息体禁止字段`)
      }
    }
    const sourceKeys = fieldMappings.map((mapping) => mapping.sourceField.trim())
    const targetKeys = fieldMappings.map((mapping) => mapping.targetField.trim())
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new Error('字段映射中存在重复的源属性 Key')
    }
    if (new Set(targetKeys).size !== targetKeys.length) {
      throw new Error('字段映射中存在重复的目标属性 Key')
    }
    return {
      recordUids: selectedRowKeys,
      nodeType: values.nodeType.trim(),
      projectId: values.projectId.trim(),
      componentId: values.componentId?.trim(),
      parentId: values.parentId?.trim(),
      insertAfterId: values.insertAfterId?.trim(),
      insertBeforeId: values.insertBeforeId?.trim(),
      fieldMappings: fieldMappings.map((mapping) => ({
        ...mapping,
        sourceField: mapping.sourceField.trim(),
        targetField: mapping.targetField.trim()
      }))
    }
  }

  const addFieldMapping = (): void => {
    mappingInitializedRef.current = true
    mappingMigrationPendingRef.current = false
    setFieldMappings((current) => [
      ...current,
      { id: crypto.randomUUID(), sourceField: '', targetField: '' }
    ])
    setResult(null)
  }

  const updateFieldMapping = (
    id: string,
    patch: Partial<PushFieldMapping>
  ): void => {
    mappingInitializedRef.current = true
    mappingMigrationPendingRef.current = false
    setFieldMappings((current) =>
      current.map((mapping) => mapping.id === id ? { ...mapping, ...patch } : mapping)
    )
    setResult(null)
  }

  const removeFieldMapping = (id: string): void => {
    mappingInitializedRef.current = true
    mappingMigrationPendingRef.current = false
    setFieldMappings((current) => current.filter((mapping) => mapping.id !== id))
    setResult(null)
  }

  const previewRequests = async (): Promise<void> => {
    setPreviewing(true)
    try {
      const config = await getConfig()
      const preview = await window.visslm.previewPush(config)
      setResult(preview)
      setActiveTab('logs')
      const imageStats = pushImageStats(preview)
      message.success(
        imageStats.available
          ? `已生成 ${preview.total} 条 POST 请求预览，图片资源 ${imageStats.total} 个（未上传，未访问真实平台）`
          : `已生成 ${preview.total} 条 POST 请求预览，未访问真实平台`
      )
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewing(false)
    }
  }

  const confirmPush = async (): Promise<void> => {
    let config: PushConfig
    try {
      config = await getConfig()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      return
    }
    modal.confirm({
      title: `确认向平台新建 ${config.recordUids.length} 条数据？`,
      content: (
        <div className="push-confirm-copy">
          <span>
            图片资源会先逐项调用 <code>UploadRichImg</code>，同一记录内相同内容只复用本次上传结果，然后才调用 <code>/alm/rest/items</code> 执行真实 POST 写入。
          </span>
          <span className="push-confirm-warning">
            任一记录的图片上传失败时，该记录不会创建；请先检查请求预览中的资源状态、参数和消息体。
          </span>
        </div>
      ),
      okText: '确认推送',
      cancelText: '取消',
      onOk: async () => {
        setPushing(true)
        try {
          const pushed = await window.visslm.startPush(config)
          setResult(pushed)
          setActiveTab('logs')
          const imageStats = pushImageStats(pushed)
          if (imageStats.failed) {
            message.warning(
              `图片资源失败 ${imageStats.failed} 个；对应记录未创建。成功 ${pushed.successCount} 条，失败 ${pushed.failedCount} 条`
            )
          } else if (pushed.failedCount) {
            message.warning(
              `推送完成：成功 ${pushed.successCount} 条，失败 ${pushed.failedCount} 条`
            )
          } else {
            message.success(`推送成功，共 ${pushed.successCount} 条`)
          }
          onPushed()
          await Promise.all([load(), loadPushLogs()])
        } catch (error) {
          message.error(error instanceof Error ? error.message : String(error))
          throw error
        } finally {
          setPushing(false)
        }
      }
    })
  }

  const resultImageStats = result ? pushImageStats(result) : null

  return (
    <div className="page-stack">
      <div className="page-toolbar">
        {activeTab === 'config' && <Space>
          <Button
            icon={<EyeOutlined />}
            loading={previewing}
            disabled={!selectedRowKeys.length}
            onClick={() => void previewRequests()}
          >
            测试预览
          </Button>
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={pushing}
            disabled={!selectedRowKeys.length}
            onClick={() => void confirmPush()}
          >
            开始推送
          </Button>
        </Space>}
      </div>

      <Tabs
        className="page-inner-tabs"
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as 'config' | 'logs')}
        items={[
          { key: 'config', label: '推送配置' },
          {
            key: 'logs',
            label: pushLogTotal ? `请求日志（${pushLogTotal}）` : '请求日志'
          }
        ]}
      />

      {activeTab === 'config' && <Card
        className="compact-push-config-card"
        title="数据新建参数"
        extra={<Text type="secondary">必填 2 项 · 其他参数按需展开</Text>}
      >
        <Form
          form={form}
          layout="vertical"
          className="compact-push-form"
          initialValues={formValues}
          onValuesChange={(_changedValues, values) => {
            setFormValues(values)
            setResult(null)
          }}
        >
          <Row gutter={[14, 0]}>
            <Col xs={24} md={12}>
              <Form.Item
                label="nodeType"
                name="nodeType"
                rules={[{ required: true, whitespace: true, message: '请输入目标节点类型' }]}
              >
                <Input placeholder="例如：Task、Requirement" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                label="projectId"
                name="projectId"
                rules={[{ required: true, whitespace: true, message: '请输入目标项目 UID' }]}
              >
                <Input placeholder="目标项目 UID（必填）" />
              </Form.Item>
            </Col>
          </Row>
          <Collapse
            className="push-advanced-collapse"
            items={[
              {
                key: 'advanced',
                label: '高级位置参数（可选）',
                children: (
                  <Row gutter={[14, 0]}>
                    <Col xs={24} md={12} xl={6}>
                      <Form.Item label="componentId" name="componentId">
                        <Input placeholder="目标组件 UID" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12} xl={6}>
                      <Form.Item label="parentId" name="parentId">
                        <Input placeholder="父节点 UID" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12} xl={6}>
                      <Form.Item label="insertAfterId" name="insertAfterId">
                        <Input placeholder="-1 表示最后" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12} xl={6}>
                      <Form.Item
                        label="insertBeforeId"
                        name="insertBeforeId"
                        extra="填写后覆盖 insertAfterId"
                      >
                        <Input placeholder="指定节点之前" />
                      </Form.Item>
                    </Col>
                  </Row>
                )
              }
            ]}
          />
        </Form>

        <div className="push-mapping-section">
          <div className="push-mapping-heading">
            <div>
              <Text strong>字段映射</Text>
              <Text type="secondary">首次加载默认取第一条记录的属性；未映射属性不会写入消息体</Text>
            </div>
            <Button icon={<PlusOutlined />} onClick={addFieldMapping}>
              新增映射
            </Button>
          </div>
          {fieldMappings.length ? (
            <ResizableTable<PushFieldMapping>
              tableKey="push-field-mappings"
              className="push-mapping-table"
              rowKey="id"
              pagination={false}
              dataSource={fieldMappings}
              scroll={{ y: compactTableScrollY }}
              columns={[
                {
                  title: '当前数据属性 Key',
                  dataIndex: 'sourceField',
                  render: (_value, mapping) => (
                    <Input
                      value={mapping.sourceField}
                      placeholder="例如：Owner"
                      onChange={(event) =>
                        updateFieldMapping(mapping.id, { sourceField: event.target.value })
                      }
                    />
                  )
                },
                {
                  title: '',
                  key: 'arrow',
                  width: 46,
                  align: 'center',
                  render: () => <Text type="secondary">→</Text>
                },
                {
                  title: '目标属性 Key',
                  dataIndex: 'targetField',
                  render: (_value, mapping) => (
                    <Input
                      value={mapping.targetField}
                      placeholder="例如：_valm_Owner"
                      onChange={(event) =>
                        updateFieldMapping(mapping.id, { targetField: event.target.value })
                      }
                    />
                  )
                },
                {
                  title: '操作',
                  key: 'action',
                  width: 64,
                  align: 'center',
                  render: (_value, mapping) => (
                    <Button
                      danger
                      type="text"
                      aria-label="删除字段映射"
                      icon={<DeleteOutlined />}
                      onClick={() => removeFieldMapping(mapping.id)}
                    />
                  )
                }
              ]}
            />
          ) : (
            <div className="push-mapping-empty">
              暂无字段映射，未映射属性不会写入请求消息体
            </div>
          )}
        </div>

        <Alert
          showIcon
          type="warning"
          className="compact-push-alert"
          title="图片先上传；失败会阻止对应记录创建"
          description="请求消息体仅保留字段映射表中的属性；测试预览不上传图片也不发送请求；真实推送会先完成全部图片资源处理，再调用 /alm/rest/items，并强制移除 _valm_Uid、_valm_NodeType 和 _valm_ItemID。"
        />
      </Card>}

      {activeTab === 'config' && <Card
        className="push-record-selection-card"
        title={(
          <div className="push-record-selection-title">
            <span>选择待推送数据</span>
            <Text type="secondary" className="push-record-selection-count">
              已选 {selectedRowKeys.length} 条 · 当前筛选 {total} 条
            </Text>
          </div>
        )}
      >
        <div className="push-record-selection-toolbar">
          <Input.Search
            allowClear
            aria-label="搜索待推送数据"
            placeholder="搜索名称、编号和正文"
            defaultValue={search}
            onSearch={(value) => applyRecordFilter(value, releaseText)}
            onChange={(event) => {
              if (!event.target.value && search) applyRecordFilter('', releaseText)
            }}
            style={{ width: 320 }}
          />
          <Select<string>
            allowClear
            showSearch
            className="push-release-filter"
            loading={releaseValuesLoading}
            value={releaseText}
            placeholder="发布属性（_valm_Release_text）"
            aria-label="按发布属性（_valm_Release_text）筛选"
            style={{ width: 280 }}
            filterOption={(input, option) => String(option?.value ?? '').toLocaleLowerCase().includes(input.trim().toLocaleLowerCase())}
            options={releaseValues.map(({ value, count }) => ({
              value,
              label: (
                <span className="push-release-option">
                  <span className="push-release-option-value" title={value || '空值'}>
                    {value || '（空值）'}
                  </span>
                  <span className="push-release-option-count">{count} 条</span>
                </span>
              )
            }))}
            onChange={(value) => applyRecordFilter(search, value)}
          />
          <Button
            icon={<CheckCircleOutlined />}
            loading={selectingAll}
            disabled={loading || selectingAll || !total}
            onClick={() => void selectAllFiltered()}
          >
            选择全部筛选结果
          </Button>
          <Button
            icon={<ClearOutlined />}
            disabled={!selectedRowKeys.length || selectingAll}
            onClick={clearSelection}
          >
            清空选择
          </Button>
        </div>
        <div className="push-record-selection-meta" role="status" aria-live="polite">
          <Text type="secondary">
            当前筛选范围：{search.trim() ? `搜索“${search.trim()}”` : '全部搜索内容'} ·{' '}
            {releaseText !== undefined ? `发布属性“${releaseText || '空值'}”` : '全部发布属性'} · 共{' '}
            <span className="push-record-selection-total">{total} 条</span>；推送仅使用已选记录。
          </Text>
        </div>
        <ResizableTable<RecordRow>
          tableKey="push-record-selection"
          rowKey="uid"
          loading={loading}
          dataSource={records}
          scroll={{ x: 1120, y: appTableScrollY }}
          rowSelection={{
            selectedRowKeys,
            preserveSelectedRowKeys: true,
            onChange: (keys) => {
              setSelectedRowKeys(keys.map(String))
              setResult(null)
            }
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 条`
          }}
          onChange={(pagination: TablePaginationConfig) => {
            setPage(pagination.current ?? 1)
            setPageSize(pagination.pageSize ?? 20)
          }}
          columns={[
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: '本地类型', dataIndex: 'nodeType', width: 140 },
            { title: '对象编号', dataIndex: 'itemId', width: 200, ellipsis: true },
            { title: 'UID', dataIndex: 'uid', width: 140 },
            {
              title: '发布属性',
              dataIndex: 'releaseText',
              width: 220,
              ellipsis: true,
              render: (value: string) => value || '—'
            },
            { title: '图片资源', dataIndex: 'imageCount', width: 100 },
            {
              title: '数据状态',
              key: 'pushStatus',
              width: 120,
              render: (_value, record) => renderPushStatus(record)
            }
          ]}
        />
      </Card>}

      {activeTab === 'logs' && result && (
        <Card
          className="push-debug-card"
          title="接口调试信息"
          extra={
            <Tag color={result.preview ? 'processing' : result.failedCount ? 'warning' : 'success'}>
              {result.preview
                ? '仅预览，未发送'
                : `成功 ${result.successCount} / 失败 ${result.failedCount}`}
            </Tag>
          }
        >
          <Text type="secondary">
            共 {result.requests.length} 次 POST 请求，认证 Token 已脱敏
          </Text>
          {resultImageStats?.available && (
            <div className="push-image-summary" role="status" aria-label="图片资源推送统计">
              <Tag color="processing">图片资源 {resultImageStats.total}</Tag>
              <Tag color="success">本次上传 {resultImageStats.uploaded}</Tag>
              <Tag color="default">复用已有 {resultImageStats.reused}</Tag>
              <Tag color={resultImageStats.failed ? 'error' : 'default'}>
                失败 {resultImageStats.failed}
              </Tag>
            </div>
          )}
          {resultImageStats && resultImageStats.failed > 0 && (
            <Alert
              showIcon
              type="error"
              className="push-image-blocking-alert"
              title="图片资源失败会阻止对应记录创建"
              description={
                result.preview
                  ? '预览已标记失败资源；真实推送时必须先完成全部图片上传，才会调用 /alm/rest/items。'
                  : `有 ${resultImageStats.failed} 个图片资源未上传成功，对应记录未调用 /alm/rest/items。`
              }
            />
          )}
          <Collapse
            className="preview-request-collapse push-request-collapse"
            items={result.requests.map((request) => ({
              key: String(request.id),
              label: (
                <div className="preview-request-label">
                  <Tag color={request.error ? 'error' : 'blue'}>POST</Tag>
                  <Text>{request.recordName}</Text>
                  <Text ellipsis title={request.endpoint}>{request.endpoint}</Text>
                  <Tag
                    color={request.imageFailed ? 'error' : request.error ? 'error' : result.preview ? 'default' : 'success'}
                  >
                    {request.imageFailed
                      ? '未创建（图片失败）'
                      : request.error
                        ? '失败'
                        : result.preview
                          ? '未发送'
                          : '成功'}
                  </Tag>
                </div>
              ),
              children: (
                <div className="preview-request-detail">
                  {typeof request.imageTotal === 'number' && (
                    <div className="push-request-image-summary" aria-label="当前记录图片资源状态">
                      <Text strong>图片资源</Text>
                      <Text type="secondary">
                        共 {request.imageTotal} 个 · 上传 {request.imageUpload ?? 0} · 复用 {request.imageReuse ?? 0} · 失败 {request.imageFailed ?? 0}
                      </Text>
                      {request.imageFailed ? (
                        <Text type="danger">
                          图片失败，当前记录不会创建
                        </Text>
                      ) : null}
                      {request.imageErrors?.length ? (
                        <ul className="push-request-image-errors">
                          {request.imageErrors.slice(0, 5).map((error) => <li key={error}>{error}</li>)}
                        </ul>
                      ) : null}
                    </div>
                  )}
                  <Text strong>请求参数</Text>
                  <pre className="json-preview">
                    {JSON.stringify(request.params, null, 2)}
                  </pre>
                  <Text strong>请求消息体</Text>
                  <pre className="json-preview">
                    {JSON.stringify(request.body, null, 2)}
                  </pre>
                  <Text strong>{request.error ? '错误信息' : '返回值'}</Text>
                  <pre className="json-preview">
                    {request.error ?? JSON.stringify(request.response, null, 2)}
                  </pre>
                </div>
              )
            }))}
          />
        </Card>
      )}

      {activeTab === 'logs' && <Card
        title="推送请求日志"
        extra={<Text type="secondary">共 {pushLogTotal} 条，显示最近 50 条</Text>}
      >
        <Alert
          showIcon
          type="info"
          title="日志存储说明"
          description="日志保留接口、脱敏参数、请求属性、HTTP 状态、平台返回值及错误信息；为控制数据量，请求日志不保存 _valm_Description 字段。"
          style={{ marginBottom: 16 }}
        />
        <ResizableTable<PushLogRow>
          tableKey="push-request-logs"
          rowKey="id"
          loading={logsLoading}
          dataSource={pushLogs}
          scroll={{ y: appTableScrollY }}
          pagination={false}
          locale={{ emptyText: '暂无真实推送请求日志' }}
          expandable={{
            expandedRowRender: (log) => (
              <div className="preview-request-detail">
                <Text strong>请求参数（Token 已脱敏）</Text>
                <pre className="json-preview">{JSON.stringify(log.params, null, 2)}</pre>
                <Text strong>请求属性（未记录 _valm_Description）</Text>
                <pre className="json-preview">{JSON.stringify(log.body, null, 2)}</pre>
                <Text strong>{log.errorMessage ? '错误与平台返回' : '平台返回值'}</Text>
                <pre className="json-preview">
                  {JSON.stringify(
                    log.errorMessage
                      ? { error: log.errorMessage, response: log.response }
                      : log.response,
                    null,
                    2
                  )}
                </pre>
              </div>
            )
          }}
          columns={[
            {
              title: '请求时间',
              dataIndex: 'createdAt',
              width: 180,
              render: formatDate
            },
            {
              title: '数据',
              dataIndex: 'recordName',
              ellipsis: true
            },
            {
              title: '目标类型',
              width: 160,
              render: (_value, log) => log.params.nodeType || '—'
            },
            {
              title: '项目 UID',
              width: 120,
              render: (_value, log) => log.params.projectId || '—'
            },
            {
              title: 'HTTP',
              dataIndex: 'httpStatus',
              width: 90,
              render: (status: number) => status || '—'
            },
            {
              title: '请求状态',
              dataIndex: 'status',
              width: 110,
              render: (status: PushLogRow['status']) => (
                <Tag
                  color={
                    status === 'success'
                      ? 'success'
                      : status === 'failed'
                        ? 'error'
                        : 'processing'
                  }
                >
                  {status === 'success' ? '成功' : status === 'failed' ? '失败' : '发送中'}
                </Tag>
              )
            },
            {
              title: '远端 UID',
              dataIndex: 'remoteUid',
              width: 120,
              render: (value: string) => value || '—'
            }
          ]}
        />
      </Card>}
    </div>
  )
}

function SettingsPanelHeading({
  title,
  description,
  titleId,
  extra,
  className
}: {
  title: string
  description: string
  titleId?: string
  extra?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={['settings-panel-heading', className].filter(Boolean).join(' ')}>
      <div className="settings-panel-heading-copy">
        <Title id={titleId} level={4}>{title}</Title>
        <Text type="secondary">{description}</Text>
      </div>
      {extra}
    </div>
  )
}

const formatUpdateBytes = (value?: number): string => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let amount = value
  let unitIndex = 0
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }
  return `${amount >= 100 || unitIndex === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unitIndex]}`
}

const formatUpdateDate = (value?: string): string => {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
}

const updateStatusLabel = (status: UpdateStatus | null): string => {
  if (!status) return '正在读取更新状态'
  switch (status.phase) {
    case 'idle': return '尚未检查更新'
    case 'checking': return '正在检查更新'
    case 'available': return `发现新版本 ${status.version ?? ''}`.trim()
    case 'not-available': return '已是最新版本'
    case 'downloading': return '正在下载更新'
    case 'downloaded': return '更新已下载'
    case 'installing': return '正在重启安装'
    case 'unsupported': return '当前环境不支持在线更新'
    case 'error': return '更新检查失败'
  }
}

const updateStatusColor = (status: UpdateStatus | null): string => {
  if (!status) return 'default'
  if (status.phase === 'available' || status.phase === 'downloaded') return 'success'
  if (status.phase === 'error') return 'error'
  if (status.phase === 'checking' || status.phase === 'downloading' || status.phase === 'installing') {
    return 'processing'
  }
  return 'default'
}

const modelCapabilityCheckDefinitions: ReadonlyArray<{
  key: keyof ModelCapabilityReport['checks']
  label: string
  description: string
}> = [
  { key: 'connection', label: '连接', description: '服务地址与模型是否可达' },
  { key: 'minimalChat', label: '最小问答', description: '低 Token 文本问答探针' },
  { key: 'structuredOutput', label: 'JSON Schema', description: '结构化输出探针' },
  { key: 'toolCalling', label: '工具调用', description: 'Agent 工具调用协议探针' },
  { key: 'contextWindow', label: '上下文长度', description: '可用上下文能力' },
  { key: 'thinking', label: '思考模式', description: '模型思考参数能力' }
]

const modelCapabilityStatusLabels: Record<ModelCapabilityStatus, string> = {
  supported: '支持',
  limited: '有限支持',
  unsupported: '不支持',
  unknown: '未验证',
  error: '检测失败'
}

const modelCapabilityEvidenceLabels: Record<ModelCapabilityEvidence, string> = {
  metadata: '服务元数据',
  'active-probe': '主动探针',
  'provider-contract': '服务商能力声明'
}

const modelCapabilitySourceLabelOf = (source: ModelSource): string => (
  source === 'local' ? '本地' : '在线'
)

const modelCapabilityProviderLabelOf = (provider: ModelProvider): string => (
  provider === 'ollama'
    ? 'Ollama'
    : onlineModelProviders.find((item) => item.value === provider)?.label ?? provider
)

const modelCapabilityReportMatches = (
  report: ModelCapabilityReport | undefined,
  model: Pick<ModelSettings, 'source' | 'provider' | 'model'> | undefined
): report is ModelCapabilityReport => Boolean(
  report && model &&
  report.source === model.source &&
  report.provider === model.provider &&
  report.model.trim() === model.model.trim()
)

const modelCapabilityValueLabelOf = (item: ModelCapabilityItem): string | undefined => {
  if (item.value === undefined || item.value === '') return undefined
  if (typeof item.value === 'boolean') return item.value ? '是' : '否'
  return String(item.value)
}

const formatCapabilityCheckedAt = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN')
}

const testModelWithCapabilities = (
  input: ModelSettings,
  probeChat: boolean,
  probeCapabilities: boolean
): Promise<ConnectionResult> => window.visslm.testModel(input, probeChat, probeCapabilities)

function ModelCapabilityMatrix({
  report
}: {
  report: ModelCapabilityReport | null
}): React.JSX.Element {
  if (!report) {
    return (
      <section className="model-capability-panel" aria-labelledby="model-capability-title">
        <div className="model-capability-heading">
          <div>
            <Title id="model-capability-title" level={5}>模型能力矩阵</Title>
            <Text type="secondary">启动诊断或手动测试后显示结构化能力结果。</Text>
          </div>
        </div>
        <div className="model-capability-empty" role="status" aria-live="polite">
          尚无与当前来源、服务商和模型匹配的诊断报告。
        </div>
      </section>
    )
  }

  return (
    <section className="model-capability-panel" aria-labelledby="model-capability-title">
      <div className="model-capability-heading">
        <div>
          <Title id="model-capability-title" level={5}>模型能力矩阵</Title>
          <Text type="secondary">
            {modelCapabilitySourceLabelOf(report.source)} · {modelCapabilityProviderLabelOf(report.provider)} · {report.model}
          </Text>
        </div>
        <div className="model-capability-report-meta">
          <span>{report.probeMode === 'active' ? '完整能力测试' : '连接诊断'}</span>
          <span>检查于 {formatCapabilityCheckedAt(report.checkedAt)}</span>
        </div>
      </div>
      <div className="model-capability-grid">
        {modelCapabilityCheckDefinitions.map(({ key, label, description }) => {
          const item = report.checks[key]
          const valueLabel = modelCapabilityValueLabelOf(item)
          return (
            <article className={`model-capability-item status-${item.status}`} key={key}>
              <div className="model-capability-item-heading">
                <strong>{label}</strong>
                <span
                  className="model-capability-status"
                  aria-label={`${label}：${modelCapabilityStatusLabels[item.status]}`}
                >
                  {modelCapabilityStatusLabels[item.status]}
                </span>
              </div>
              <span className="model-capability-description">{description}</span>
              <p>{item.summary || '暂无检测说明'}</p>
              <div className="model-capability-evidence">
                <span>依据：{modelCapabilityEvidenceLabels[item.evidence]}</span>
                {valueLabel && <span>检测值：{valueLabel}</span>}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

type UpdateReleaseNoteBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }

const compactUpdateNoteText = (value: string): string => value.replace(/\s+/g, ' ').trim()

const parsePlainUpdateNotes = (value: string): UpdateReleaseNoteBlock[] => {
  const blocks: UpdateReleaseNoteBlock[] = []
  let paragraphLines: string[] = []
  let list: Extract<UpdateReleaseNoteBlock, { type: 'list' }> | null = null

  const flushParagraph = (): void => {
    const text = compactUpdateNoteText(paragraphLines.join(' '))
    if (text) blocks.push({ type: 'paragraph', text })
    paragraphLines = []
  }

  const flushList = (): void => {
    if (list?.items.length) blocks.push(list)
    list = null
  }

  value.replace(/\r\n?/g, '\n').split('\n').forEach((rawLine) => {
    const line = rawLine.trim()
    if (!line) {
      flushParagraph()
      flushList()
      return
    }

    const unorderedItem = line.match(/^[-*•]\s+(.+)$/)
    const orderedItem = line.match(/^\d+[.)]\s+(.+)$/)
    if (unorderedItem || orderedItem) {
      flushParagraph()
      const ordered = Boolean(orderedItem)
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { type: 'list', ordered, items: [] }
      }
      list.items.push(compactUpdateNoteText((unorderedItem ?? orderedItem)?.[1] ?? ''))
      return
    }

    flushList()
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: compactUpdateNoteText(heading[2])
      })
      return
    }
    paragraphLines.push(line)
  })

  flushParagraph()
  flushList()
  return blocks
}

const hasStructuredUpdateNoteMarkup = (value: string): boolean =>
  /<\s*\/?\s*(?:h[1-6]|ul|ol|li|p|div|br|blockquote|section|article|strong|em)\b/i.test(value) ||
  /&lt;\s*\/?\s*(?:h[1-6]|ul|ol|li|p|div|br|blockquote|section|article|strong|em)\b/i.test(value)

const parseHtmlUpdateNotes = (value: string): UpdateReleaseNoteBlock[] => {
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
    return parsePlainUpdateNotes(value.replace(/<[^>]*>/g, ''))
  }

  const decoder = document.createElement('textarea')
  decoder.innerHTML = value
  const decoded = decoder.value
  const documentFragment = new DOMParser().parseFromString(decoded, 'text/html')
  const blocks: UpdateReleaseNoteBlock[] = []

  Array.from(documentFragment.body.children).forEach((element) => {
    const tagName = element.tagName.toLowerCase()
    if (tagName === 'script' || tagName === 'style') return

    if (/^h[1-6]$/.test(tagName)) {
      const text = compactUpdateNoteText(element.textContent ?? '')
      if (text) blocks.push({ type: 'heading', level: Number(tagName.slice(1)), text })
      return
    }

    if (tagName === 'ul' || tagName === 'ol') {
      const items = Array.from(element.children)
        .filter((child) => child.tagName.toLowerCase() === 'li')
        .map((item) => compactUpdateNoteText(item.textContent ?? ''))
        .filter(Boolean)
      if (items.length) blocks.push({ type: 'list', ordered: tagName === 'ol', items })
      return
    }

    const text = compactUpdateNoteText(element.textContent ?? '')
    if (text) blocks.push({ type: 'paragraph', text })
  })

  if (blocks.length) return blocks
  return parsePlainUpdateNotes(documentFragment.body.textContent ?? decoded)
}

const parseUpdateReleaseNotes = (value: string): UpdateReleaseNoteBlock[] =>
  hasStructuredUpdateNoteMarkup(value) ? parseHtmlUpdateNotes(value) : parsePlainUpdateNotes(value)

function UpdateReleaseNotes({ notes }: { notes: string }): React.JSX.Element {
  const blocks = parseUpdateReleaseNotes(notes)

  return (
    <div className="settings-update-notes-content">
      {blocks.length === 0 ? (
        <p>暂无可显示的发行说明</p>
      ) : blocks.map((block, index) => {
        if (block.type === 'heading') {
          return React.createElement(
            `h${Math.min(6, Math.max(1, block.level))}`,
            { key: `heading-${index}`, className: 'settings-update-note-heading' },
            block.text
          )
        }

        if (block.type === 'list') {
          return React.createElement(
            block.ordered ? 'ol' : 'ul',
            { key: `list-${index}`, className: 'settings-update-note-list' },
            block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)
          )
        }

        return <p key={`paragraph-${index}`}>{block.text}</p>
      })}
    </div>
  )
}

function SettingsPage({
  settings,
  onChanged,
  modelCapabilityReport,
  initialTab = 'platform'
}: {
  settings: AppSettings | null
  onChanged: (settings: AppSettings) => void
  modelCapabilityReport: ModelCapabilityReport | null
  initialTab?: SystemSettingsTabKey
}): React.JSX.Element {
  const { message } = AntApp.useApp()
  const [platformForm] = Form.useForm<PlatformSettingsInput>()
  const [systemForm] = Form.useForm<SystemSettingsInput>()
  const [modelForm] = Form.useForm<ModelSettings>()
  const [settingsTab, setSettingsTab] = useState<SystemSettingsTabKey>(initialTab)
  const [platformTesting, setPlatformTesting] = useState(false)
  const [modelConnectionTesting, setModelConnectionTesting] = useState(false)
  const [modelCapabilityTesting, setModelCapabilityTesting] = useState(false)
  const modelTestInFlightRef = useRef(false)
  const [displayedModelCapabilityReport, setDisplayedModelCapabilityReport] = useState<ModelCapabilityReport | null>(modelCapabilityReport)
  const [matchingForm] = Form.useForm<ProjectMatchingSettings>()
  const [modelSource, setModelSource] = useState<ModelSource>('local')
  const [modelProvider, setModelProvider] = useState<ModelProvider>('ollama')
  const [onlineModelUnlocked, setOnlineModelUnlocked] = useState(false)
  const onlineModelUnlockedRef = useRef(false)
  const localModelClickCountRef = useRef(0)
  const modelDraftsRef = useRef<Partial<Record<ModelSource, ModelSettings>>>({})
  const [featureSettings, setFeatureSettings] = useState<FeatureModuleSettings>(
    DEFAULT_FEATURE_MODULE_SETTINGS
  )
  const [featureSaving, setFeatureSaving] = useState<FeatureModuleKey | null>(null)
  const [navigationOrder, setNavigationOrder] = useState<FeatureNavigationOrder>(
    DEFAULT_FEATURE_NAVIGATION_ORDER
  )
  const [navigationSaving, setNavigationSaving] = useState(false)
  const [draggingFeature, setDraggingFeature] = useState<FeatureModuleKey | null>(null)
  const [dragOverFeature, setDragOverFeature] = useState<FeatureDropTarget | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [updateAction, setUpdateAction] = useState<'check' | 'download' | 'install' | null>(null)
  const watchedModelName = Form.useWatch('model', modelForm)
  const selectedProvider = onlineModelProviders.find((item) => item.value === modelProvider)
  const savedModelProfile = settings?.modelProfiles?.[modelSource]
    ?? (settings?.model.source === modelSource ? settings.model : undefined)
  const hasSavedModelApiKey = Boolean(
    savedModelProfile?.provider === modelProvider && savedModelProfile.hasApiKey
  )
  const modelThinkingHint = modelSource === 'local'
    ? 'Ollama 使用原生 think 参数；开启后会增加响应时间。'
    : modelProvider === 'qwen'
      ? '通义千问通过 enable_thinking 传递；具体模型仍需支持混合思考模式。'
      : modelProvider === 'deepseek' || modelProvider === 'zhipu'
        ? '当前服务商通过 thinking.type 传递；具体模型不支持时可能忽略或返回接口错误。'
        : modelProvider === 'openai'
          ? '仅对支持 reasoning_effort 的 OpenAI 推理模型生效，普通模型不会额外启用思考。'
          : modelProvider === 'anthropic'
            ? '按 Anthropic 模型能力发送 thinking 配置；请使用支持思考模式的模型。'
            : modelProvider === 'minimax'
              ? 'MiniMax M 系列为模型内置思考模型，当前兼容接口不提供通用的关闭参数。'
              : modelProvider === 'rawchat-codex'
                ? 'RawChat Codex 使用 Responses API；思考强度会映射到 reasoning.effort，建议选择支持 Codex 的模型。'
                : modelProvider === 'openai-compatible'
                  ? '通用兼容接口不发送厂商专有思考参数；深度分析由 Agent 提示和结构化解释校验保证。'
                  : '当前服务商没有通用思考参数；深度分析能力取决于所选模型。'
  const currentModelIdentity = settings
    ? {
        source: modelSource,
        provider: modelProvider,
        model: (watchedModelName ?? settings.model.model).trim()
      }
    : undefined
  const visibleModelCapabilityReport = modelCapabilityReportMatches(
    displayedModelCapabilityReport ?? undefined,
    currentModelIdentity
  )
    ? displayedModelCapabilityReport
    : null

  useEffect(() => {
    if (!settings) return
    if (settingsTab === 'platform') {
      platformForm.setFieldsValue({
        baseUrl: settings.platform.baseUrl,
        username: settings.platform.username,
        token: '',
        uploadPassword: ''
      })
    }
    if (settingsTab === 'model') {
      modelDraftsRef.current = {}
      const nextModelSource: ModelSource = !onlineModelUnlockedRef.current && settings.model.source === 'online'
        ? 'local'
        : settings.model.source
      const savedModelProfile = settings.modelProfiles?.[nextModelSource]
        ?? (settings.model.source === nextModelSource ? settings.model : undefined)
      const fallbackModelProfile: ModelSettings = {
        source: 'local',
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3:8b',
        thinking: false
      }
      modelForm.setFieldsValue({
        ...(savedModelProfile ?? fallbackModelProfile),
        apiKey: ''
      })
      setModelSource(nextModelSource)
      setModelProvider(savedModelProfile?.provider ?? fallbackModelProfile.provider)
    } else {
      setModelSource(!onlineModelUnlockedRef.current && settings.model.source === 'online' ? 'local' : settings.model.source)
      setModelProvider(settings.model.provider)
    }
    if (settingsTab === 'general') {
      systemForm.setFieldsValue(settings.system)
      matchingForm.setFieldsValue(settings.projectMatching)
    }
    setFeatureSettings({ ...DEFAULT_FEATURE_MODULE_SETTINGS, ...settings.features })
    setNavigationOrder(normalizeFeatureNavigationOrder(settings.navigationOrder))
  }, [settings, settingsTab, platformForm, systemForm, modelForm, matchingForm])

  useEffect(() => {
    setDisplayedModelCapabilityReport(modelCapabilityReport)
  }, [modelCapabilityReport])

  useEffect(() => {
    let mounted = true
    void window.visslm.getUpdateStatus().then((status) => {
      if (mounted) setUpdateStatus(status)
    })
    const unsubscribe = window.visslm.onUpdateStatus((status) => {
      if (mounted) setUpdateStatus(status)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const orderedFeatureDefinitions = useMemo(() => {
    const order = normalizeFeatureNavigationOrder(navigationOrder)
    return [...featureDefinitions].sort(
      (left, right) => order.indexOf(left.key) - order.indexOf(right.key)
    )
  }, [navigationOrder])

  const testPlatform = async (): Promise<void> => {
    const values = await platformForm.validateFields()
    setPlatformTesting(true)
    try {
      const result = await window.visslm.testPlatform(values)
      result.ok ? message.success(result.message) : message.error(result.message)
    } finally {
      setPlatformTesting(false)
    }
  }

  const savePlatform = async (values: PlatformSettingsInput): Promise<void> => {
    const next = await window.visslm.savePlatformSettings(values)
    onChanged(next)
    platformForm.setFieldsValue({ token: '', uploadPassword: '' })
    message.success('平台配置已安全保存')
  }

  const saveSystem = async (values: SystemSettingsInput): Promise<void> => {
    const next = await window.visslm.saveSystemSettings(values)
    onChanged(next)
    systemForm.setFieldsValue(next.system)
    message.success('系统配置已保存')
  }

  const checkForUpdates = async (): Promise<void> => {
    setUpdateAction('check')
    try {
      const next = await window.visslm.checkForUpdates()
      setUpdateStatus(next)
      if (next.phase === 'not-available') message.success('当前已是最新版本')
      if (next.phase === 'error') message.error(`检查更新失败：${next.message ?? '未知错误'}`)
    } finally {
      setUpdateAction(null)
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    setUpdateAction('download')
    try {
      const next = await window.visslm.downloadUpdate()
      setUpdateStatus(next)
      if (next.phase === 'error') message.error(`下载更新失败：${next.message ?? '未知错误'}`)
    } finally {
      setUpdateAction(null)
    }
  }

  const installUpdate = async (): Promise<void> => {
    setUpdateAction('install')
    try {
      await window.visslm.installUpdate()
    } finally {
      setUpdateAction(null)
    }
  }

  const testModel = async (probeChat: boolean): Promise<void> => {
    if (modelTestInFlightRef.current) return
    const values = await modelForm.validateFields()
    const input: ModelSettings = {
      ...values,
      source: modelSource,
      provider: modelProvider
    }
    const setTesting = probeChat ? setModelCapabilityTesting : setModelConnectionTesting
    modelTestInFlightRef.current = true
    setTesting(true)
    try {
      const result = await testModelWithCapabilities(input, probeChat, true)
      const report = result.capabilityReport
      setDisplayedModelCapabilityReport(
        modelCapabilityReportMatches(report, input) ? report : null
      )
      if (result.ok) {
        message.success(probeChat ? '完整能力测试已完成，请查看能力矩阵' : result.message)
      } else {
        message.error(result.message)
      }
    } catch (error) {
      message.error(`模型测试失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      modelTestInFlightRef.current = false
      setTesting(false)
    }
  }

  const saveModel = async (values: ModelSettings): Promise<void> => {
    const next = await window.visslm.saveModelSettings({
      ...values,
      source: modelSource,
      provider: modelProvider,
      apiKey: modelSource === 'online' ? values.apiKey : undefined
    })
    onChanged(next)
    modelForm.setFieldValue('apiKey', '')
    message.success('模型配置已保存')
  }

  const saveProjectMatching = async (values: ProjectMatchingSettings): Promise<void> => {
    const next = await window.visslm.saveProjectMatchingSettings(values)
    onChanged(next)
    matchingForm.setFieldsValue(next.projectMatching)
    message.success('项目匹配配置已保存')
  }

  const saveFeature = async (key: FeatureModuleKey, enabled: boolean): Promise<void> => {
    const previousFeatures = featureSettings
    const nextFeatures: FeatureModuleSettings = { ...previousFeatures, [key]: enabled }
    setFeatureSettings(nextFeatures)
    setFeatureSaving(key)
    try {
      const next = await window.visslm.saveFeatureSettings(nextFeatures)
      setFeatureSettings(next.features)
      onChanged(next)
      const definition = featureDefinitions.find((item) => item.key === key)
      message.success([definition?.label ?? '功能模块', enabled ? '开启' : '关闭'].join('已'))
    } catch (error) {
      setFeatureSettings(previousFeatures)
      message.error(error instanceof Error ? error.message : '功能开关保存失败，请稍后重试')
    } finally {
      setFeatureSaving(null)
    }
  }

  const saveNavigationOrder = async (nextOrder: FeatureNavigationOrder): Promise<void> => {
    if (navigationSaving) return
    const previousOrder = navigationOrder
    const normalizedOrder = normalizeFeatureNavigationOrder(nextOrder)
    setNavigationOrder(normalizedOrder)
    setNavigationSaving(true)
    try {
      const next = await window.visslm.saveNavigationOrder(normalizedOrder)
      setNavigationOrder(normalizeFeatureNavigationOrder(next.navigationOrder))
      onChanged(next)
      message.success('导航顺序已保存')
    } catch (error) {
      setNavigationOrder(previousOrder)
      message.error(error instanceof Error ? error.message : '导航顺序保存失败，请稍后重试')
    } finally {
      setNavigationSaving(false)
    }
  }

  const handleFeatureDragStart = (
    event: React.DragEvent<HTMLButtonElement>,
    key: FeatureModuleKey
  ): void => {
    if (navigationSaving) {
      event.preventDefault()
      return
    }
    setDraggingFeature(key)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', key)
  }

  const handleFeatureDragOver = (
    event: React.DragEvent<HTMLDivElement>,
    key: FeatureModuleKey
  ): void => {
    if (!draggingFeature || navigationSaving || draggingFeature === key) {
      if (draggingFeature === key) setDragOverFeature(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position: FeatureDropPosition = event.clientY < rect.top + rect.height / 2
      ? 'before'
      : 'after'
    setDragOverFeature((current) => (
      current?.key === key && current.position === position
        ? current
        : { key, position }
    ))
  }

  const handleFeatureDrop = (
    event: React.DragEvent<HTMLDivElement>,
    targetKey: FeatureModuleKey
  ): void => {
    event.preventDefault()
    const rawSourceKey = draggingFeature ?? event.dataTransfer.getData('text/plain')
    const targetRect = event.currentTarget.getBoundingClientRect()
    const position: FeatureDropPosition = dragOverFeature?.key === targetKey
      ? dragOverFeature.position
      : event.clientY < targetRect.top + targetRect.height / 2
        ? 'before'
        : 'after'
    setDraggingFeature(null)
    setDragOverFeature(null)
    if (
      navigationSaving ||
      !DEFAULT_FEATURE_NAVIGATION_ORDER.includes(rawSourceKey as FeatureModuleKey)
    ) {
      return
    }

    const sourceKey = rawSourceKey as FeatureModuleKey
    const currentOrder = normalizeFeatureNavigationOrder(navigationOrder)
    const sourceIndex = currentOrder.indexOf(sourceKey)
    if (sourceIndex < 0 || sourceKey === targetKey) return

    const nextOrder = currentOrder.filter((key) => key !== sourceKey)
    const targetIndex = nextOrder.indexOf(targetKey)
    if (targetIndex < 0) return
    nextOrder.splice(targetIndex + (position === 'after' ? 1 : 0), 0, sourceKey)
    void saveNavigationOrder(nextOrder)
  }

  const updateAvailable = updateStatus?.phase === 'available'
  const updateDownloading = updateStatus?.phase === 'downloading'
  const updateDownloaded = updateStatus?.phase === 'downloaded'
  const updateUnsupported = updateStatus?.phase === 'unsupported'
  const updateBusy = updateAction !== null || updateStatus?.phase === 'checking' || updateDownloading

  const changeModelSource = (source: string | number): void => {
    if (source !== 'local' && source !== 'online') return
    if (source === 'online' && !onlineModelUnlockedRef.current) return
    setDisplayedModelCapabilityReport(null)
    const currentValues = modelForm.getFieldsValue(true) as ModelSettings
    modelDraftsRef.current[modelSource] = {
      ...currentValues,
      source: modelSource,
      provider: modelProvider,
      apiKey: modelSource === 'online' ? currentValues.apiKey : undefined
    }
    const savedProfile = settings?.modelProfiles?.[source]
      ?? (settings?.model.source === source ? settings.model : undefined)
    const draft = modelDraftsRef.current[source]
    const fallbackProvider = source === 'local'
      ? 'ollama' as const
      : onlineModelProviders[0]?.value ?? 'openai'
    const fallbackPreset = source === 'online'
      ? onlineModelProviders.find((item) => item.value === fallbackProvider) ?? onlineModelProviders[0]
      : undefined
    const target = draft ?? savedProfile ?? {
      source,
      provider: fallbackProvider,
      baseUrl: source === 'local' ? 'http://127.0.0.1:11434' : fallbackPreset?.baseUrl ?? '',
      model: source === 'local' ? 'qwen3:8b' : fallbackPreset?.models[0] ?? '',
      thinking: Boolean(modelForm.getFieldValue('thinking'))
    }
    setModelSource(source)
    setModelProvider(target.provider)
    modelForm.setFieldsValue({
      source,
      provider: target.provider,
      baseUrl: target.baseUrl,
      model: target.model,
      thinking: target.thinking,
      apiKey: source === 'online' ? (target as ModelSettings).apiKey ?? '' : undefined
    })
  }

  const handleModelSourceClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    // Activating a label also dispatches a synthetic click from its radio input.
    // Count only the originating label click so one user click cannot count twice.
    if (target.closest('input')) return
    const clickedSource = target
      .closest('label')
      ?.querySelector<HTMLElement>('[data-model-source]')
      ?.dataset.modelSource
    if (clickedSource !== 'local') {
      localModelClickCountRef.current = 0
      return
    }
    if (onlineModelUnlockedRef.current) return
    const nextClickCount = localModelClickCountRef.current + 1
    if (nextClickCount >= 5) {
      onlineModelUnlockedRef.current = true
      localModelClickCountRef.current = 0
      setOnlineModelUnlocked(true)
      return
    }
    localModelClickCountRef.current = nextClickCount
  }

  const changeOnlineProvider = (provider: ModelProvider): void => {
    const preset = onlineModelProviders.find((item) => item.value === provider)
    if (!preset) return
    setDisplayedModelCapabilityReport(null)
    const thinking = Boolean(modelForm.getFieldValue('thinking'))
    setModelProvider(provider)
    modelForm.setFieldsValue({
      provider,
      baseUrl: preset.baseUrl,
      model: preset.models[0] ?? '',
      thinking
    })
  }

  return (
    <div className="settings-width">
      <Card className="settings-card">
        <Tabs
          className="settings-tabs"
          activeKey={settingsTab}
          onChange={(key) => {
            if (isSystemSettingsTabKey(key)) setSettingsTab(key)
          }}
          items={[
            {
              key: 'platform',
              label: '平台配置',
              children: (
                <div className="settings-panel">
                  <SettingsPanelHeading
                    title="VISSLM 平台"
                    description="配置业务平台的数据采集与推送连接"
                  />
                  <Form form={platformForm} layout="vertical" onFinish={(values) => void savePlatform(values)}>
                    <Form.Item label="平台地址" name="baseUrl" rules={[{ required: true, message: '请输入平台地址' }]}>
                      <Input placeholder="http://server/alm" />
                    </Form.Item>
                    <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      label="平台登录密码（用于字段定义读取、显示名查询和富文本图片上传）"
                      name="uploadPassword"
                      extra={settings?.platform.hasUploadPassword
                        ? '已使用操作系统安全存储加密；留空继续使用原密码。采集读取数据类型字段定义、解析用户显示名时，以及推送含图片的富文本时，都需要此密码。'
                        : '密码将使用操作系统安全存储加密；采集读取数据类型字段定义、解析用户显示名时，以及推送含图片的富文本时，都需要此密码。'}
                    >
                      <Input.Password
                        autoComplete="new-password"
                        placeholder={settings?.platform.hasUploadPassword
                          ? '••••••••'
                          : '输入 VISSLM 网页登录密码'}
                      />
                    </Form.Item>
                    <Form.Item
                      label="API Token"
                      name="token"
                      extra={settings?.platform.hasToken ? '已安全保存；留空将继续使用原 Token' : 'Token 将使用操作系统安全存储加密'}
                      rules={[{
                        validator: async (_, value) => {
                          if (!value && !settings?.platform.hasToken) throw new Error('请输入 API Token')
                        }
                      }]}
                    >
                      <Input.Password autoComplete="new-password" placeholder={settings?.platform.hasToken ? '••••••••' : '输入平台 Token'} />
                    </Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit">保存平台配置</Button>
                      <Button loading={platformTesting} onClick={() => void testPlatform()}>测试连接</Button>
                    </Space>
                  </Form>
                </div>
              )
            },
            {
              key: 'model',
              label: '大模型配置',
              children: (
                <div className="settings-panel">
                  <SettingsPanelHeading
                    title="大模型连接"
                    description="选择 Agent 使用的本地或在线模型服务"
                    className="model-settings-heading"
                    extra={(
                      <Segmented
                        value={modelSource}
                        options={[
                          { label: <span data-model-source="local">本地大模型</span>, value: 'local' },
                          ...(onlineModelUnlocked
                            ? [{ label: <span data-model-source="online">在线大模型</span>, value: 'online' as const }]
                            : [])
                        ]}
                        onClick={handleModelSourceClick}
                        onChange={changeModelSource}
                      />
                    )}
                  />
                  <Form
                    form={modelForm}
                    layout="vertical"
                    onValuesChange={() => setDisplayedModelCapabilityReport(null)}
                    onFinish={(values) => void saveModel(values)}
                  >
                    <Form.Item name="source" hidden><Input /></Form.Item>
                    <Form.Item name="provider" hidden={modelSource === 'local'} label="模型服务商">
                      <Select
                        options={onlineModelProviders.map((provider) => ({ label: provider.label, value: provider.value }))}
                        onChange={(value) => changeOnlineProvider(value as ModelProvider)}
                      />
                    </Form.Item>
                    <Form.Item
                      label={modelSource === 'local' ? 'Ollama 地址' : 'API 地址'}
                      name="baseUrl"
                      extra={modelProvider === 'rawchat-codex'
                        ? '填写 RawChat Codex 基础地址（例如 https://rawchat.cn/codex），客户端会使用 Responses API。'
                        : modelProvider === 'openai-compatible'
                          ? '填写兼容 OpenAI Chat Completions API 的基础地址，通常以 /v1 结尾'
                          : undefined}
                      rules={[{ required: true, message: '请输入服务地址' }]}
                    >
                      <Input placeholder={modelSource === 'local' ? 'http://127.0.0.1:11434' : selectedProvider?.baseUrl || 'https://example.com/v1'} />
                    </Form.Item>
                    {modelSource === 'online' && (
                      <Form.Item
                        label="API Key"
                        name="apiKey"
                        extra={hasSavedModelApiKey ? '已安全保存；留空将继续使用原 API Key' : 'API Key 将使用操作系统安全存储加密'}
                        rules={[{
                          validator: async (_, value) => {
                            if (!value && !hasSavedModelApiKey) throw new Error('请输入 API Key')
                          }
                        }]}
                      >
                        <Input.Password autoComplete="new-password" placeholder={hasSavedModelApiKey ? '••••••••' : '输入 API Key'} />
                      </Form.Item>
                    )}
                    <Form.Item label="模型名称" name="model" rules={[{ required: true, message: '请输入模型名称' }]}>
                      <Input list="model-name-options" placeholder={modelSource === 'local' ? 'qwen3:8b' : selectedProvider?.models[0] || '输入模型 ID'} />
                    </Form.Item>
                    <datalist id="model-name-options">
                      {(selectedProvider?.models ?? []).map((model) => <option key={model} value={model} />)}
                    </datalist>
                    <Form.Item label="思考模式" name="thinking" valuePropName="checked" extra={modelThinkingHint}>
                      <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                    </Form.Item>
                    <Alert
                      type="info"
                      showIcon
                      title={modelSource === 'local' ? 'Agent 工具调用建议关闭思考模式' : '在线模型思考模式'}
                      description={modelSource === 'local'
                        ? '开启后会增加响应时间，并可能在较小输出预算下无法及时生成工具调用。'
                        : '开关会随模型配置保存，并应用到在线模型请求；思考模式通常会增加响应时间和 Token 消耗。'}
                      className="model-settings-alert"
                    />
                    <Space wrap className="model-test-actions">
                      <Button type="primary" htmlType="submit">保存模型配置</Button>
                      <Button
                        loading={modelConnectionTesting}
                        disabled={modelCapabilityTesting}
                        aria-label="测试模型连接与元数据"
                        onClick={() => void testModel(false)}
                      >
                        测试连接
                      </Button>
                      <Button
                        loading={modelCapabilityTesting}
                        disabled={modelConnectionTesting}
                        aria-label="执行完整模型能力测试"
                        title="会发送不含业务数据的低 Token 探测请求"
                        onClick={() => void testModel(true)}
                      >
                        完整能力测试
                      </Button>
                    </Space>
                    <Text type="secondary" className="model-test-hint">
                      测试连接只读取服务和模型元数据；完整能力测试会额外发送不含业务数据的低 Token 请求，验证最小问答、JSON Schema 与工具调用。
                    </Text>
                  </Form>
                  <ModelCapabilityMatrix report={visibleModelCapabilityReport} />
                </div>
              )
            },
            {
              key: 'general',
              label: '通用配置',
              children: (
                <div className="settings-panel settings-general-panel">
                  <SettingsPanelHeading
                    title="系统参数"
                    description="配置跨平台复用的用户属性字段和项目需求匹配参数，供数据查询与项目匹配使用。"
                  />
                  <Form
                    className="settings-form settings-general-form"
                    form={systemForm}
                    layout="vertical"
                    onFinish={(values) => void saveSystem(values)}
                  >
                    <Form.Item
                      label="用户属性 Key"
                      name="userPropertyKeys"
                      extra="仅对这些字段的非空值查询用户显示名；相同登录名只查询一次。"
                    >
                      <Select
                        mode="tags"
                        allowClear
                        tokenSeparators={[',', '，', ';', '；', '\n']}
                        maxTagCount="responsive"
                        placeholder="例如：_valm_AssignedTo"
                      />
                    </Form.Item>
                    <div className="settings-form-actions">
                      <Button type="primary" htmlType="submit">保存系统配置</Button>
                    </div>
                  </Form>
                  <section
                    className="settings-general-section settings-matching-section"
                    aria-labelledby="project-matching-settings-title"
                  >
                    <SettingsPanelHeading
                      title="项目需求匹配"
                      titleId="project-matching-settings-title"
                      description="控制“查看匹配”列表展示的数据最低匹配度，低于或等于阈值的数据不会显示。"
                    />
                    <Form
                      className="settings-form settings-matching-form"
                      form={matchingForm}
                      layout="vertical"
                      onFinish={(values) => void saveProjectMatching(values)}
                    >
                      <Form.Item
                        className="settings-matching-score-field"
                        name="minScore"
                        label="最低匹配度"
                        extra="默认 40%；系统只展示匹配度严格高于该值的数据。"
                        rules={[{ required: true, message: '请输入最低匹配度' }]}
                      >
                        <InputNumber min={0} max={100} precision={0} step={1} suffix="%" />
                      </Form.Item>
                      <div className="settings-form-actions">
                        <Button type="primary" htmlType="submit">保存项目匹配配置</Button>
                      </div>
                    </Form>
                  </section>
                  <section
                    className="settings-general-section settings-update-section"
                    aria-labelledby="online-update-title"
                  >
                    <SettingsPanelHeading
                      title="在线更新"
                      titleId="online-update-title"
                      description="从 GitHub Release 检查、下载并安装 VISSLM Agent 的新版本。"
                      extra={(
                        <Tag color={updateStatusColor(updateStatus)}>
                          {updateStatusLabel(updateStatus)}
                        </Tag>
                      )}
                    />
                    <div className="settings-update-body">
                      <div className="settings-update-summary" aria-live="polite">
                        <div className="settings-update-version-row">
                          <Text strong>当前版本 {updateStatus?.currentVersion ?? '读取中…'}</Text>
                          {updateStatus?.version && updateStatus.phase !== 'not-available' && (
                            <Text type="secondary">目标版本 {updateStatus.version}</Text>
                          )}
                        </div>
                        {updateAvailable && (
                          <Alert
                            type="info"
                            showIcon
                            title={`发现新版本 ${updateStatus?.version ?? ''}`}
                            description="下载完成后可重启应用安装更新。"
                            className="settings-update-alert"
                          />
                        )}
                        {updateDownloading && (
                          <div
                            className="settings-update-progress"
                            aria-label={`正在下载 ${updateStatus?.version ?? '新版本'} 更新`}
                          >
                            <div className="settings-update-progress-meta">
                              <Text type="secondary">正在下载更新</Text>
                              {formatUpdateBytes(updateStatus?.bytesPerSecond) && (
                                <Text type="secondary">
                                  {formatUpdateBytes(updateStatus?.bytesPerSecond)}/s
                                </Text>
                              )}
                            </div>
                            <Progress
                              percent={Math.round(updateStatus?.percent ?? 0)}
                              showInfo={false}
                              strokeColor="var(--accent)"
                            />
                          </div>
                        )}
                        {updateDownloaded && (
                          <Alert
                            type="success"
                            showIcon
                            title="更新已下载"
                            description="重启应用后将完成安装。"
                            className="settings-update-alert"
                          />
                        )}
                        {updateStatus?.phase === 'not-available' && (
                          <Text type="secondary">最近检查时间：{formatUpdateDate(updateStatus.checkedAt) || '刚刚'}</Text>
                        )}
                        {updateStatus?.phase === 'unsupported' && (
                          <Text type="secondary">{updateStatus.message}</Text>
                        )}
                        {updateStatus?.phase === 'error' && (
                          <Alert
                            type="error"
                            showIcon
                            title="更新操作失败"
                            description={updateStatus.message}
                            className="settings-update-alert"
                          />
                        )}
                        {updateStatus?.releaseNotes && (
                          <div className="settings-update-notes" role="region" aria-label="发行说明">
                            <Text type="secondary">发行说明</Text>
                            <UpdateReleaseNotes notes={updateStatus.releaseNotes} />
                          </div>
                        )}
                      </div>
                      <Space className="settings-update-actions" wrap>
                        <Button
                          icon={<ReloadOutlined />}
                          loading={updateAction === 'check'}
                          disabled={updateBusy || updateUnsupported}
                          onClick={() => void checkForUpdates()}
                        >
                          检查更新
                        </Button>
                        {updateAvailable && (
                          <Button
                            type="primary"
                            icon={<CloudDownloadOutlined />}
                            loading={updateAction === 'download'}
                            disabled={updateBusy}
                            onClick={() => void downloadUpdate()}
                          >
                            下载更新
                          </Button>
                        )}
                        {updateDownloaded && (
                          <Button
                            type="primary"
                            icon={<SyncOutlined />}
                            loading={updateAction === 'install'}
                            disabled={updateBusy}
                            onClick={() => void installUpdate()}
                          >
                            重启并安装
                          </Button>
                        )}
                      </Space>
                    </div>
                  </section>
                </div>
              )
            },
            {
              key: 'features',
              label: '功能模块',
              children: (
                <div className="settings-panel feature-settings-panel">
                  <SettingsPanelHeading
                    title="导航功能"
                    description="按需开放工作台功能，关闭后对应入口不会出现在左侧导航栏。"
                  />
                  <Alert
                    className="feature-settings-notice"
                    type="warning"
                    showIcon
                    title="数据推送默认关闭"
                    description="数据推送会将本地处理后的数据写回业务平台，不会执行数据采集。确认平台连接和推送范围后，再开启该功能。"
                  />
                  <div className="feature-module-sort-hint">
                    拖动每项左侧手柄即可调整导航栏顺序
                  </div>
                  <div className="feature-module-list">
                    {orderedFeatureDefinitions.map((definition) => (
                      <div
                        className={`feature-module-row ${draggingFeature === definition.key ? 'is-dragging' : ''} ${dragOverFeature?.key === definition.key ? `is-drop-target-${dragOverFeature.position}` : ''}`}
                        key={definition.key}
                        onDragOver={(event) => handleFeatureDragOver(event, definition.key)}
                        onDragLeave={() => setDragOverFeature(null)}
                        onDrop={(event) => handleFeatureDrop(event, definition.key)}
                      >
                        <button
                          type="button"
                          className="feature-module-drag-handle"
                          draggable={!navigationSaving}
                          aria-label={`拖动${definition.label}调整导航顺序`}
                          title="拖动调整导航顺序"
                          onDragStart={(event) => handleFeatureDragStart(event, definition.key)}
                          onDragEnd={() => {
                            setDraggingFeature(null)
                            setDragOverFeature(null)
                          }}
                        >
                          <HolderOutlined />
                        </button>
                        <div className="feature-module-icon">{definition.icon}</div>
                        <div className="feature-module-copy">
                          <div className="feature-module-title">
                            <Text strong>{definition.label}</Text>
                            {definition.defaultDisabled && <Tag color="warning">默认关闭</Tag>}
                          </div>
                          <Text type="secondary">{definition.description}</Text>
                        </div>
                        <Switch
                          checked={featureSettings[definition.key]}
                          loading={featureSaving === definition.key}
                          checkedChildren="开启"
                          unCheckedChildren="关闭"
                          onChange={(checked) => void saveFeature(definition.key, checked)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )
            }
          ]}
        />
      </Card>
    </div>
  )
}

function WindowTitleBar({
  themeMode,
  onThemeModeChange
}: {
  themeMode: AppThemeMode
  onThemeModeChange: (next: AppThemeMode) => void
}): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.visslm.isWindowMaximized().then(setMaximized)
    return window.visslm.onWindowMaximized(setMaximized)
  }, [])

  const toggleMaximize = async (): Promise<void> => {
    setMaximized(await window.visslm.toggleMaximizeWindow())
  }

  return (
    <div className="window-titlebar">
      <div className="window-drag-region" onDoubleClick={() => void toggleMaximize()}>
        <Text strong>VISSLM Agent</Text>
      </div>
      <div className="window-controls">
        <Tooltip title={themeMode === 'dark' ? '切换到亮色主题' : '切换到暗色主题'} placement="bottom">
          <button
            type="button"
            className="window-control-button window-theme-toggle"
            aria-label={themeMode === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            aria-pressed={themeMode === 'dark'}
            onClick={() => onThemeModeChange(themeMode === 'dark' ? 'light' : 'dark')}
          >
            {themeMode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
          </button>
        </Tooltip>
        <button
          type="button"
          className="window-control-button"
          aria-label="最小化"
          onClick={() => void window.visslm.minimizeWindow()}
        >
          <MinusOutlined />
        </button>
        <button
          type="button"
          className="window-control-button"
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void toggleMaximize()}
        >
          {maximized ? <FullscreenExitOutlined /> : <BorderOutlined />}
        </button>
        <button
          type="button"
          className="window-control-button close"
          aria-label="关闭"
          onClick={() => void window.visslm.closeWindow()}
        >
          <CloseOutlined />
        </button>
      </div>
    </div>
  )
}

function AssetCenterPage({
  refreshKey,
  onDataChanged,
  onVisualize,
  activeTab,
  onActiveTabChange
}: {
  refreshKey: number
  onDataChanged: () => void
  onVisualize: (scope: DataScope, summary: string) => void
  activeTab: 'data' | 'knowledge'
  onActiveTabChange: (tab: 'data' | 'knowledge') => void
}): React.JSX.Element {
  return (
    <div className="asset-center-page page-stack">
      <Tabs
        className="page-inner-tabs asset-center-tabs"
        activeKey={activeTab}
        onChange={(tab) => onActiveTabChange(tab as 'data' | 'knowledge')}
        items={[
          {
            key: 'data',
            label: <span><DatabaseOutlined />数据中心</span>,
            children: (
              <DataPage
                refreshKey={refreshKey}
                onDataChanged={onDataChanged}
                onVisualize={onVisualize}
              />
            )
          },
          {
            key: 'knowledge',
            label: <span><BulbOutlined />知识库</span>,
            children: <KnowledgeBasePage refreshKey={refreshKey} />
          }
        ]}
      />
    </div>
  )
}

function AppShell({ themeMode, onThemeModeChange }: AppProps): React.JSX.Element {
  const { message } = AntApp.useApp()
  const [page, setPage] = useState<PageKey>('dashboard')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [modelOnline, setModelOnline] = useState<boolean | null>(null)
  const [modelCapabilityReport, setModelCapabilityReport] = useState<ModelCapabilityReport | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatQuestion, setChatQuestion] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatConversationId, setChatConversationId] = useState<string>(() => crypto.randomUUID())
  const [generatedDashboard, setGeneratedDashboard] = useState<DashboardSpec | null>(null)
  const [generatedDashboardVersion, setGeneratedDashboardVersion] = useState<number | undefined>(undefined)
  const [chatDataScope, setChatDataScope] = useState<DataScope | null>(null)
  const [chatDataScopeSummary, setChatDataScopeSummary] = useState('')
  const [settingsInitialTab, setSettingsInitialTab] = useState<SystemSettingsTabKey>('platform')
  const [assetCenterTab, setAssetCenterTab] = useState<'data' | 'knowledge'>('data')

  const updateGeneratedDashboard = useCallback((dashboard: DashboardSpec, version?: number): void => {
    setGeneratedDashboard(dashboard)
    setGeneratedDashboardVersion(version)
  }, [])

  useEffect(() => {
    void window.visslm.getSettings().then(setSettings)
  }, [])

  useEffect(() => {
    if (!settings) return
    let active = true
    setModelOnline(null)
    setModelCapabilityReport(null)
    void window.visslm
      .testModel(settings.model, false, true)
      .then((result) => {
        if (!active) return
        setModelOnline(result.ok)
        setModelCapabilityReport(
          modelCapabilityReportMatches(result.capabilityReport, settings.model)
            ? result.capabilityReport
            : null
        )
      })
      .catch(() => {
        if (!active) return
        setModelOnline(false)
        setModelCapabilityReport(null)
      })
    return () => {
      active = false
    }
  }, [settings])

  const enabledFeatures = settings?.features ?? DEFAULT_FEATURE_MODULE_SETTINGS
  const navigationOrder = settings?.navigationOrder ?? DEFAULT_FEATURE_NAVIGATION_ORDER
  const visibleNavigationItems = useMemo(
    () => {
      const order = normalizeFeatureNavigationOrder(navigationOrder)
      return [...featureNavigationItems]
        .sort((left, right) => order.indexOf(left.feature) - order.indexOf(right.feature))
        .filter((item) => enabledFeatures[item.feature])
    },
    [enabledFeatures, navigationOrder]
  )

  useEffect(() => {
    if (page === 'settings' || enabledFeatures[page]) return
    setPage(visibleNavigationItems[0]?.key ?? 'settings')
  }, [enabledFeatures, page, visibleNavigationItems])

  const startSync = async (config?: SyncScopeConfig): Promise<SyncResult | null> => {
    setSyncing(true)
    publishSyncProgress({ phase: 'start', message: '准备采集', current: 0, total: 0 }, true)
    try {
      const result = await window.visslm.startSync(config)
      if (result.ok) {
        const imageMeta = typeof result.imageCount === 'number'
          ? `，已保存 ${result.imageCount} 个二进制图片资源`
          : ''
        message.success(`${result.message}${imageMeta}`)
        setRefreshKey((key) => key + 1)
      } else {
        message.error(result.message)
      }
      return result
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setSyncing(false)
    }
  }

  const pageMeta: Record<PageKey, { title: string; description: string }> = {
    dashboard: { title: '数据概览', description: '掌握本地数据规模、类型构成与发布状态' },
    visualization: { title: '可视化大屏', description: '编辑可追溯的数据大屏并输出运营视图' },
    projects: { title: '项目管理', description: '管理项目进度、需求匹配与交付风险' },
    data: { title: '资产中心', description: '浏览、筛选和复用已同步的数据资产' },
    semanticization: { title: 'AI 语义化', description: '生成持久化语义卡片并审计 AI 分析过程' },
    chat: { title: 'AI 助手', description: '用自然语言检索、统计和解释本地数据' },
    sync: { title: '数据采集', description: '定义采集范围、预览请求并执行同步' },
    push: { title: '数据推送', description: '配置字段映射并将数据安全推送回平台' },
    settings: { title: '系统配置', description: '配置平台连接、模型服务、通用参数与功能模块' }
  }

  const currentPage = useMemo(() => {
    if (page === 'dashboard') return <DashboardPage refreshKey={refreshKey} themeMode={themeMode} />
    if (page === 'visualization') {
      return (
        <DashboardStudio
          generatedDashboard={generatedDashboard}
          generatedDashboardVersion={generatedDashboardVersion}
          onDashboardChange={updateGeneratedDashboard}
        />
      )
    }
    if (page === 'projects') {
      return <ProjectManagementPage refreshKey={refreshKey} modelSettings={settings?.model ?? null} matchScoreThreshold={settings?.projectMatching.minScore ?? DEFAULT_PROJECT_MATCHING_SETTINGS.minScore} onChanged={() => setRefreshKey((key) => key + 1)} />
    }
    if (page === 'data') {
      return (
        <AssetCenterPage
          refreshKey={refreshKey}
          onDataChanged={() => setRefreshKey((key) => key + 1)}
          activeTab={assetCenterTab}
          onActiveTabChange={setAssetCenterTab}
           onVisualize={(scope, summary) => {
             setChatDataScope(scope)
             setChatDataScopeSummary(summary)
             setChatQuestion(
               '@数据可视化专家 基于当前数据范围生成一个可视化大屏，请先分析可用字段并规划核心指标。'
             )
              if (!enabledFeatures.chat) {
                message.info('请先在系统配置的功能模块中开启 AI 助手')
                setPage('settings')
                return
              }
              setPage('chat')
            }}
        />
      )
    }
    if (page === 'semanticization') {
      return (
        <SemanticizationPage
          refreshKey={refreshKey}
          onDataChanged={() => setRefreshKey((key) => key + 1)}
          onOpenSettings={() => {
            setSettingsInitialTab('model')
            setPage('settings')
          }}
        />
      )
    }
    if (page === 'chat') {
      return (
        <ChatPage
          messages={chatMessages}
          setMessages={setChatMessages}
          question={chatQuestion}
          setQuestion={setChatQuestion}
          loading={chatLoading}
          setLoading={setChatLoading}
          activeArtifact={generatedDashboard}
          activeArtifactVersion={generatedDashboardVersion}
           onDashboardUpdate={updateGeneratedDashboard}
           dataScope={chatDataScope}
           dataScopeSummary={chatDataScopeSummary}
           conversationId={chatConversationId}
           onConversationIdChange={setChatConversationId}
	           modelOnline={modelOnline}
	           onOpenSettings={() => setPage('settings')}
	           onOpenAssetCenter={(tab) => {
	             setAssetCenterTab(tab)
	             setPage('data')
	           }}
	           refreshKey={refreshKey}
	           onClearDataScope={() => {
	             setChatDataScope(null)
	             setChatDataScopeSummary('')
	           }}
	          onRestoreDataScope={(scope, summary) => {
	            setChatDataScope(scope)
	            setChatDataScopeSummary(summary)
	          }}
          onOpenDashboard={(dashboard, version) => {
            updateGeneratedDashboard(dashboard, version)
            setPage('visualization')
          }}
        />
      )
    }
    if (page === 'sync') {
      return (
        <SyncPage
          syncing={syncing}
          onSync={startSync}
          onDataChanged={() => setRefreshKey((key) => key + 1)}
        />
      )
    }
    if (page === 'push') {
      return (
        <PushPage
          refreshKey={refreshKey}
          onPushed={() => setRefreshKey((key) => key + 1)}
        />
      )
    }
    return (
      <SettingsPage
        key={settingsInitialTab}
        settings={settings}
        onChanged={setSettings}
        modelCapabilityReport={modelCapabilityReport}
        initialTab={settingsInitialTab}
      />
    )
  }, [
    chatLoading,
    chatMessages,
    chatQuestion,
    chatConversationId,
    chatDataScope,
    chatDataScopeSummary,
    assetCenterTab,
    generatedDashboard,
    generatedDashboardVersion,
    modelOnline,
    modelCapabilityReport,
    page,
    refreshKey,
    settings,
    settingsInitialTab,
    syncing,
    themeMode,
    updateGeneratedDashboard
  ])

  return (
    <div className="app-frame">
      <WindowTitleBar themeMode={themeMode} onThemeModeChange={onThemeModeChange} />
      <Layout className="app-layout">
        <Sider width={224} className="app-sider" theme="light">
          <div className="brand">
            <div className="brand-mark">
              <ThemedAppIcon alt="VISSLM Agent" />
            </div>
            <div>
              <div className="brand-title">VISSLM Agent</div>
              <div className="brand-subtitle">本地数据智能工作台</div>
            </div>
          </div>
          <Menu
            mode="inline"
           selectedKeys={[page]}
            onClick={({ key }) => setPage(key as PageKey)}
            items={[
              ...visibleNavigationItems.map(({ key, icon, label }) => ({ key, icon, label })),
              { type: 'divider' },
              { key: 'settings', icon: <SettingOutlined />, label: '系统配置' }
            ]}
          />
          <div className={`model-status ${modelOnline === true ? 'online' : modelOnline === false ? 'offline' : 'checking'}`}>
            <span className="model-status-light" />
            <div>
              <Text strong ellipsis>{settings?.model.model ?? 'qwen3:8b'}</Text>
              <Text type="secondary">
                {modelOnline === true
                  ? settings?.model.source === 'online' ? '在线模型可用' : '本地模型在线'
                  : modelOnline === false
                    ? settings?.model.source === 'online' ? '在线模型不可用' : '本地模型离线'
                    : '正在检测模型'}
              </Text>
            </div>
          </div>
        </Sider>
        <Layout className="app-main-layout">
          <Content className="app-content">
            <div className="content-page-heading">
              <div className="content-page-title">{pageMeta[page].title}</div>
              <div className="content-page-subtitle">{pageMeta[page].description}</div>
            </div>
            <Suspense fallback={<PageLoadingFallback />}>
              {currentPage}
            </Suspense>
          </Content>
        </Layout>
      </Layout>
    </div>
  )
}

export default function App({ themeMode, onThemeModeChange }: AppProps): React.JSX.Element {
  return (
    <AppIconThemeContext.Provider value={themeMode}>
      <AntApp>
        <AppShell themeMode={themeMode} onThemeModeChange={onThemeModeChange} />
      </AntApp>
    </AppIconThemeContext.Provider>
  )
}
