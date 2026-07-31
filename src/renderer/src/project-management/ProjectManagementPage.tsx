import {
  ArrowRightOutlined,
  ArrowLeftOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  ExportOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  HolderOutlined,
  ImportOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  MoreOutlined,
  PlusOutlined,
  ProjectOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SyncOutlined,
  TeamOutlined,
  DisconnectOutlined,
  UploadOutlined,
  WarningOutlined
} from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { TableColumnsType, TablePaginationConfig } from 'antd'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import type {
  ManagedProject,
  ManagedProjectInput,
  OrganizationPerson,
  OrganizationPersonInput,
  ProjectAnalysisProgress,
  ProjectAsset,
  ProjectCostEntry,
  ProjectCostEntryInput,
  ProjectParticipant,
  ProjectParticipantInput,
  ProjectPlanTask,
  ProjectPlanTaskInput,
  ProjectPlanTaskMoveInput,
  ProjectPlanTaskStatus,
  ProjectPlanTaskType,
  ProjectRequirement,
  ProjectRequirementMatch,
  ProjectRequirementStatus
} from '../../../shared/project-types'
import type { KnowledgeDocumentDetail, KnowledgeDocumentPreview, RecordDetail, RecordRow } from '../../../shared/types'
import { RichDescription } from '../RichDescription'
import { ResizableTable } from '../ResizableTable'

const { Text, Title, Paragraph } = Typography

const requirementStatusMeta: Record<ProjectRequirementStatus, { label: string; color: string }> = {
  unmarked: { label: '未标记', color: 'default' },
  satisfied: { label: '已满足', color: 'success' },
  to_develop: { label: '待开发', color: 'processing' },
  to_negotiate: { label: '待协商', color: 'warning' }
}

const analysisStatusMeta: Record<ManagedProject['analysisStatus'], { label: string; color: string }> = {
  idle: { label: '未分析', color: 'default' },
  processing: { label: '分析中', color: 'processing' },
  ready: { label: '已识别', color: 'success' },
  failed: { label: '分析失败', color: 'error' }
}

const matchStatusMeta: Record<ManagedProject['matchStatus'], { label: string; color: string }> = {
  idle: { label: '待匹配', color: 'default' },
  processing: { label: '匹配中', color: 'processing' },
  ready: { label: '已匹配', color: 'success' },
  stale: { label: '需重新匹配', color: 'warning' },
  failed: { label: '匹配失败', color: 'error' }
}

const formatAmount = (value: number): string =>
  `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const formatDate = (value?: string): string => {
  if (!value) return '未设置'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN')
}

const deliveryHint = (project: ManagedProject): { label: string; color: string } | null => {
  if (!project.plannedDeliveryDate) return null
  const target = new Date(project.plannedDeliveryDate).getTime()
  if (Number.isNaN(target)) return null
  const days = Math.ceil((target - Date.now()) / 86_400_000)
  if (days < 0) return { label: `已逾期 ${Math.abs(days)} 天`, color: 'error' }
  if (days <= project.deliveryReminderDays) return { label: `${days} 天内交付`, color: 'warning' }
  return { label: `${days} 天后交付`, color: 'default' }
}

const analysisStageMeta: Array<{ phase: ProjectAnalysisProgress['phase']; label: string }> = [
  { phase: 'queued', label: '协议已上传' },
  { phase: 'embedding', label: '内容识别' },
  { phase: 'extracting', label: '需求抽取' },
  { phase: 'matching', label: '数据匹配' },
  { phase: 'done', label: '已完成' }
]

const analysisPhaseIndex: Record<ProjectAnalysisProgress['phase'], number> = {
  queued: 0,
  parsing: 1,
  embedding: 1,
  extracting: 2,
  matching: 3,
  done: 4,
  error: 0
}

const projectRiskMeta = (project: ManagedProject): { label: string; color: string } => {
  const delivery = deliveryHint(project)
  if (delivery?.color === 'error' || project.riskFactor >= 0.75) return { label: '高', color: 'error' }
  if (delivery?.color === 'warning' || project.riskFactor >= 0.4) return { label: '中', color: 'warning' }
  return { label: '低', color: 'success' }
}

const formatPercent = (value: number): string => `${Math.max(0, Math.min(100, value)).toFixed(0)}%`

const documentPreviewText = (document: KnowledgeDocumentDetail): string => [...document.chunks]
  .sort((left, right) => left.chunkIndex - right.chunkIndex)
  .map((chunk) => {
    const location = chunk.location?.trim()
    const content = chunk.content?.trim()
    if (!content) return ''
    return location ? `[${location}]\n${content}` : content
  })
  .filter(Boolean)
  .join('\n\n')

type PdfPreviewPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> }
}

type PdfPreviewDocument = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfPreviewPage>
  destroy?: () => Promise<void>
}

function PdfDocumentPreview({ contentBase64, fileName }: { contentBase64: string; fileName: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    const renderPdf = async (): Promise<void> => {
      const container = containerRef.current
      if (!container) return
      container.querySelectorAll('.project-document-pdf-page').forEach((page) => page.remove())
      setLoading(true)
      setError('')
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
          GlobalWorkerOptions: { workerSrc: string }
          getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfPreviewDocument> }
        }
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        const binary = window.atob(contentBase64)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        const pdf = await pdfjs.getDocument({
          data: bytes,
          isEvalSupported: false
        }).promise
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          if (disposed) return
          const page = await pdf.getPage(pageNumber)
          const baseViewport = page.getViewport({ scale: 1 })
          const availableWidth = Math.max(280, (container.clientWidth || 800) - 24)
          const scale = Math.max(0.6, Math.min(1.5, availableWidth / baseViewport.width))
          const viewport = page.getViewport({ scale })
          const pageShell = window.document.createElement('div')
          pageShell.className = 'project-document-pdf-page'
          pageShell.setAttribute('aria-label', `${fileName} 第 ${pageNumber} 页`)
          const canvas = window.document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          canvas.setAttribute('role', 'img')
          canvas.setAttribute('aria-label', `${fileName} 第 ${pageNumber} 页`)
          const context = canvas.getContext('2d')
          if (!context) throw new Error('当前环境无法创建 PDF 预览画布')
          pageShell.appendChild(canvas)
          container.appendChild(pageShell)
          await page.render({ canvasContext: context, viewport }).promise
        }
        if (!disposed) setLoading(false)
        await pdf.destroy?.()
      } catch (renderError) {
        if (!disposed) {
          setLoading(false)
          setError(renderError instanceof Error ? renderError.message : 'PDF 内容渲染失败')
        }
      }
    }

    void renderPdf()
    return () => {
      disposed = true
      containerRef.current?.querySelectorAll('.project-document-pdf-page').forEach((page) => page.remove())
    }
  }, [contentBase64, fileName])

  return (
    <div ref={containerRef} className="project-document-pdf-preview" aria-label={`预览协议附件：${fileName}`}>
      {loading && (
        <div className="project-document-preview-state">
          <Spin size="small" />
          <Text type="secondary">正在渲染 PDF…</Text>
        </div>
      )}
      {!loading && error && <Alert type="error" showIcon title="PDF 预览失败" description={error} />}
    </div>
  )
}

const organizationPersonStatusMeta: Record<OrganizationPerson['status'], { label: string; color: string }> = {
  active: { label: '在岗', color: 'success' },
  inactive: { label: '停用', color: 'default' }
}

const projectTaskTypeMeta: Record<ProjectPlanTaskType, { label: string; color: string }> = {
  milestone: { label: '里程碑', color: 'purple' },
  phase: { label: '阶段任务', color: 'processing' },
  task: { label: '普通任务', color: 'default' }
}

const projectTaskStatusMeta: Record<ProjectPlanTaskStatus, { label: string; color: string }> = {
  not_started: { label: '未开始', color: 'default' },
  in_progress: { label: '进行中', color: 'processing' },
  completed: { label: '已完成', color: 'success' },
  blocked: { label: '已阻塞', color: 'error' }
}

const projectTaskStatusOptions = Object.entries(projectTaskStatusMeta).map(([value, meta]) => ({ value, label: meta.label }))
const projectTaskTypeOptions = Object.entries(projectTaskTypeMeta).map(([value, meta]) => ({ value, label: meta.label }))

const formatRate = (value: number): string => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/小时`

const parseProjectDate = (value: string): Date | null => {
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

const calendarDaysBetween = (startDate: string, endDate: string): number => {
  const start = parseProjectDate(startDate)
  const end = parseProjectDate(endDate)
  if (!start || !end) return 0
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1)
}

const getProjectTaskDescendantIds = (tasks: ProjectPlanTask[], taskId?: string): Set<string> => {
  const descendants = new Set<string>()
  if (!taskId) return descendants
  const pending = [taskId]
  while (pending.length) {
    const parentId = pending.shift()
    if (!parentId) continue
    for (const task of tasks) {
      if (task.parentTaskId !== parentId || descendants.has(task.id)) continue
      descendants.add(task.id)
      pending.push(task.id)
    }
  }
  return descendants
}

const newProjectTaskRowId = '__new_project_task__'

type ProjectTaskTreeRow = ProjectPlanTask & { children?: ProjectTaskTreeRow[] }
type ProjectTaskDropPosition = 'before' | 'inside' | 'after'
type ProjectTaskDropTarget = { taskId: string; position: ProjectTaskDropPosition }
type ProjectTaskPointerDrag = { pointerId: number; taskId: string; startX: number; startY: number; active: boolean }

const buildProjectTaskTree = (tasks: ProjectPlanTask[]): ProjectTaskTreeRow[] => {
  const rows = new Map(tasks.map((task) => [task.id, { ...task } as ProjectTaskTreeRow]))
  const roots: ProjectTaskTreeRow[] = []
  for (const task of tasks) {
    const row = rows.get(task.id)
    if (!row) continue
    if (task.parentTaskId && rows.has(task.parentTaskId)) {
      const parent = rows.get(task.parentTaskId)
      if (parent) (parent.children ??= []).push(row)
    } else {
      roots.push(row)
    }
  }
  return roots
}

const findProjectTaskTreeRow = (rows: ProjectTaskTreeRow[], taskId: string): ProjectTaskTreeRow | null => {
  for (const row of rows) {
    if (row.id === taskId) return row
    const found = row.children ? findProjectTaskTreeRow(row.children, taskId) : null
    if (found) return found
  }
  return null
}

const insertProjectTaskTreeRow = (rows: ProjectTaskTreeRow[], row: ProjectTaskTreeRow, parentTaskId: string | undefined, sortOrder: number): void => {
  const parent = parentTaskId ? findProjectTaskTreeRow(rows, parentTaskId) : null
  const siblings = parent ? (parent.children ??= []) : rows
  const position = Math.min(Math.max(0, Math.trunc(sortOrder)), siblings.length)
  siblings.splice(position, 0, row)
}

const projectTaskInputFromTask = (task: ProjectPlanTask): ProjectPlanTaskInput => ({
  taskType: task.taskType,
  title: task.title,
  description: task.description,
  parentTaskId: task.parentTaskId,
  startDate: task.startDate,
  endDate: task.endDate,
  ownerPersonId: task.ownerPersonId,
  status: task.status,
  progressPercent: task.progressPercent,
  sortOrder: task.sortOrder
})

const projectInputFromValues = (values: Record<string, unknown>): ManagedProjectInput => ({
  projectName: String(values.projectName ?? ''),
  customerName: String(values.customerName ?? ''),
  contractAmount: Number(values.contractAmount ?? 0),
  riskFactor: Number(values.riskFactor ?? 0),
  deliveryReminderDays: Number(values.deliveryReminderDays ?? 0),
  plannedDeliveryDate: String(values.plannedDeliveryDate ?? ''),
  salesOwner: String(values.salesOwner ?? ''),
  technicalOwner: String(values.technicalOwner ?? ''),
  developmentOwner: String(values.developmentOwner ?? ''),
  estimatedCost: Number(values.estimatedCost ?? 0),
  estimatedDurationDays: Number(values.estimatedDurationDays ?? 0)
})

const projectOwnerOptions = (people: OrganizationPerson[], currentValue?: string): Array<{ value: string; label: string }> => {
  const options = people
    .filter((person) => person.status === 'active')
    .map((person) => ({
      value: person.name,
      label: `${person.name}${person.department ? ` · ${person.department}` : ''}${person.employeeNo ? ` · ${person.employeeNo}` : ''}`
    }))
  if (currentValue?.trim() && !options.some((option) => option.value === currentValue.trim())) {
    options.unshift({ value: currentValue.trim(), label: `${currentValue.trim()}（当前记录）` })
  }
  return options
}

function ProjectForm({
  form,
  onFinish,
  organizationPeople,
  currentProject
}: {
  form: ReturnType<typeof Form.useForm<ManagedProjectInput>>[0]
  onFinish: (values: ManagedProjectInput) => void
  organizationPeople: OrganizationPerson[]
  currentProject?: ManagedProject
}): React.JSX.Element {
  return (
    <Form form={form} layout="vertical" onFinish={onFinish} className="project-form-grid">
      <Form.Item name="projectName" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
        <Input placeholder="输入项目名称" />
      </Form.Item>
      <Form.Item name="customerName" label="客户名称">
        <Input placeholder="输入客户名称" />
      </Form.Item>
      <Form.Item name="contractAmount" label="合同金额">
        <InputNumber min={0} precision={2} style={{ width: '100%' }} addonAfter="元" />
      </Form.Item>
      <Form.Item name="riskFactor" label="风险系数">
        <InputNumber min={0} precision={2} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="deliveryReminderDays" label="交付提醒天数">
        <InputNumber min={0} precision={0} style={{ width: '100%' }} addonAfter="天" />
      </Form.Item>
      <Form.Item name="plannedDeliveryDate" label="计划交付日期">
        <Input type="date" />
      </Form.Item>
      <Form.Item name="salesOwner" label="销售负责人">
        <Select allowClear showSearch optionFilterProp="label" placeholder="选择组织人员" options={projectOwnerOptions(organizationPeople, currentProject?.salesOwner)} />
      </Form.Item>
      <Form.Item name="technicalOwner" label="技术负责人">
        <Select allowClear showSearch optionFilterProp="label" placeholder="选择组织人员" options={projectOwnerOptions(organizationPeople, currentProject?.technicalOwner)} />
      </Form.Item>
      <Form.Item name="developmentOwner" label="研发负责人">
        <Select allowClear showSearch optionFilterProp="label" placeholder="选择组织人员" options={projectOwnerOptions(organizationPeople, currentProject?.developmentOwner)} />
      </Form.Item>
      <Form.Item name="estimatedCost" label="预计成本">
        <InputNumber min={0} precision={2} style={{ width: '100%' }} addonAfter="元" />
      </Form.Item>
      <Form.Item name="estimatedDurationDays" label="预计工期">
        <InputNumber min={0} precision={0} style={{ width: '100%' }} addonAfter="天" />
      </Form.Item>
      <div className="project-form-actions">
        <Button type="primary" htmlType="submit">保存项目</Button>
      </div>
    </Form>
  )
}

function ProjectStatus({ project }: { project: ManagedProject }): React.JSX.Element {
  const analysis = analysisStatusMeta[project.analysisStatus]
  const matching = matchStatusMeta[project.matchStatus]
  return (
    <Space size={4} wrap>
      {project.lifecycle === 'draft' && <Tag color="purple">待确认</Tag>}
      <Tag color={analysis.color}>{analysis.label}</Tag>
      {project.requirementCount > 0 && <Tag color={matching.color}>{matching.label}</Tag>}
    </Space>
  )
}

type MatchTableColumnKey = 'record' | 'score' | 'reason' | 'asset'
type MatchTableColumnWidths = Record<MatchTableColumnKey, number>

const matchTableColumnStorageKey = 'visslm:project-match-table-column-widths:v1'
const projectAppTableScrollY = 'min(560px, max(260px, calc(100vh - 300px)))'
const projectCompactTableScrollY = 'min(360px, max(180px, calc(100vh - 420px)))'
const projectDetailTableScrollY = 'min(440px, max(220px, calc(100vh - 500px)))'
const projectMatchTableScrollY = 'min(390px, max(220px, calc(100vh - 520px)))'
const matchTableColumnDefaults: MatchTableColumnWidths = {
  record: 224,
  score: 112,
  reason: 280,
  asset: 120
}
const matchTableColumnMinWidths: MatchTableColumnWidths = {
  record: 180,
  score: 96,
  reason: 220,
  asset: 104
}
const matchTableColumnMaxWidths: MatchTableColumnWidths = {
  record: 420,
  score: 180,
  reason: 480,
  asset: 200
}
const matchTableColumnLabels: Record<MatchTableColumnKey, string> = {
  record: '数据中心数据',
  score: '匹配度',
  reason: '匹配说明',
  asset: '项目资产'
}

const clampMatchTableColumnWidth = (key: MatchTableColumnKey, value: number): number =>
  Math.min(matchTableColumnMaxWidths[key], Math.max(matchTableColumnMinWidths[key], Math.round(value)))

const readMatchTableColumnWidths = (): MatchTableColumnWidths => {
  const widths: MatchTableColumnWidths = { ...matchTableColumnDefaults }
  if (typeof window === 'undefined') return widths

  try {
    const stored = window.localStorage.getItem(matchTableColumnStorageKey)
    if (!stored) return widths
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return widths

    for (const key of Object.keys(widths) as MatchTableColumnKey[]) {
      const value = Number((parsed as Record<string, unknown>)[key])
      if (Number.isFinite(value)) widths[key] = clampMatchTableColumnWidth(key, value)
    }
  } catch {
    // Ignore malformed or unavailable local storage and use the safe defaults.
  }

  return widths
}

const persistMatchTableColumnWidths = (widths: MatchTableColumnWidths): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(matchTableColumnStorageKey, JSON.stringify(widths))
  } catch {
    // The table remains usable when local storage is unavailable.
  }
}

type ProjectColumnWidths = Record<string, number>

const clampProjectColumnWidth = (
  key: string,
  value: number,
  minimums: ProjectColumnWidths,
  maximums: ProjectColumnWidths
): number => Math.min(maximums[key] ?? 600, Math.max(minimums[key] ?? 80, Math.round(value)))

const useProjectColumnWidths = <T extends string>(
  storageKey: string,
  defaults: Record<T, number>,
  minimums: Record<T, number>,
  maximums: Record<T, number>
): {
  widths: Record<T, number>
  resize: (key: T, value: number) => void
  commitResize: (key: T, value: number) => void
} => {
  const read = (): Record<T, number> => {
    const widths = { ...defaults }
    if (typeof window === 'undefined') return widths
    try {
      const stored = window.localStorage.getItem(storageKey)
      if (!stored) return widths
      const parsed: unknown = JSON.parse(stored)
      if (!parsed || typeof parsed !== 'object') return widths
      for (const key of Object.keys(widths) as T[]) {
        const value = Number((parsed as Record<string, unknown>)[key])
        if (Number.isFinite(value)) widths[key] = clampProjectColumnWidth(key, value, minimums, maximums)
      }
    } catch {
      // Ignore malformed storage and use safe defaults.
    }
    return widths
  }

  const [widths, setWidths] = useState<Record<T, number>>(read)
  const widthsRef = useRef(widths)
  const save = useCallback((next: Record<T, number>): void => {
    widthsRef.current = next
    setWidths(next)
  }, [])
  const resize = useCallback((key: T, value: number): void => {
    save({ ...widthsRef.current, [key]: clampProjectColumnWidth(key, value, minimums, maximums) })
  }, [maximums, minimums, save])
  const commitResize = useCallback((key: T, value: number): void => {
    const next = { ...widthsRef.current, [key]: clampProjectColumnWidth(key, value, minimums, maximums) }
    save(next)
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // The table remains usable when local storage is unavailable.
    }
  }, [maximums, minimums, save, storageKey])

  return { widths, resize, commitResize }
}

type ResizableHeaderCellProps = Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'width'> & {
  width?: number
  columnKey?: string
  columnLabel?: string
  minWidth?: number
  maxWidth?: number
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
}

function ResizableHeaderCell({
  width,
  columnKey,
  columnLabel,
  minWidth = 80,
  maxWidth = 600,
  onResize,
  onResizeEnd,
  children,
  className,
  style,
  ...restProps
}: ResizableHeaderCellProps): React.JSX.Element {
  const cleanupRef = useRef<(() => void) | null>(null)
  const clampHeaderWidth = (value: number, minimum: number, maximum: number): number =>
    Math.min(maximum, Math.max(minimum, Math.round(value)))
  const currentWidth = clampHeaderWidth(width ?? 120, minWidth, maxWidth)

  useEffect(() => () => {
    cleanupRef.current?.()
  }, [])

  const adjustByKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!onResize) return
    const delta = event.key === 'ArrowRight' ? 12 : event.key === 'ArrowLeft' ? -12 : 0
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    const nextWidth = clampHeaderWidth(currentWidth + delta, minWidth, maxWidth)
    onResize(nextWidth)
    onResizeEnd?.(nextWidth)
  }

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!onResize) return
    event.preventDefault()
    event.stopPropagation()

    cleanupRef.current?.()
    const startX = event.clientX
    const startWidth = currentWidth
    const pointerId = event.pointerId
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const getNextWidth = (clientX: number): number =>
      clampHeaderWidth(startWidth + clientX - startX, minWidth, maxWidth)
    const handlePointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      onResize(getNextWidth(moveEvent.clientX))
    }
    const handlePointerUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return
      const nextWidth = getNextWidth(upEvent.clientX)
      onResize(nextWidth)
      onResizeEnd?.(nextWidth)
      cleanupRef.current?.()
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      cleanupRef.current = null
    }

    cleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }

  return (
    <th
      {...restProps}
      className={[className, 'project-resizable-header-cell'].filter(Boolean).join(' ')}
      style={{ ...style, position: 'relative', width: currentWidth, minWidth: currentWidth }}
    >
      {children}
      {onResize && (
        <button
          type="button"
          className="project-table-resize-handle"
          aria-label={`调整${columnLabel ?? columnKey ?? ''}列宽`}
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={currentWidth}
          title="拖拽调整列宽"
          onPointerDown={beginResize}
          onKeyDown={adjustByKeyboard}
        />
      )}
    </th>
  )
}

function MatchDrawer({
  requirement,
  open,
  onClose,
  onOpenRecord,
  onLinkAsset,
  onSaveKeyInfoTerms
}: {
  requirement: ProjectRequirement | null
  open: boolean
  onClose: () => void
  onOpenRecord: (uid: string) => void
  onLinkAsset: (recordUid: string) => void
  onSaveKeyInfoTerms: (requirementId: string, terms: string[]) => Promise<void>
}): React.JSX.Element {
  const [matches, setMatches] = useState<ProjectRequirementMatch[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [editingKeyInfoTerms, setEditingKeyInfoTerms] = useState(false)
  const [keyInfoTermsDraft, setKeyInfoTermsDraft] = useState<string[]>([])
  const [savingKeyInfoTerms, setSavingKeyInfoTerms] = useState(false)
  const [columnWidths, setColumnWidths] = useState<MatchTableColumnWidths>(readMatchTableColumnWidths)
  const columnWidthsRef = useRef(columnWidths)

  const load = useCallback(async (): Promise<void> => {
    if (!requirement) return
    setLoading(true)
    try {
      const result = await window.visslm.listProjectRequirementMatches({
        requirementId: requirement.id,
        page,
        pageSize
      })
      setMatches(result.rows)
      setTotal(result.total)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, requirement])

  useEffect(() => {
    if (!open) return
    setPage(1)
    setEditingKeyInfoTerms(false)
    setKeyInfoTermsDraft(requirement?.keyInfoTerms ?? [])
  }, [open, requirement?.id])

  useEffect(() => {
    void load()
  }, [load])

  const saveKeyInfoTerms = async (): Promise<void> => {
    if (!requirement) return
    setSavingKeyInfoTerms(true)
    try {
      await onSaveKeyInfoTerms(requirement.id, keyInfoTermsDraft)
      setEditingKeyInfoTerms(false)
    } finally {
      setSavingKeyInfoTerms(false)
    }
  }

  const resizeColumn = useCallback((key: MatchTableColumnKey, value: number): void => {
    const nextWidths = {
      ...columnWidthsRef.current,
      [key]: clampMatchTableColumnWidth(key, value)
    }
    columnWidthsRef.current = nextWidths
    setColumnWidths(nextWidths)
  }, [])

  const commitColumnResize = useCallback((key: MatchTableColumnKey, value: number): void => {
    const nextWidths = {
      ...columnWidthsRef.current,
      [key]: clampMatchTableColumnWidth(key, value)
    }
    columnWidthsRef.current = nextWidths
    setColumnWidths(nextWidths)
    persistMatchTableColumnWidths(nextWidths)
  }, [])

  const matchTableWidth = useMemo(
    () => Object.values(columnWidths).reduce((total, width) => total + width, 0),
    [columnWidths]
  )

  const matchColumns = useMemo<TableColumnsType<ProjectRequirementMatch>>(() => [
    {
      title: '数据中心数据',
      key: 'record',
      width: columnWidths.record,
      onHeaderCell: () => ({
        width: columnWidths.record,
        columnKey: 'record',
        minWidth: matchTableColumnMinWidths.record,
        maxWidth: matchTableColumnMaxWidths.record,
        onResize: (width: number) => resizeColumn('record', width),
        onResizeEnd: (width: number) => commitColumnResize('record', width)
      } as ResizableHeaderCellProps),
      render: (_value, row) => (
        <div className="project-match-record">
          <Button type="link" className="project-table-link" onClick={() => onOpenRecord(row.recordUid)}>
            <EyeOutlined /> {row.recordName || row.recordUid}
          </Button>
          <Text type="secondary">{row.nodeType} · {row.itemId}</Text>
        </div>
      )
    },
    {
      title: '匹配度',
      dataIndex: 'finalScore',
      width: columnWidths.score,
      sorter: false,
      onHeaderCell: () => ({
        width: columnWidths.score,
        columnKey: 'score',
        minWidth: matchTableColumnMinWidths.score,
        maxWidth: matchTableColumnMaxWidths.score,
        onResize: (width: number) => resizeColumn('score', width),
        onResizeEnd: (width: number) => commitColumnResize('score', width)
      } as ResizableHeaderCellProps),
      render: (value: number, row) => (
        <div className="project-score-cell">
          <strong>{value.toFixed(1)}%</strong>
          <Tag color={row.scoreSource === 'ai' ? 'purple' : 'default'}>
            {row.scoreSource === 'ai' ? 'AI复核' : '向量'}
          </Tag>
        </div>
      )
    },
    {
      title: '匹配说明',
      dataIndex: 'reason',
      width: columnWidths.reason,
      onHeaderCell: () => ({
        width: columnWidths.reason,
        columnKey: 'reason',
        minWidth: matchTableColumnMinWidths.reason,
        maxWidth: matchTableColumnMaxWidths.reason,
        onResize: (width: number) => resizeColumn('reason', width),
        onResizeEnd: (width: number) => commitColumnResize('reason', width)
      } as ResizableHeaderCellProps),
      render: (value: string) => value ? <span className="project-match-reason">{value}</span> : <Text type="secondary">暂无 AI 说明</Text>
    },
    {
      title: '项目资产',
      key: 'asset',
      width: columnWidths.asset,
      onHeaderCell: () => ({
        width: columnWidths.asset,
        columnKey: 'asset',
        minWidth: matchTableColumnMinWidths.asset,
        maxWidth: matchTableColumnMaxWidths.asset,
        onResize: (width: number) => resizeColumn('asset', width),
        onResizeEnd: (width: number) => commitColumnResize('asset', width)
      } as ResizableHeaderCellProps),
      render: (_value, row) => row.assetLinked
        ? <Tag color="success" icon={<CheckCircleOutlined />}>已关联</Tag>
        : <Button type="link" size="small" icon={<LinkOutlined />} onClick={() => onLinkAsset(row.recordUid)}>关联资产</Button>
    }
  ], [columnWidths, commitColumnResize, onLinkAsset, onOpenRecord, resizeColumn])

  return (
    <Drawer
      className="project-match-drawer-shell"
      title={requirement ? `匹配明细：${requirement.title}` : '匹配明细'}
      open={open}
      onClose={onClose}
      size={900}
    >
      {requirement && (
        <div className="project-match-drawer">
          <Card size="small" className="project-requirement-preview">
            <Text strong>{requirement.title}</Text>
            <Paragraph ellipsis={{ rows: 3, expandable: true }}>{requirement.content}</Paragraph>
            <Space wrap>
              <Tag>最高匹配度 {requirement.highestMatchScore.toFixed(1)}%</Tag>
              <Tag>{requirement.matchCount} 条数据</Tag>
              {requirement.module && <Tag>{requirement.module}</Tag>}
              {requirement.sourceLocation && <Tag>{requirement.sourceLocation}</Tag>}
            </Space>
          </Card>
          <Card
            size="small"
            className="project-key-info-terms-card"
            title="关键功能信息词"
            extra={!editingKeyInfoTerms && <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setKeyInfoTermsDraft(requirement.keyInfoTerms); setEditingKeyInfoTerms(true) }}>编辑</Button>}
          >
            {editingKeyInfoTerms ? (
              <div className="project-key-info-terms-editor">
                <Select
                  mode="tags"
                  value={keyInfoTermsDraft}
                  onChange={(values) => setKeyInfoTermsDraft(values as string[])}
                  tokenSeparators={['，', ',', '、', '；', ';']}
                  placeholder="输入关键词后按 Enter，可用逗号批量分隔"
                  style={{ width: '100%' }}
                  options={keyInfoTermsDraft.map((term) => ({ value: term, label: term }))}
                />
                <Space>
                  <Button size="small" onClick={() => { setKeyInfoTermsDraft(requirement.keyInfoTerms); setEditingKeyInfoTerms(false) }}>取消</Button>
                  <Button type="primary" size="small" loading={savingKeyInfoTerms} onClick={() => void saveKeyInfoTerms()}>保存并重新匹配</Button>
                </Space>
              </div>
            ) : (
              <div className="project-key-info-terms-display">
                {requirement.keyInfoTerms.length ? <Space wrap size={[6, 6]}>{requirement.keyInfoTerms.map((term) => <Tag color="purple" key={term}>{term}</Tag>)}</Space> : <Text type="secondary">暂未提取信息词，可手动添加后重新匹配</Text>}
                <Text type="secondary" className="project-key-info-terms-source">{requirement.keyInfoTermsSource === 'manual' ? '人工修改' : 'AI 提取'} · 匹配仅使用这些词</Text>
              </div>
            )}
          </Card>
          <Table<ProjectRequirementMatch>
            className="project-match-table"
            rowKey="recordUid"
            loading={loading}
            dataSource={matches}
            tableLayout="fixed"
            scroll={{ x: matchTableWidth, y: projectMatchTableScrollY }}
            components={{ header: { cell: ResizableHeaderCell } }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              showTotal: (count) => `共 ${count} 条数据`
            }}
            onChange={(pagination: TablePaginationConfig) => {
              setPage(pagination.current ?? 1)
              setPageSize(pagination.pageSize ?? 20)
            }}
            columns={matchColumns}
          />
        </div>
      )}
    </Drawer>
  )
}

type OrganizationPeopleColumnKey = 'name' | 'employeeNo' | 'department' | 'role' | 'hourlyRate' | 'status' | 'updatedAt' | 'action'
const organizationPeopleColumnStorageKey = 'visslm:organization-people-column-widths:v1'
const organizationPeopleColumnDefaults: Record<OrganizationPeopleColumnKey, number> = {
  name: 180,
  employeeNo: 130,
  department: 160,
  role: 160,
  hourlyRate: 150,
  status: 100,
  updatedAt: 150,
  action: 150
}
const organizationPeopleColumnMinWidths: Record<OrganizationPeopleColumnKey, number> = {
  name: 140,
  employeeNo: 100,
  department: 120,
  role: 120,
  hourlyRate: 130,
  status: 88,
  updatedAt: 130,
  action: 130
}
const organizationPeopleColumnMaxWidths: Record<OrganizationPeopleColumnKey, number> = {
  name: 320,
  employeeNo: 220,
  department: 300,
  role: 280,
  hourlyRate: 220,
  status: 150,
  updatedAt: 220,
  action: 220
}
const organizationPeopleColumnLabels: Record<OrganizationPeopleColumnKey, string> = {
  name: '姓名',
  employeeNo: '工号',
  department: '部门',
  role: '岗位',
  hourlyRate: '工时报价',
  status: '状态',
  updatedAt: '更新时间',
  action: '操作'
}

function OrganizationPeoplePage({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [people, setPeople] = useState<OrganizationPerson[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<OrganizationPerson['status'] | undefined>()
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<OrganizationPerson | null>(null)
  const [form] = Form.useForm<OrganizationPersonInput>()
  const { widths, resize, commitResize } = useProjectColumnWidths(
    organizationPeopleColumnStorageKey,
    organizationPeopleColumnDefaults,
    organizationPeopleColumnMinWidths,
    organizationPeopleColumnMaxWidths
  )

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.visslm.listOrganizationPeople({ page, pageSize, search, ...(status ? { status } : {}) })
      setPeople(result.rows)
      setTotal(result.total)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, status])

  useEffect(() => {
    void load()
  }, [load])

  const openEditor = (person?: OrganizationPerson): void => {
    setEditing(person ?? null)
    form.setFieldsValue(person
      ? { name: person.name, employeeNo: person.employeeNo, department: person.department, role: person.role, hourlyRate: person.hourlyRate, status: person.status, notes: person.notes }
      : { status: 'active', hourlyRate: 0 })
    setModalOpen(true)
  }

  const save = async (values: OrganizationPersonInput): Promise<void> => {
    try {
      if (editing) await window.visslm.updateOrganizationPerson(editing.id, values)
      else await window.visslm.createOrganizationPerson(values)
      setModalOpen(false)
      await load()
      onChanged()
      message.success(editing ? '组织人员已更新' : '组织人员已添加')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存组织人员失败')
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      const result = await window.visslm.deleteOrganizationPerson(id)
      if (!result.ok) {
        message.warning(result.message)
        return
      }
      await load()
      onChanged()
      message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除组织人员失败')
    }
  }

  const columnHeader = (key: OrganizationPeopleColumnKey): (() => ResizableHeaderCellProps) => () => ({
    width: widths[key],
    columnKey: key,
    columnLabel: organizationPeopleColumnLabels[key],
    minWidth: organizationPeopleColumnMinWidths[key],
    maxWidth: organizationPeopleColumnMaxWidths[key],
    onResize: (value: number) => resize(key, value),
    onResizeEnd: (value: number) => commitResize(key, value)
  })

  const columns: TableColumnsType<OrganizationPerson> = [
    { title: '姓名', dataIndex: 'name', width: widths.name, ellipsis: true, onHeaderCell: columnHeader('name') },
    { title: '工号', dataIndex: 'employeeNo', width: widths.employeeNo, ellipsis: true, onHeaderCell: columnHeader('employeeNo'), render: (value: string) => value || <Text type="secondary">未填写</Text> },
    { title: '部门', dataIndex: 'department', width: widths.department, ellipsis: true, onHeaderCell: columnHeader('department'), render: (value: string) => value || <Text type="secondary">未填写</Text> },
    { title: '岗位', dataIndex: 'role', width: widths.role, ellipsis: true, onHeaderCell: columnHeader('role'), render: (value: string) => value || <Text type="secondary">未填写</Text> },
    { title: '工时报价', dataIndex: 'hourlyRate', width: widths.hourlyRate, onHeaderCell: columnHeader('hourlyRate'), render: (value: number) => <Text strong>{formatRate(value)}</Text> },
    { title: '状态', dataIndex: 'status', width: widths.status, onHeaderCell: columnHeader('status'), render: (value: OrganizationPerson['status']) => <Tag color={organizationPersonStatusMeta[value].color}>{organizationPersonStatusMeta[value].label}</Tag> },
    { title: '更新时间', dataIndex: 'updatedAt', width: widths.updatedAt, onHeaderCell: columnHeader('updatedAt'), render: formatDate },
    {
      title: '操作', key: 'action', width: widths.action, fixed: 'right', onHeaderCell: columnHeader('action'),
      render: (_value, row) => <Space size={0}>
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEditor(row)}>编辑</Button>
        <Popconfirm title="确认删除该组织人员？" description="已绑定项目的人员需要先解除参与关系。" onConfirm={() => void remove(row.id)}>
          <Button type="link" danger size="small" icon={<DeleteOutlined />}>删除</Button>
        </Popconfirm>
      </Space>
    }
  ]

  const tableWidth = Object.values(widths).reduce((sum, width) => sum + width, 0)

  return (
    <div className="organization-people-page">
      <div className="project-page-toolbar organization-people-toolbar">
        <div>
          <Title level={4}>组织人员</Title>
          <Text type="secondary">维护项目参与人员和统一工时报价，项目绑定时自动带入报价快照</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>新增组织人员</Button>
      </div>
      <Card className="project-list-card organization-people-card">
        <div className="project-list-filter">
          <Space wrap>
            <Input.Search allowClear prefix={<SearchOutlined />} placeholder="搜索姓名、工号、部门或岗位" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} onSearch={() => void load()} style={{ width: 320 }} />
            <Select allowClear placeholder="全部状态" value={status} onChange={(value) => { setStatus(value); setPage(1) }} options={Object.entries(organizationPersonStatusMeta).map(([value, item]) => ({ value, label: item.label }))} style={{ width: 120 }} />
          </Space>
          <Text type="secondary">共 {total} 人</Text>
        </div>
        <Table<OrganizationPerson>
          rowKey="id"
          loading={loading}
          dataSource={people}
          columns={columns}
          scroll={{ x: tableWidth, y: projectAppTableScrollY }}
          pagination={{ current: page, pageSize, total, showSizeChanger: true, showTotal: (count) => `共 ${count} 人` }}
          onChange={(pagination: TablePaginationConfig) => { setPage(pagination.current ?? 1); setPageSize(pagination.pageSize ?? 20) }}
        />
      </Card>
      <Modal title={editing ? '编辑组织人员' : '新增组织人员'} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => void form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
          <div className="project-form-grid">
            <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入人员姓名' }]}><Input placeholder="例如：张三" /></Form.Item>
            <Form.Item name="employeeNo" label="工号"><Input placeholder="例如：RD-001" /></Form.Item>
            <Form.Item name="department" label="部门"><Input placeholder="例如：研发中心" /></Form.Item>
            <Form.Item name="role" label="岗位"><Input placeholder="例如：前端工程师" /></Form.Item>
            <Form.Item name="hourlyRate" label="工时报价" rules={[{ required: true, message: '请输入工时报价' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} addonAfter="元/小时" /></Form.Item>
            <Form.Item name="status" label="状态"><Select options={Object.entries(organizationPersonStatusMeta).map(([value, item]) => ({ value, label: item.label }))} /></Form.Item>
          </div>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={3} placeholder="补充技能、职级或成本说明" /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

type ParticipantColumnKey = 'person' | 'rate' | 'period' | 'duration' | 'cost' | 'notes' | 'action'
const participantColumnStorageKey = 'visslm:project-participant-column-widths:v1'
const participantColumnDefaults: Record<ParticipantColumnKey, number> = { person: 220, rate: 150, period: 230, duration: 110, cost: 160, notes: 220, action: 140 }
const participantColumnMinWidths: Record<ParticipantColumnKey, number> = { person: 170, rate: 120, period: 190, duration: 90, cost: 130, notes: 150, action: 120 }
const participantColumnMaxWidths: Record<ParticipantColumnKey, number> = { person: 360, rate: 220, period: 340, duration: 160, cost: 240, notes: 360, action: 200 }
const participantColumnLabels: Record<ParticipantColumnKey, string> = { person: '参与人员', rate: '工时报价', period: '参与周期', duration: '工期', cost: '人力预估成本', notes: '备注', action: '操作' }

function ProjectParticipantsPanel({
  participants,
  loading,
  onAdd,
  onEdit,
  onDelete
}: {
  participants: ProjectParticipant[]
  loading: boolean
  onAdd: () => void
  onEdit: (participant: ProjectParticipant) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const { widths, resize, commitResize } = useProjectColumnWidths(participantColumnStorageKey, participantColumnDefaults, participantColumnMinWidths, participantColumnMaxWidths)
  const totalCost = participants.reduce((sum, item) => sum + item.estimatedCost, 0)
  const totalDays = participants.reduce((sum, item) => sum + item.durationDays, 0)
  const header = (key: ParticipantColumnKey): (() => ResizableHeaderCellProps) => () => ({
    width: widths[key], columnKey: key, columnLabel: participantColumnLabels[key], minWidth: participantColumnMinWidths[key], maxWidth: participantColumnMaxWidths[key],
    onResize: (value: number) => resize(key, value), onResizeEnd: (value: number) => commitResize(key, value)
  })
  const columns: TableColumnsType<ProjectParticipant> = [
    { title: '参与人员', key: 'person', width: widths.person, onHeaderCell: header('person'), render: (_value, row) => <div className="project-participant-person"><Text strong>{row.personName}</Text><Text type="secondary">{[row.employeeNo, row.department, row.role].filter(Boolean).join(' · ') || '未补充岗位信息'}</Text></div> },
    { title: '工时报价', dataIndex: 'hourlyRate', width: widths.rate, onHeaderCell: header('rate'), render: (value: number) => formatRate(value) },
    { title: '参与周期', key: 'period', width: widths.period, onHeaderCell: header('period'), render: (_value, row) => <span className="project-nowrap">{formatDate(row.startDate)} 至 {formatDate(row.endDate)}</span> },
    { title: '工期', dataIndex: 'durationDays', width: widths.duration, onHeaderCell: header('duration'), render: (value: number) => <span className="project-inline-quantity"><strong>{value}</strong> 天</span> },
    { title: '人力预估成本', dataIndex: 'estimatedCost', width: widths.cost, onHeaderCell: header('cost'), render: (value: number) => <Text strong>{formatAmount(value)}</Text> },
    { title: '备注', dataIndex: 'notes', width: widths.notes, ellipsis: true, onHeaderCell: header('notes'), render: (value: string) => value || <Text type="secondary">—</Text> },
    { title: '操作', key: 'action', width: widths.action, fixed: 'right', onHeaderCell: header('action'), render: (_value, row) => <Space size={0}><Button type="link" size="small" icon={<EditOutlined />} onClick={() => onEdit(row)}>编辑</Button><Popconfirm title="确认移除该项目参与人员？" onConfirm={() => onDelete(row.id)}><Button type="link" danger size="small" icon={<DeleteOutlined />}>移除</Button></Popconfirm></Space> }
  ]
  return (
    <Card className="project-table-card project-participants-card" extra={<Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>绑定项目参与人员</Button>}>
      <div className="project-subsection-summary">
        <div><Text type="secondary">参与人数</Text><strong>{participants.length}</strong><Text type="secondary">人</Text></div>
        <div><Text type="secondary">累计参与工期</Text><strong>{totalDays}</strong><Text type="secondary">人天</Text></div>
        <div><Text type="secondary">人力预估成本</Text><strong>{formatAmount(totalCost)}</strong><Text type="secondary">按 8 小时/天估算</Text></div>
      </div>
      {participants.length ? <Table<ProjectParticipant> rowKey="id" loading={loading} dataSource={participants} columns={columns} scroll={{ x: Object.values(widths).reduce((sum, width) => sum + width, 0), y: projectDetailTableScrollY }} pagination={{ pageSize: 10, showTotal: (count) => `共 ${count} 人` }} /> : <Empty description="尚未绑定项目参与人员" />}
    </Card>
  )
}

type ProjectTaskColumnKey = 'type' | 'title' | 'period' | 'owner' | 'status' | 'progress' | 'action'
const projectTaskColumnStorageKey = 'visslm:project-plan-task-column-widths:v4'
const projectTaskColumnDefaults: Record<ProjectTaskColumnKey, number> = { type: 120, title: 360, period: 240, owner: 170, status: 130, progress: 110, action: 260 }
const projectTaskColumnMinWidths: Record<ProjectTaskColumnKey, number> = { type: 100, title: 260, period: 190, owner: 120, status: 110, progress: 90, action: 220 }
const projectTaskColumnMaxWidths: Record<ProjectTaskColumnKey, number> = { type: 180, title: 620, period: 360, owner: 260, status: 180, progress: 160, action: 340 }
const projectTaskColumnLabels: Record<ProjectTaskColumnKey, string> = { type: '类型', title: '计划项', period: '计划周期', owner: '负责人', status: '完成状态', progress: '完成度', action: '操作' }

type ProjectGanttRow = {
  id: string
  label: string
  meta?: string
  startDate: string
  endDate: string
  barLabel: string
  barTitle: string
  barClassName?: string
  indent?: number
  prefix?: React.ReactNode
}

type ProjectGanttTimelineProps = {
  title: string
  description: string
  labelHeader: string
  rows: ProjectGanttRow[]
  emptyDescription: string
  sectionClassName: string
}

function ProjectGanttTimeline({
  title,
  description,
  labelHeader,
  rows,
  emptyDescription,
  sectionClassName
}: ProjectGanttTimelineProps): React.JSX.Element {
  const startDate = rows.reduce((earliest, row) => row.startDate < earliest ? row.startDate : earliest, rows[0]?.startDate ?? '')
  const endDate = rows.reduce((latest, row) => row.endDate > latest ? row.endDate : latest, rows[0]?.endDate ?? startDate)
  const dayCount = rows.length ? Math.max(1, calendarDaysBetween(startDate, endDate)) : 1
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = parseProjectDate(startDate) ?? new Date()
    date.setDate(date.getDate() + index)
    return date
  })
  const timelineWidth = dayCount * 34

  return (
    <section className={`project-gantt-section ${sectionClassName}`}>
      <div className="project-plan-section-heading">
        <div>
          <Title level={4}>{title}</Title>
          <Text type="secondary">{description}</Text>
        </div>
        <Text type="secondary">{rows.length ? `${formatDate(startDate)} 至 ${formatDate(endDate)} · ${dayCount} 天` : '暂无时间范围'}</Text>
      </div>
      {rows.length ? (
        <div className="project-gantt-scroll">
          <div className="project-gantt-grid" style={{ width: 220 + timelineWidth, gridTemplateColumns: `220px ${timelineWidth}px` }}>
            <div className="project-gantt-label-head">{labelHeader}</div>
            <div className="project-gantt-axis" style={{ gridTemplateColumns: `repeat(${dayCount}, 34px)` }}>
              {days.map((date, index) => <div key={date.toISOString()} className={index % 7 === 0 ? 'is-week-start' : ''}>{index % 7 === 0 ? `${date.getMonth() + 1}/${date.getDate()}` : ''}</div>)}
            </div>
            {rows.map((row) => {
              const offset = Math.max(0, calendarDaysBetween(startDate, row.startDate) - 1)
              const duration = Math.max(1, calendarDaysBetween(row.startDate, row.endDate))
              return <React.Fragment key={row.id}>
                <div className="project-gantt-label" style={{ paddingLeft: 12 + (row.indent ?? 0) * 18 }}>
                  {row.prefix}
                  <div className="project-gantt-label-copy">
                    <span title={row.label}>{row.label}</span>
                    {row.meta && <span className="project-gantt-label-meta" title={row.meta}>{row.meta}</span>}
                  </div>
                </div>
                <div className="project-gantt-track">
                  <div
                    className={`project-gantt-bar ${row.barClassName ?? ''}`}
                    style={{ left: offset * 34 + 2, width: Math.max(28, duration * 34 - 4) }}
                    title={row.barTitle}
                    aria-label={row.barTitle}
                    role="img"
                  >
                    <span>{row.barLabel}</span>
                  </div>
                </div>
              </React.Fragment>
            })}
          </div>
        </div>
      ) : <Empty className="project-gantt-empty" description={emptyDescription} />}
    </section>
  )
}

function ProjectTaskGantt({ tasks }: { tasks: ProjectPlanTask[] }): React.JSX.Element {
  const rows = tasks.map<ProjectGanttRow>((task) => {
    const type = projectTaskTypeMeta[task.taskType]
    const status = projectTaskStatusMeta[task.status]
    return {
      id: task.id,
      label: task.title,
      startDate: task.startDate,
      endDate: task.endDate,
      barLabel: task.title,
      barTitle: `${task.title} · ${status.label} · ${task.progressPercent}%`,
      barClassName: `is-${task.taskType} is-${task.status}`,
      indent: task.depth,
      prefix: <Tag color={type.color}>{type.label}</Tag>
    }
  })

  return <ProjectGanttTimeline title="任务甘特图" description="按任务起止时间展示项目执行节奏" labelHeader="任务" rows={rows} emptyDescription="新增里程碑或任务后生成任务甘特图" sectionClassName="project-task-gantt" />
}

function ProjectResourceGantt({ participants }: { participants: ProjectParticipant[] }): React.JSX.Element {
  const rows = participants
    .slice()
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.personName.localeCompare(right.personName, 'zh-CN'))
    .map<ProjectGanttRow>((participant) => ({
      id: participant.id,
      label: participant.personName,
      meta: [participant.employeeNo, participant.department, participant.role].filter(Boolean).join(' · ') || '未补充岗位信息',
      startDate: participant.startDate,
      endDate: participant.endDate,
      barLabel: participant.personName,
      barTitle: `${participant.personName} · 参与开始：${formatDate(participant.startDate)} · 参与结束：${formatDate(participant.endDate)}`,
      barClassName: 'is-resource',
      prefix: <span className="project-gantt-label-icon" aria-hidden="true"><TeamOutlined /></span>
    }))

  return <ProjectGanttTimeline title="人力资源甘特图" description="按参与开始时间展示项目内所有人员的参与周期" labelHeader="项目人员" rows={rows} emptyDescription="绑定项目参与人员后生成资源甘特图" sectionClassName="project-resource-gantt" />
}

function ProjectPlanPanel({
  tasks,
  participants,
  loading,
  onCreate,
  onUpdate,
  onMove,
  organizationPeople,
  onDelete
}: {
  tasks: ProjectPlanTask[]
  participants: ProjectParticipant[]
  loading: boolean
  onCreate: (input: ProjectPlanTaskInput) => Promise<void>
  onUpdate: (id: string, input: ProjectPlanTaskInput) => Promise<void>
  onMove: (id: string, input: ProjectPlanTaskMoveInput) => Promise<void>
  organizationPeople: OrganizationPerson[]
  onDelete: (id: string) => Promise<void>
}): React.JSX.Element {
  const { widths, resize, commitResize } = useProjectColumnWidths(projectTaskColumnStorageKey, projectTaskColumnDefaults, projectTaskColumnMinWidths, projectTaskColumnMaxWidths)
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null)
  const [inlineDraft, setInlineDraft] = useState<ProjectPlanTaskInput | null>(null)
  const [inlineSaving, setInlineSaving] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedTaskKeys, setExpandedTaskKeys] = useState<string[]>([])
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<ProjectTaskDropTarget | null>(null)
  const [movingTask, setMovingTask] = useState(false)
  const taskPointerDragRef = useRef<ProjectTaskPointerDrag | null>(null)
  const movingTaskRef = useRef(false)
  const completed = tasks.filter((task) => task.status === 'completed').length
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length
  const blocked = tasks.filter((task) => task.status === 'blocked').length
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const draftDepth = inlineDraft?.parentTaskId ? (taskById.get(inlineDraft.parentTaskId)?.depth ?? -1) + 1 : 0
  const displayTree = useMemo<ProjectTaskTreeRow[]>(() => {
    const tree = buildProjectTaskTree(tasks)
    if (inlineEditingId !== newProjectTaskRowId || !inlineDraft) return tree
    const draftRow: ProjectTaskTreeRow = {
      id: newProjectTaskRowId,
      projectId: '',
      taskType: inlineDraft.taskType,
      title: inlineDraft.title,
      description: inlineDraft.description ?? '',
      ...(inlineDraft.parentTaskId ? { parentTaskId: inlineDraft.parentTaskId } : {}),
      startDate: inlineDraft.startDate,
      endDate: inlineDraft.endDate,
      ...(inlineDraft.ownerPersonId ? { ownerPersonId: inlineDraft.ownerPersonId } : {}),
      status: inlineDraft.status ?? 'not_started',
      progressPercent: inlineDraft.progressPercent ?? 0,
      sortOrder: inlineDraft.sortOrder ?? 0,
      depth: draftDepth,
      hasChildren: false,
      createdAt: '',
      updatedAt: ''
    }
    insertProjectTaskTreeRow(tree, draftRow, inlineDraft.parentTaskId, inlineDraft.sortOrder ?? 0)
    return tree
  }, [draftDepth, inlineDraft, inlineEditingId, tasks])
  useEffect(() => {
    const parentTaskIds = tasks.filter((task) => task.hasChildren).map((task) => task.id)
    setExpandedTaskKeys((current) => {
      const next = current.filter((id) => parentTaskIds.includes(id))
      if (!current.length) return parentTaskIds
      if (inlineDraft?.parentTaskId && !next.includes(inlineDraft.parentTaskId)) next.push(inlineDraft.parentTaskId)
      return next
    })
  }, [inlineDraft?.parentTaskId, tasks])
  useEffect(() => {
    movingTaskRef.current = movingTask
  }, [movingTask])
  const startInlineEdit = (task: ProjectPlanTask): void => {
    if (inlineEditingId || inlineSaving) return
    setDeleteConfirmId(null)
    setInlineEditingId(task.id)
    setInlineDraft(projectTaskInputFromTask(task))
  }
  const startNewTask = (parentTaskId?: string): void => {
    if (inlineEditingId || inlineSaving) return
    const parentTask = parentTaskId ? taskById.get(parentTaskId) : undefined
    const today = new Date().toISOString().slice(0, 10)
    setDeleteConfirmId(null)
    setInlineEditingId(newProjectTaskRowId)
    setInlineDraft({
      taskType: 'task',
      title: '',
      description: '',
      parentTaskId,
      startDate: parentTask?.startDate ?? today,
      endDate: parentTask?.endDate ?? parentTask?.startDate ?? today,
      status: 'not_started',
      progressPercent: 0,
      sortOrder: parentTaskId ? tasks.filter((task) => task.parentTaskId === parentTaskId).length : tasks.length
    })
  }
  const cancelInlineEdit = (): void => {
    if (inlineSaving) return
    setInlineEditingId(null)
    setInlineDraft(null)
  }
  const updateInlineDraft = <K extends keyof ProjectPlanTaskInput>(key: K, value: ProjectPlanTaskInput[K]): void => {
    setInlineDraft((current) => current ? { ...current, [key]: value } : current)
  }
  const saveInlineEdit = async (): Promise<void> => {
    if (!inlineEditingId || !inlineDraft || inlineSaving) return
    setInlineSaving(true)
    try {
      if (inlineEditingId === newProjectTaskRowId) await onCreate(inlineDraft)
      else await onUpdate(inlineEditingId, inlineDraft)
      cancelInlineEdit()
    } catch {
      // The parent displays the API error and keeps the row in edit mode for correction.
    } finally {
      setInlineSaving(false)
    }
  }
  const requestDelete = async (id: string): Promise<void> => {
    if (deletingId) return
    if (deleteConfirmId !== id) {
      setDeleteConfirmId(id)
      return
    }
    setDeletingId(id)
    try {
      await onDelete(id)
      setDeleteConfirmId(null)
    } finally {
      setDeletingId(null)
    }
  }
  const getDropPositionFromBounds = (bounds: DOMRect, clientY: number): ProjectTaskDropPosition => {
    const ratio = bounds.height ? (clientY - bounds.top) / bounds.height : 0.5
    if (ratio < 0.3) return 'before'
    if (ratio > 0.7) return 'after'
    return 'inside'
  }
  const getTaskRowAtPoint = (clientX: number, clientY: number): { element: HTMLTableRowElement; row: ProjectPlanTask } | null => {
    const element = document.elementFromPoint(clientX, clientY)
    const rowElement = element?.closest<HTMLTableRowElement>('.project-plan-table-card .ant-table-tbody > tr.ant-table-row')
    const taskId = rowElement?.getAttribute('data-row-key')
    const row = taskId ? taskById.get(taskId) : undefined
    return rowElement && row ? { element: rowElement, row } : null
  }
  const clearDragState = (): void => {
    setDraggingTaskId(null)
    setDropTarget(null)
  }
  const moveTaskToTarget = async (sourceId: string, targetId: string, position: ProjectTaskDropPosition): Promise<void> => {
    if (sourceId === targetId || movingTaskRef.current) return
    const target = taskById.get(targetId)
    if (!target || target.id === newProjectTaskRowId) return
    const sourceDescendants = getProjectTaskDescendantIds(tasks, sourceId)
    if (sourceDescendants.has(target.id)) return
    const targetParentTaskId = position === 'inside' ? target.id : target.parentTaskId
    const siblings = tasks.filter((task) => (task.parentTaskId ?? '') === (targetParentTaskId ?? '') && task.id !== sourceId)
    const targetIndex = position === 'inside'
      ? siblings.length
      : Math.max(0, siblings.findIndex((task) => task.id === target.id) + (position === 'after' ? 1 : 0))
    setMovingTask(true)
    movingTaskRef.current = true
    try {
      await onMove(sourceId, { parentTaskId: targetParentTaskId, sortOrder: targetIndex })
    } catch {
      // The parent displays the API error; reset the drag state so another move can be attempted.
    } finally {
      movingTaskRef.current = false
      setMovingTask(false)
      clearDragState()
    }
  }
  const moveTaskToRoot = async (sourceId: string): Promise<void> => {
    if (!taskById.has(sourceId) || movingTaskRef.current) return
    const rootTasks = tasks.filter((task) => !task.parentTaskId && task.id !== sourceId)
    setMovingTask(true)
    movingTaskRef.current = true
    try {
      await onMove(sourceId, { sortOrder: rootTasks.length })
    } catch {
      // The parent displays the API error; reset the drag state so another move can be attempted.
    } finally {
      movingTaskRef.current = false
      setMovingTask(false)
      clearDragState()
    }
  }
  const startPointerTaskDrag = (event: React.PointerEvent<HTMLButtonElement>, row: ProjectTaskTreeRow): void => {
    if (event.button !== 0 || row.id === newProjectTaskRowId || inlineEditingId || movingTask) return
    event.preventDefault()
    event.stopPropagation()
    taskPointerDragRef.current = {
      pointerId: event.pointerId,
      taskId: row.id,
      startX: event.clientX,
      startY: event.clientY,
      active: false
    }
  }
  const finishPointerTaskDragAtPoint = (pointerId: number, clientX: number, clientY: number, captureTarget?: HTMLElement): void => {
    const pending = taskPointerDragRef.current
    if (!pending || pending.pointerId !== pointerId) return
    taskPointerDragRef.current = null
    if (captureTarget?.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId)
    if (!pending.active) {
      if (draggingTaskId === pending.taskId) clearDragState()
      return
    }
    const target = getTaskRowAtPoint(clientX, clientY)
    const rootDropZone = document.elementFromPoint(clientX, clientY)?.closest('.project-plan-root-drop-zone')
    const invalidTarget = target && (target.row.id === pending.taskId || getProjectTaskDescendantIds(tasks, pending.taskId).has(target.row.id))
    if (target && !invalidTarget) {
      void moveTaskToTarget(pending.taskId, target.row.id, getDropPositionFromBounds(target.element.getBoundingClientRect(), clientY))
    } else if (rootDropZone) {
      void moveTaskToRoot(pending.taskId)
    } else {
      clearDragState()
    }
  }
  const finishPointerTaskDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    finishPointerTaskDragAtPoint(event.pointerId, event.clientX, event.clientY, event.currentTarget)
  }
  const cancelPointerTaskDragAtPoint = (pointerId: number, captureTarget?: HTMLElement): void => {
    const pending = taskPointerDragRef.current
    if (!pending || pending.pointerId !== pointerId) return
    taskPointerDragRef.current = null
    if (captureTarget?.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId)
    clearDragState()
  }
  const cancelPointerTaskDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    cancelPointerTaskDragAtPoint(event.pointerId, event.currentTarget)
  }
  useEffect(() => {
    const updateDragAtPoint = (clientX: number, clientY: number, pointerId?: number): void => {
      const pending = taskPointerDragRef.current
      if (!pending || (pointerId !== undefined && pending.pointerId !== pointerId) || movingTaskRef.current) return
      if (!pending.active) {
        const distance = Math.hypot(clientX - pending.startX, clientY - pending.startY)
        if (distance < 6) return
        pending.active = true
        setDraggingTaskId(pending.taskId)
        setDropTarget(null)
      }
      const target = getTaskRowAtPoint(clientX, clientY)
      if (!target || target.row.id === pending.taskId || getProjectTaskDescendantIds(tasks, pending.taskId).has(target.row.id)) {
        setDropTarget(null)
        return
      }
      const position = getDropPositionFromBounds(target.element.getBoundingClientRect(), clientY)
      setDropTarget((current) => current?.taskId === target.row.id && current.position === position ? current : { taskId: target.row.id, position })
    }
    const handlePointerMove = (event: PointerEvent): void => {
      const pending = taskPointerDragRef.current
      if (!pending || pending.pointerId !== event.pointerId || movingTaskRef.current) return
      event.preventDefault()
      updateDragAtPoint(event.clientX, event.clientY, event.pointerId)
    }
    const handleMouseMove = (event: MouseEvent): void => {
      if (!taskPointerDragRef.current || movingTaskRef.current) return
      event.preventDefault()
      updateDragAtPoint(event.clientX, event.clientY)
    }
    const handlePointerUp = (event: PointerEvent): void => {
      if (!taskPointerDragRef.current || taskPointerDragRef.current.pointerId !== event.pointerId) return
      event.preventDefault()
      finishPointerTaskDragAtPoint(event.pointerId, event.clientX, event.clientY)
    }
    const handleMouseUp = (event: MouseEvent): void => {
      const pending = taskPointerDragRef.current
      if (!pending) return
      event.preventDefault()
      finishPointerTaskDragAtPoint(pending.pointerId, event.clientX, event.clientY)
    }
    const handlePointerCancel = (event: PointerEvent): void => {
      cancelPointerTaskDragAtPoint(event.pointerId)
    }
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('mousemove', handleMouseMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp, { passive: false })
    window.addEventListener('mouseup', handleMouseUp, { passive: false })
    window.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [taskById, tasks])
  const header = (key: ProjectTaskColumnKey): (() => ResizableHeaderCellProps) => () => ({
    width: widths[key], columnKey: key, columnLabel: projectTaskColumnLabels[key], minWidth: projectTaskColumnMinWidths[key], maxWidth: projectTaskColumnMaxWidths[key],
    onResize: (value: number) => resize(key, value), onResizeEnd: (value: number) => commitResize(key, value)
  })
  const columns: TableColumnsType<ProjectTaskTreeRow> = [
    {
      title: '计划项',
      dataIndex: 'title',
      width: widths.title,
      ellipsis: true,
      onHeaderCell: header('title'),
      render: (value: string, row) => inlineEditingId === row.id && inlineDraft
        ? <div className="project-task-title-cell is-editing"><Input size="small" value={inlineDraft.title} onChange={(event) => updateInlineDraft('title', event.target.value)} onPressEnter={() => void saveInlineEdit()} placeholder="计划项名称" aria-label="计划项名称" /><Input.TextArea size="small" autoSize={{ minRows: 1, maxRows: 2 }} value={inlineDraft.description} onChange={(event) => updateInlineDraft('description', event.target.value)} placeholder="计划说明（可选）" aria-label="计划说明" /></div>
        : <div className="project-task-title-cell"><div className="project-task-title-line"><button type="button" className="project-task-drag-handle" draggable={false} aria-label={`拖拽移动任务：${value}`} title="拖拽调整层级和顺序" onPointerDown={(event) => startPointerTaskDrag(event, row)} onPointerUp={finishPointerTaskDrag} onPointerCancel={cancelPointerTaskDrag}><HolderOutlined aria-hidden="true" /></button><Text strong>{value}</Text></div>{row.description && <Text type="secondary" ellipsis>{row.description}</Text>}</div>
    },
    {
      title: '类型',
      dataIndex: 'taskType',
      width: widths.type,
      onHeaderCell: header('type'),
      render: (value: ProjectPlanTaskType, row) => inlineEditingId === row.id && inlineDraft
        ? <Select size="small" value={inlineDraft.taskType} options={projectTaskTypeOptions} onChange={(next) => updateInlineDraft('taskType', next as ProjectPlanTaskType)} aria-label="计划项类型" />
        : <Tag color={projectTaskTypeMeta[value].color}>{projectTaskTypeMeta[value].label}</Tag>
    },
    {
      title: '计划周期',
      key: 'period',
      width: widths.period,
      onHeaderCell: header('period'),
      render: (_value, row) => inlineEditingId === row.id && inlineDraft
        ? <div className="project-task-period-editor"><Input size="small" type="date" value={inlineDraft.startDate} disabled={row.hasChildren} onChange={(event) => updateInlineDraft('startDate', event.target.value)} aria-label="开始时间" /><span aria-hidden="true">至</span><Input size="small" type="date" value={inlineDraft.endDate} disabled={row.hasChildren} onChange={(event) => updateInlineDraft('endDate', event.target.value)} aria-label="结束时间" /></div>
        : <span className="project-nowrap">{formatDate(row.startDate)} 至 {formatDate(row.endDate)}</span>
    },
    {
      title: '负责人',
      dataIndex: 'ownerName',
      width: widths.owner,
      ellipsis: true,
      onHeaderCell: header('owner'),
      render: (value: string | undefined, row) => inlineEditingId === row.id && inlineDraft
        ? <Select size="small" allowClear showSearch optionFilterProp="label" value={inlineDraft.ownerPersonId} placeholder="未指定" options={organizationPeople.map((person) => ({ value: person.id, label: `${person.name}${person.department ? ` · ${person.department}` : ''}` }))} onChange={(next) => updateInlineDraft('ownerPersonId', next || undefined)} aria-label="负责人" />
        : value || <Text type="secondary">未指定</Text>
    },
    {
      title: '完成状态',
      dataIndex: 'status',
      width: widths.status,
      onHeaderCell: header('status'),
      render: (value: ProjectPlanTaskStatus, row) => inlineEditingId === row.id && inlineDraft
        ? <Select size="small" value={inlineDraft.status} options={projectTaskStatusOptions} onChange={(next) => updateInlineDraft('status', next as ProjectPlanTaskStatus)} aria-label="完成状态" />
        : <Tag color={projectTaskStatusMeta[value].color}>{projectTaskStatusMeta[value].label}</Tag>
    },
    {
      title: '完成度',
      dataIndex: 'progressPercent',
      width: widths.progress,
      onHeaderCell: header('progress'),
      render: (value: number, row) => inlineEditingId === row.id && inlineDraft
        ? <InputNumber size="small" min={0} max={100} precision={0} value={inlineDraft.progressPercent} onChange={(next) => updateInlineDraft('progressPercent', Number(next ?? 0))} aria-label="完成度" style={{ width: '100%' }} />
        : <span className="project-inline-quantity"><strong>{formatPercent(value)}</strong></span>
    },
    {
      title: '操作',
      key: 'action',
      width: widths.action,
      fixed: 'right',
      onHeaderCell: header('action'),
      render: (_value, row) => {
        const isEditing = inlineEditingId === row.id && Boolean(inlineDraft)
        const isNewRow = row.id === newProjectTaskRowId
        const isDeletePending = deleteConfirmId === row.id
        return <Space size={0} className="project-task-actions">
          {isEditing
            ? <><Button type="link" size="small" loading={inlineSaving} onClick={() => void saveInlineEdit()}>保存</Button><Button type="link" size="small" disabled={inlineSaving} onClick={cancelInlineEdit}>取消</Button></>
            : !isNewRow && <Button type="link" size="small" icon={<EditOutlined />} aria-label={`编辑任务：${row.title}`} onClick={() => startInlineEdit(row)}>编辑</Button>}
          {!isNewRow && !isEditing && <Button type="link" size="small" icon={<PlusOutlined />} aria-label={`为任务${row.title}新增子任务`} onClick={() => startNewTask(row.id)}>子任务</Button>}
          {!isNewRow && !isEditing && (isDeletePending
            ? <><Button type="link" danger size="small" loading={deletingId === row.id} onClick={() => void requestDelete(row.id)}>确认删除</Button><Button type="link" size="small" disabled={Boolean(deletingId)} onClick={() => setDeleteConfirmId(null)}>取消</Button></>
            : <Button type="link" danger size="small" icon={<DeleteOutlined />} aria-label={`删除任务：${row.title}`} onClick={() => void requestDelete(row.id)}>删除</Button>)}
        </Space>
      }
    }
  ]
  const taskRowClassName = (row: ProjectTaskTreeRow): string => [
    row.id === newProjectTaskRowId ? 'project-plan-new-row' : '',
    row.id === draggingTaskId ? 'is-dragging' : '',
    dropTarget?.taskId === row.id ? `is-drop-${dropTarget.position}` : ''
  ].filter(Boolean).join(' ')
  return (
    <div className="project-plan-stack">
      <div className="project-plan-summary">
        <div><Text type="secondary">计划项</Text><strong>{tasks.length}</strong><Text type="secondary">项</Text></div>
        <div><Text type="secondary">已完成</Text><strong className="is-success">{completed}</strong><Text type="secondary">项</Text></div>
        <div><Text type="secondary">进行中</Text><strong className="is-accent">{inProgress}</strong><Text type="secondary">项</Text></div>
        <div><Text type="secondary">阻塞</Text><strong className={blocked ? 'is-danger' : ''}>{blocked}</strong><Text type="secondary">项</Text></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => startNewTask()} disabled={Boolean(inlineEditingId)}>新增计划项</Button>
      </div>
      <Card className="project-table-card project-plan-table-card">
        <div className="project-plan-section-heading"><div><Title level={4}>里程碑 / 任务列表</Title><Text type="secondary">拖拽任务到其他行上方、下方或行内可调整顺序和层级；日期、负责人、状态等字段可直接编辑</Text></div></div>
        {draggingTaskId && <div className="project-plan-root-drop-zone"><HolderOutlined /> 拖到这里移动到顶层</div>}
        {displayTree.length ? <Table<ProjectTaskTreeRow> rowKey="id" loading={loading} dataSource={displayTree} columns={columns} expandable={{ expandedRowKeys: expandedTaskKeys, onExpand: (expanded, row) => setExpandedTaskKeys((current) => expanded ? [...new Set([...current, row.id])] : current.filter((id) => id !== row.id)), childrenColumnName: 'children', indentSize: 18 }} scroll={{ x: Object.values(widths).reduce((sum, width) => sum + width, 0), y: projectDetailTableScrollY }} pagination={inlineEditingId === newProjectTaskRowId ? false : { pageSize: 10, showTotal: (count) => `共 ${count} 项` }} rowClassName={taskRowClassName} /> : <Empty description="尚未建立项目计划" />}
      </Card>
      <div className="project-gantt-stack">
        <ProjectTaskGantt tasks={tasks} />
        <ProjectResourceGantt participants={participants} />
      </div>
    </div>
  )
}

function ProjectDetail({
  project,
  progress,
  onBack,
  onChanged,
  onDeleted
}: {
  project: ManagedProject
  progress: ProjectAnalysisProgress | null
  onBack: () => void
  onChanged: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [current, setCurrent] = useState(project)
  const [requirements, setRequirements] = useState<ProjectRequirement[]>([])
  const [requirementsTotal, setRequirementsTotal] = useState(0)
  const [requirementPage, setRequirementPage] = useState(1)
  const [requirementPageSize, setRequirementPageSize] = useState(20)
  const [costs, setCosts] = useState<ProjectCostEntry[]>([])
  const [assets, setAssets] = useState<ProjectAsset[]>([])
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  const [tasks, setTasks] = useState<ProjectPlanTask[]>([])
  const [organizationPeople, setOrganizationPeople] = useState<OrganizationPerson[]>([])
  const [records, setRecords] = useState<RecordRow[]>([])
  const [recordTotal, setRecordTotal] = useState(0)
  const [recordSearch, setRecordSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [assetModalOpen, setAssetModalOpen] = useState(false)
  const [costModalOpen, setCostModalOpen] = useState(false)
  const [editingCost, setEditingCost] = useState<ProjectCostEntry | null>(null)
  const [matchRequirement, setMatchRequirement] = useState<ProjectRequirement | null>(null)
  const [recordDetail, setRecordDetail] = useState<RecordDetail | null>(null)
  const [documentPreviewOpen, setDocumentPreviewOpen] = useState(false)
  const [documentPreview, setDocumentPreview] = useState<KnowledgeDocumentPreview | null>(null)
  const [documentPreviewLoading, setDocumentPreviewLoading] = useState(false)
  const [documentPreviewError, setDocumentPreviewError] = useState('')
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [participantModalOpen, setParticipantModalOpen] = useState(false)
  const [editingParticipant, setEditingParticipant] = useState<ProjectParticipant | null>(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [editForm] = Form.useForm<ManagedProjectInput>()
  const [costForm] = Form.useForm<ProjectCostEntryInput>()
  const [participantForm] = Form.useForm<ProjectParticipantInput>()

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextProject, requirementPageResult, nextCosts, nextAssets, nextParticipants, nextTasks] = await Promise.all([
        window.visslm.getManagedProject(project.id),
        window.visslm.listProjectRequirements({ projectId: project.id, page: requirementPage, pageSize: requirementPageSize }),
        window.visslm.listProjectCostEntries(project.id),
        window.visslm.listProjectAssets(project.id),
        window.visslm.listProjectParticipants(project.id),
        window.visslm.listProjectTasks(project.id)
      ])
      if (nextProject) setCurrent(nextProject)
      setRequirements(requirementPageResult.rows)
      setRequirementsTotal(requirementPageResult.total)
      setMatchRequirement((selected) => {
        if (!selected) return selected
        return requirementPageResult.rows.find((item) => item.id === selected.id) ?? selected
      })
      setCosts(nextCosts)
      setAssets(nextAssets)
      setParticipants(nextParticipants)
      setTasks(nextTasks)
    } finally {
      setLoading(false)
    }
  }, [project.id, requirementPage, requirementPageSize])

  useEffect(() => {
    void reload()
  }, [reload, progress?.taskId, progress?.phase])

  useEffect(() => {
    if (!participantModalOpen && !editModalOpen && activeTab !== 'plan') return
    void window.visslm.listOrganizationPeople({ page: 1, pageSize: 100 }).then((result) => setOrganizationPeople(result.rows))
  }, [activeTab, editModalOpen, participantModalOpen])

  const saveProject = async (values: ManagedProjectInput): Promise<void> => {
    const updated = await window.visslm.updateManagedProject(current.id, values)
    if (updated) {
      setCurrent(updated)
      setEditModalOpen(false)
      message.success('项目基本信息已保存')
      onChanged()
    }
  }

  const exportCurrentProject = async (): Promise<void> => {
    try {
      const result = await window.visslm.exportManagedProjectData(current.id)
      if (result.canceled) return
      if (!result.ok) {
        message.error(result.message)
        return
      }
      message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '项目完整数据导出失败')
    }
  }

  const deleteCurrentProject = (): void => {
    modal.confirm({
      title: '确认删除项目？',
      icon: <WarningOutlined />,
      content: `将删除“${current.projectName}”及其需求、匹配、成本、资产关联、参与人员和项目计划，且无法恢复。共享数据中心记录和知识库文档不会删除。`,
      okText: '删除项目',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const result = await window.visslm.deleteManagedProject(current.id)
          if (!result.ok) {
            message.error(result.message)
            return
          }
          message.success(result.message)
          onDeleted()
        } catch (error) {
          message.error(error instanceof Error ? error.message : '项目删除失败')
        }
      }
    })
  }

  const confirmProject = async (): Promise<void> => {
    const confirmed = await window.visslm.confirmManagedProject(current.id)
    if (confirmed) {
      setCurrent(confirmed)
      message.success('项目已确认，匹配任务已启动')
      onChanged()
    }
  }

  const uploadAgreement = async (): Promise<void> => {
    const result = await window.visslm.startProjectTechnicalAgreementUpload(current.id)
    if (result.canceled) return
    if (!result.ok) {
      message.error(result.message)
      return
    }
    message.success('技术协议已加入处理队列')
    onChanged()
  }

  const retryAnalysis = (): void => {
    modal.confirm({
      title: '确认重新执行识别？',
      icon: <WarningOutlined />,
      content: `重新执行将删除当前已识别的 ${current.requirementCount} 条功能需求、关键功能信息词及匹配结果，此操作不可恢复。确认继续吗？`,
      okText: '确认重新执行',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await window.visslm.retryProjectAnalysis(current.id)
        if (!result.ok) {
          message.error(result.message)
          return
        }
        message.success(result.message)
        onChanged()
      }
    })
  }

  const startMatching = async (): Promise<void> => {
    const result = await window.visslm.startProjectMatching(current.id)
    if (!result.ok) message.error(result.message)
    else message.success(result.message)
  }

  const saveRequirementKeyInfoTerms = async (id: string, terms: string[]): Promise<void> => {
    const updated = await window.visslm.updateProjectRequirementKeyInfoTerms(id, terms)
    if (!updated) {
      message.error('关键功能信息词保存失败')
      return
    }
    setMatchRequirement((selected) => selected?.id === id ? updated : selected)
    const result = await window.visslm.startProjectRequirementMatching(id)
    if (!result.ok) {
      message.error(result.message)
      await reload()
      return
    }
    message.success('关键功能信息词已保存，正在重新识别匹配度')
    await reload()
    onChanged()
  }

  const updateRequirementStatus = async (id: string, status: ProjectRequirementStatus): Promise<void> => {
    await window.visslm.updateProjectRequirementStatus(id, status)
    await reload()
    onChanged()
  }

  const deleteRequirement = async (id: string): Promise<void> => {
    try {
      const result = await window.visslm.deleteProjectRequirement(id)
      if (!result.ok) {
        message.warning(result.message)
        return
      }
      setMatchRequirement((selected) => selected?.id === id ? null : selected)
      if (requirements.length === 1 && requirementPage > 1) {
        setRequirementPage((page) => page - 1)
      } else {
        await reload()
      }
      onChanged()
      message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除功能需求失败')
    }
  }

  const openCostEditor = (entry?: ProjectCostEntry): void => {
    setEditingCost(entry ?? null)
    setCostModalOpen(true)
  }

  const saveCost = async (values: ProjectCostEntryInput): Promise<void> => {
    try {
      if (editingCost) await window.visslm.updateProjectCostEntry(editingCost.id, values)
      else await window.visslm.addProjectCostEntry(current.id, values)
      setCostModalOpen(false)
      await reload()
      onChanged()
      message.success(editingCost ? '成本明细已更新' : '成本明细已添加')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存成本明细失败')
    }
  }

  const deleteCost = async (id: string): Promise<void> => {
    const result = await window.visslm.deleteProjectCostEntry(id)
    if (result.ok) {
      await reload()
      onChanged()
      message.success(result.message)
    }
  }

  const loadRecords = async (): Promise<void> => {
    const result = await window.visslm.listRecords({ page: 1, pageSize: 50, search: recordSearch })
    setRecords(result.rows)
    setRecordTotal(result.total)
  }

  const linkAsset = async (recordUid: string): Promise<void> => {
    const linked = await window.visslm.linkProjectAsset(current.id, recordUid)
    if (linked) {
      await reload()
      message.success('已关联项目资产')
      onChanged()
    }
  }

  const unlinkAsset = async (recordUid: string): Promise<void> => {
    const result = await window.visslm.unlinkProjectAsset(current.id, recordUid)
    if (result.ok) {
      await reload()
      message.success(result.message)
      onChanged()
    }
  }

  const openParticipantEditor = (participant?: ProjectParticipant): void => {
    setEditingParticipant(participant ?? null)
    participantForm.setFieldsValue(participant
      ? { personId: participant.personId, startDate: participant.startDate, endDate: participant.endDate, notes: participant.notes }
      : { startDate: new Date().toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10), notes: '' })
    setParticipantModalOpen(true)
  }

  const saveParticipant = async (values: ProjectParticipantInput): Promise<void> => {
    try {
      if (editingParticipant) await window.visslm.updateProjectParticipant(editingParticipant.id, values)
      else await window.visslm.addProjectParticipant(current.id, values)
      setParticipantModalOpen(false)
      await reload()
      onChanged()
      message.success(editingParticipant ? '项目参与人员已更新' : '项目参与人员已绑定')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存项目参与人员失败')
    }
  }

  const deleteParticipant = async (id: string): Promise<void> => {
    try {
      const result = await window.visslm.deleteProjectParticipant(id)
      if (!result.ok) {
        message.warning(result.message)
        return
      }
      await reload()
      onChanged()
      message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '移除项目参与人员失败')
    }
  }

  const createTaskFromList = async (input: ProjectPlanTaskInput): Promise<void> => {
    try {
      const created = await window.visslm.addProjectTask(current.id, input)
      if (!created) throw new Error('项目计划项创建失败')
      await reload()
      onChanged()
      message.success('项目计划项已添加')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存项目计划项失败')
      throw error
    }
  }

  const updateTaskFromList = async (id: string, input: ProjectPlanTaskInput): Promise<void> => {
    try {
      const updated = await window.visslm.updateProjectTask(id, input)
      if (!updated) throw new Error('项目计划项不存在')
      await reload()
      onChanged()
      message.success('项目计划项已更新')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存项目计划项失败')
      throw error
    }
  }

  const moveTaskFromList = async (id: string, input: ProjectPlanTaskMoveInput): Promise<void> => {
    try {
      const moved = await window.visslm.moveProjectTask(id, input)
      if (!moved) throw new Error('项目计划项不存在')
      await reload()
      onChanged()
      message.success('项目计划层级和顺序已更新')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '移动项目计划项失败')
      throw error
    }
  }

  const deleteTask = async (id: string): Promise<void> => {
    try {
      const result = await window.visslm.deleteProjectTask(id)
      if (!result.ok) {
        message.warning(result.message)
        return
      }
      await reload()
      onChanged()
      message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除项目计划项失败')
    }
  }

  const openRecord = async (uid: string): Promise<void> => {
    setRecordDetail(await window.visslm.getRecord(uid))
  }

  const openDocumentPreview = async (): Promise<void> => {
    const documentId = current.currentDocumentId?.trim()
    if (!documentId) {
      message.warning('当前项目没有可预览的协议附件')
      return
    }
    setDocumentPreviewOpen(true)
    setDocumentPreviewLoading(true)
    setDocumentPreview(null)
    setDocumentPreviewError('')
    try {
      const preview = await window.visslm.getKnowledgeDocumentPreview(documentId)
      if (!preview) throw new Error('协议附件记录不存在，可能已被删除')
      setDocumentPreview(preview)
      setDocumentPreviewError(preview.errorMessage ?? '')
    } catch (error) {
      setDocumentPreviewError(error instanceof Error ? error.message : '协议附件加载失败')
    } finally {
      setDocumentPreviewLoading(false)
    }
  }

  const projectProgress = progress?.projectId === current.id ? progress : null
  const isProcessing = current.analysisStatus === 'processing' || current.matchStatus === 'processing'
  const isFailed = current.analysisStatus === 'failed' || current.matchStatus === 'failed'
  const analysisPhase = projectProgress?.phase
    ?? (current.matchStatus === 'processing' ? 'matching' : current.analysisStatus === 'processing' ? 'embedding' : current.analysisStatus === 'ready' && current.matchStatus === 'ready' ? 'done' : 'queued')
  const activeStageIndex = analysisPhaseIndex[analysisPhase]
  const analysisPhaseProgress: Record<ProjectAnalysisProgress['phase'], number> = {
    queued: 8,
    parsing: 18,
    embedding: 35,
    extracting: 58,
    matching: 78,
    done: 100,
    error: 0
  }
  const progressPercent = projectProgress?.total && projectProgress.current > 0
    ? Math.min(99, Math.round((projectProgress.current / projectProgress.total) * 100))
    : isProcessing ? analysisPhaseProgress[analysisPhase] : current.analysisStatus === 'ready' && current.matchStatus === 'ready' ? 100 : 0
  const technicalIndicatorMatchPercent = current.requirementCount ? (current.satisfiedCount / current.requirementCount) * 100 : 0
  const coveragePercent = technicalIndicatorMatchPercent
  const delivery = deliveryHint(current)
  const risk = projectRiskMeta(current)
  const estimatedCostPercent = current.contractAmount > 0 ? (current.estimatedCost / current.contractAmount) * 100 : 0
  const actualCostPercent = current.contractAmount > 0 ? (current.actualCost / current.contractAmount) * 100 : 0
  const remainingQuotaPercent = current.contractAmount > 0 ? (current.remainingQuota / current.contractAmount) * 100 : 0
  const documentStatus = projectProgress?.message || current.analysisMessage || current.matchMessage || (current.currentDocumentName ? '技术协议已建立索引' : '尚未上传技术协议')

  return (
    <div className="project-detail-page page-stack">
      <div className="project-detail-breadcrumb">
        <Text>项目管理</Text>
        <span aria-hidden="true">›</span>
        <Text type="secondary">项目详情</Text>
      </div>
      <div className="project-detail-toolbar">
        <Button className="project-back-button" icon={<ArrowLeftOutlined />} onClick={onBack}>返回项目列表</Button>
        <Space wrap className="project-detail-actions">
          {current.lifecycle === 'draft' && <Button type="primary" icon={<CheckCircleOutlined />} disabled={isProcessing} onClick={() => void confirmProject()}>确认创建并匹配</Button>}
          {current.lifecycle === 'active' && <Button type="primary" icon={<SyncOutlined />} disabled={isProcessing} onClick={() => void startMatching()}>重新匹配</Button>}
          <Button icon={<UploadOutlined />} disabled={isProcessing} onClick={() => void uploadAgreement()}>{isProcessing ? '正在处理协议' : '上传协议附件'}</Button>
          {current.analysisStatus === 'failed' && <Button icon={<ReloadOutlined />} onClick={() => void retryAnalysis()}>重试分析</Button>}
          <Button icon={<EditOutlined />} disabled={isProcessing} onClick={() => setEditModalOpen(true)}>编辑项目</Button>
          <Button icon={<ExportOutlined />} onClick={() => void exportCurrentProject()}>导出完整数据</Button>
          <Dropdown
            menu={{
              items: [
                { key: 'knowledge', label: '查看技术协议', icon: <FileTextOutlined />, onClick: () => setActiveTab('knowledge') },
                { key: 'requirements', label: '查看功能需求', icon: <FileSearchOutlined />, onClick: () => setActiveTab('requirements') },
                { key: 'assets', label: '查看项目资产', icon: <DatabaseOutlined />, onClick: () => setActiveTab('assets') },
                { type: 'divider' },
                { key: 'delete', label: '删除项目', icon: <DeleteOutlined />, danger: true, disabled: isProcessing, onClick: deleteCurrentProject }
              ]
            }}
            trigger={['click']}
          >
            <Button className="project-more-button" icon={<MoreOutlined />} disabled={isProcessing} aria-label="更多操作">更多操作</Button>
          </Dropdown>
        </Space>
      </div>

      <div className="project-detail-heading project-command-heading">
        <div className="project-heading-main">
          <div className="project-heading-title-row">
            <Title level={2}>{current.projectName}</Title>
            <div
              className="project-status-capsule project-technical-match-capsule"
              aria-label={`技术指标匹配度 ${formatPercent(technicalIndicatorMatchPercent)}，已满足 ${current.satisfiedCount} / ${current.requirementCount} 项`}
            >
              <CheckCircleOutlined />
              <span>技术指标匹配度</span>
              <strong>{formatPercent(technicalIndicatorMatchPercent)}</strong>
            </div>
            {!isProcessing && !isFailed && current.currentDocumentName && (
              <div
                className="project-status-capsule project-agreement-status-capsule"
                aria-label={`协议识别完成${current.requirementCount ? `，已识别 ${current.requirementCount} 条功能需求` : ''}`}
              >
                <CheckCircleFilled />
                <span>协议识别完成</span>
                {current.requirementCount > 0 && <strong>{current.requirementCount} 条需求</strong>}
              </div>
            )}
            {current.matchStatus === 'ready' && (
              <div className="project-status-capsule project-match-status-capsule" aria-label="匹配已完成">
                <CheckCircleOutlined />
                <span>匹配已完成</span>
              </div>
            )}
            <Tag className="project-status-capsule" color={current.lifecycle === 'active' ? 'processing' : 'purple'}>{current.lifecycle === 'active' ? '执行中' : '待确认'}</Tag>
          </div>
          <div className="project-heading-meta">
            <Text>客户：{current.customerName || '未填写'}</Text>
          </div>
        </div>
        <div className="project-detail-heading-meta">
          {delivery && <Tag className="project-status-capsule" color={delivery.color} icon={<WarningOutlined />}>{delivery.label}</Tag>}
          {current.currentDocumentName && (
            <button
              type="button"
              className="project-document-chip"
              onClick={() => void openDocumentPreview()}
              title={`在线预览：${current.currentDocumentName}`}
              aria-label={`在线预览协议附件：${current.currentDocumentName}`}
            >
              <FileTextOutlined aria-hidden="true" />
              <span>{current.currentDocumentName}</span>
              <EyeOutlined aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {isProcessing && (
        <section className="project-analysis-panel" aria-live="polite">
          <div className="project-analysis-strip">
            <div className="project-analysis-file">
              <div className="project-analysis-file-icon"><FileSearchOutlined /></div>
              <div className="project-analysis-file-copy">
                <Text strong>{current.currentDocumentName || '技术协议处理中'}</Text>
                <Text type="secondary">{documentStatus}</Text>
                <Text className="project-analysis-live-badge"><SyncOutlined spin /> 后台处理中 · 请勿重复上传</Text>
              </div>
            </div>
            <div className="project-analysis-progress-main">
              <Progress
                className="project-analysis-progress-ring"
                type="circle"
                percent={progressPercent}
                size={76}
                strokeWidth={8}
                strokeColor="var(--accent)"
                trailColor="rgba(255, 255, 255, 0.1)"
                format={(percent) => `${percent ?? 0}%`}
                aria-label={`协议处理进度 ${progressPercent}%`}
              />
              <div className="project-analysis-progress-copy">
                <Text type="secondary">{projectProgress ? projectProgress.message : '正在执行协议分析'}</Text>
                <div className="project-analysis-current-step"><Text type="secondary">当前执行</Text><Text strong>{analysisStageMeta[activeStageIndex]?.label || '处理中'}</Text></div>
              </div>
            </div>
            <div className="project-analysis-step-list">
              {analysisStageMeta.map((stage, index) => {
                const complete = index < activeStageIndex
                const active = index === activeStageIndex
                return <div key={stage.phase} className={`project-analysis-step ${complete ? 'is-complete' : active ? 'is-active' : ''}`}>
                  <span className="project-analysis-step-dot">{complete ? <CheckCircleFilled /> : active ? <SyncOutlined spin /> : index + 1}</span>
                  <Text>{stage.label}</Text>
                </div>
              })}
            </div>
            <div className="project-analysis-eta"><Text strong>已完成 {Math.min(activeStageIndex, analysisStageMeta.length - 1)} / {analysisStageMeta.length - 1} 个阶段</Text><Text type="secondary">请勿重复上传</Text></div>
          </div>
          {current.analysisMessage?.includes('重复') && <div className="project-analysis-detail"><InfoCircleOutlined /><Text>检测到重复文件，将复用现有知识库索引并继续后续分析。</Text></div>}
        </section>
      )}

      {isFailed && (
        <div className="project-inline-notice project-inline-notice-error">
          <div className="project-inline-notice-main"><WarningOutlined /><div><Text strong>{documentStatus}</Text><Text type="secondary">处理未完成，请检查技术协议后重试。</Text></div></div>
          <Space>
            <Button type="link" icon={<FileTextOutlined />} onClick={() => setActiveTab('knowledge')}>查看技术协议</Button>
            <Button type="primary" ghost icon={<ReloadOutlined />} onClick={() => void (current.matchStatus === 'failed' ? startMatching() : retryAnalysis())}>重新执行</Button>
          </Space>
        </div>
      )}

      <section className="project-health-strip">
        <div className="project-health-strip-heading">
          <div><Text strong>项目健康概览</Text><Text type="secondary">数据截至 {formatDate(current.updatedAt)}</Text></div>
        </div>
        <div className="project-health-metrics">
          <div className="project-health-metric"><div className="project-health-metric-label"><DollarOutlined /><Text>合同金额</Text></div><strong>{formatAmount(current.contractAmount)}</strong><div className="project-health-track"><span style={{ width: '100%' }} /></div><Text type="secondary">项目合同</Text></div>
          <div className="project-health-metric"><div className="project-health-metric-label"><DollarOutlined /><Text>预计成本</Text></div><strong>{formatAmount(current.estimatedCost)}</strong><div className="project-health-track"><span style={{ width: `${Math.max(0, Math.min(100, estimatedCostPercent))}%` }} /></div><Text type="secondary">{current.laborEstimatedCost > 0 ? `含人力 ${formatAmount(current.laborEstimatedCost)}` : `占合同 ${formatPercent(estimatedCostPercent)}`}</Text></div>
          <div className="project-health-metric"><div className="project-health-metric-label"><DatabaseOutlined /><Text>实际成本</Text></div><strong>{formatAmount(current.actualCost)}</strong><div className="project-health-track"><span className="is-cyan" style={{ width: `${Math.max(0, Math.min(100, actualCostPercent))}%` }} /></div><Text type="secondary">占合同 {formatPercent(actualCostPercent)}</Text></div>
          <div className="project-health-metric"><div className="project-health-metric-label"><SafetyCertificateOutlined /><Text>剩余额度</Text></div><strong className={current.remainingQuota < 0 ? 'is-danger' : ''}>{formatAmount(current.remainingQuota)}</strong><div className="project-health-track"><span style={{ width: `${Math.max(0, Math.min(100, remainingQuotaPercent))}%` }} /></div><Text type="secondary">可用额度 {formatPercent(remainingQuotaPercent)}</Text></div>
          <div className="project-health-metric project-health-metric-risk"><div className="project-health-metric-label"><ClockCircleOutlined /><Text>交付风险</Text></div><strong className={`project-risk-value ${risk.color}`}>{risk.label}</strong><Text type="secondary">{delivery?.label || '未设置计划交付日期'}</Text></div>
        </div>
      </section>

      <Tabs
        className="project-detail-tabs project-command-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'overview',
            label: '项目概览',
            children: (
              <div className="project-command-workbench">
                <main className="project-command-main">
                  <div className="project-command-section-head">
                    <div><Title level={4}>需求覆盖</Title><Text type="secondary">基于技术协议分析结果</Text></div>
                    <Button type="link" onClick={() => setActiveTab('requirements')}>查看全部需求 <ArrowRightOutlined /></Button>
                  </div>
                  <div className="project-coverage-panel">
                    <div className="project-coverage-score"><Text type="secondary">需求覆盖</Text><strong>{formatPercent(coveragePercent)}</strong><Progress percent={coveragePercent} showInfo={false} size={8} /><Text type="secondary">已覆盖 {current.satisfiedCount} / {current.requirementCount} 条需求</Text></div>
                    <div className="project-coverage-statuses">
                      <div><span className="project-status-dot is-neutral" /><Text>未标记</Text><strong>{current.unmarkedCount}</strong><Text type="secondary">条</Text></div>
                      <div><span className="project-status-dot is-green" /><Text>已满足</Text><strong>{current.satisfiedCount}</strong><Text type="secondary">条</Text></div>
                      <div><span className="project-status-dot is-blue" /><Text>待开发</Text><strong>{current.toDevelopCount}</strong><Text type="secondary">条</Text></div>
                      <div><span className="project-status-dot is-orange" /><Text>待协商</Text><strong>{current.toNegotiateCount}</strong><Text type="secondary">条</Text></div>
                    </div>
                  </div>
                  {!current.requirementCount ? (
                    <div className="project-command-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={current.currentDocumentName ? '技术协议尚未识别出功能需求' : '请先上传技术协议'} /></div>
                  ) : (
                    <div className="project-command-requirement-preview">
                      <div className="project-command-section-head project-preview-head"><div><Text strong>需求预览</Text><Text type="secondary">显示前 5 条需求，点击匹配度查看数据中心结果</Text></div><Text type="secondary">共 {current.requirementCount} 条</Text></div>
                      <ResizableTable<ProjectRequirement>
                        tableKey="project-overview-requirements-v2"
                        rowKey="id"
                        size="small"
                        loading={loading}
                        dataSource={requirements.slice(0, 5)}
                        pagination={false}
                        scroll={{ x: 760, y: projectCompactTableScrollY }}
                        columns={[
                          { title: '需求编号', dataIndex: 'requirementNo', width: 94, render: (value: number) => `REQ-${String(value).padStart(3, '0')}` },
                          { title: '模块', dataIndex: 'module', width: 150, ellipsis: true, render: (value: string) => value || <Text type="secondary">未分类</Text> },
                          { title: '需求描述', key: 'content', width: 300, render: (_value, row) => <div className="project-command-requirement-cell"><Text strong>{row.title}</Text><Text type="secondary">{row.content}</Text></div> },
                          {
                            title: '最高匹配度', dataIndex: 'highestMatchScore', width: 150,
                            render: (value: number, row) => {
                              const scoreLabel = value ? formatPercent(value) : '暂无匹配结果'
                              return (
                                <Tooltip title={`最高匹配度：${scoreLabel}`}>
                                  <Button
                                    type="link"
                                    className="project-command-score"
                                    aria-label={`最高匹配度：${scoreLabel}`}
                                    onClick={() => setMatchRequirement(row)}
                                  >
                                    <Progress percent={value || 0} showInfo={false} size="small" />
                                  </Button>
                                </Tooltip>
                              )
                            }
                          },
                          { title: '状态', dataIndex: 'status', width: 110, render: (value: ProjectRequirementStatus) => { const status = requirementStatusMeta[value]; return <Tag color={status.color}>{status.label}</Tag> } },
                          { title: '操作', key: 'action', width: 92, render: (_value, row) => <Button type="link" size="small" onClick={() => setMatchRequirement(row)}>查看匹配</Button> }
                        ]}
                      />
                    </div>
                  )}
                </main>
                <aside className="project-command-side">
                  <section className="project-side-section">
                    <div className="project-side-heading"><div><Title level={4}>项目基本信息</Title><Text type="secondary">项目责任人与交付约束</Text></div><Button type="link" icon={<EditOutlined />} onClick={() => setEditModalOpen(true)}>编辑</Button></div>
                    <div className="project-fact-list">
                      <div className="project-fact-row"><span><TeamOutlined />客户名称</span><strong>{current.customerName || '未填写'}</strong></div>
                      <div className="project-fact-row"><span><CalendarOutlined />计划交付日期</span><strong>{formatDate(current.plannedDeliveryDate)}{delivery && <em className={`project-fact-hint ${delivery.color}`}>{delivery.label}</em>}</strong></div>
                      <div className="project-fact-row"><span><TeamOutlined />技术负责人</span><strong>{current.technicalOwner || '未填写'}</strong></div>
                      <div className="project-fact-row"><span><TeamOutlined />销售负责人</span><strong>{current.salesOwner || '未填写'}</strong></div>
                      <div className="project-fact-row"><span><TeamOutlined />研发负责人</span><strong>{current.developmentOwner || '未填写'}</strong></div>
                      <div className="project-fact-row"><span><SafetyCertificateOutlined />风险系数</span><strong><Tag color={risk.color}>{risk.label}风险</Tag></strong></div>
                      <div className="project-fact-row"><span><ClockCircleOutlined />预计工期</span><strong>{current.estimatedDurationDays || 0} 天</strong></div>
                    </div>
                  </section>
                  <section className="project-side-section">
                    <div className="project-side-heading"><div><Title level={4}>相关资源</Title><Text type="secondary">当前项目关联数据</Text></div></div>
                    <div className="project-resource-grid">
                      <button type="button" className="project-resource-link" onClick={() => setActiveTab('knowledge')}><FileTextOutlined /><span>协议附件</span><strong>{current.currentDocumentName ? 1 : 0}</strong><ArrowRightOutlined /></button>
                      <button type="button" className="project-resource-link" onClick={() => setActiveTab('requirements')}><FileSearchOutlined /><span>需求条目</span><strong>{current.requirementCount}</strong><ArrowRightOutlined /></button>
                      <button type="button" className="project-resource-link" onClick={() => setActiveTab('costs')}><DollarOutlined /><span>成本明细</span><strong>{costs.length}</strong><ArrowRightOutlined /></button>
                      <button type="button" className="project-resource-link" onClick={() => setActiveTab('assets')}><DatabaseOutlined /><span>项目资产</span><strong>{current.assetCount}</strong><ArrowRightOutlined /></button>
                      <button type="button" className="project-resource-link" onClick={() => setActiveTab('participants')}><TeamOutlined /><span>项目参与人</span><strong>{current.participantCount}</strong><ArrowRightOutlined /></button>
                      <button type="button" className="project-resource-link" onClick={() => setActiveTab('plan')}><CalendarOutlined /><span>项目计划</span><strong>{current.taskCount}</strong><ArrowRightOutlined /></button>
                    </div>
                  </section>
                </aside>
              </div>
            )
          },
          {
            key: 'requirements',
            label: `功能需求 (${current.requirementCount})`,
            children: (
              <div className="project-requirements-stack">
                <div className="project-requirement-stats">
                  <Card className="project-requirement-stat project-requirement-stat-neutral"><Statistic title="未标记" value={current.unmarkedCount} /></Card>
                  <Card className="project-requirement-stat project-requirement-stat-success"><Statistic title="已满足" value={current.satisfiedCount} /></Card>
                  <Card className="project-requirement-stat project-requirement-stat-info"><Statistic title="待开发" value={current.toDevelopCount} /></Card>
                  <Card className="project-requirement-stat project-requirement-stat-warning"><Statistic title="待协商" value={current.toNegotiateCount} /></Card>
                </div>
                {!current.requirementCount ? (
                  <Card><Empty description={current.currentDocumentName ? '技术协议尚未识别出功能需求' : '请先上传技术协议'} /></Card>
                ) : (
                  <Card className="project-table-card">
                    <ResizableTable<ProjectRequirement>
                      tableKey="project-requirements-v2"
                      rowKey="id"
                      loading={loading}
                      dataSource={requirements}
                      scroll={{ x: 1240, y: projectDetailTableScrollY }}
                      pagination={{ current: requirementPage, pageSize: requirementPageSize, total: requirementsTotal, showSizeChanger: true, showTotal: (count) => `共 ${count} 条需求` }}
                      onChange={(pagination: TablePaginationConfig) => {
                        setRequirementPage(pagination.current ?? 1)
                        setRequirementPageSize(pagination.pageSize ?? 20)
                      }}
                      columns={[
                        { title: '#', dataIndex: 'requirementNo', width: 58 },
                        { title: '模块', dataIndex: 'module', width: 170, ellipsis: true, render: (value: string) => value || <Text type="secondary">未分类</Text> },
                        {
                          title: '功能需求', key: 'content', width: 420,
                          render: (_value, row) => <div className="project-requirement-cell"><Text strong>{row.title}</Text><Paragraph ellipsis={{ rows: 2 }}>{row.content}</Paragraph>{row.sourceLocation && <Text type="secondary">来源：{row.sourceLocation}</Text>}</div>
                        },
                        {
                          title: '关键功能信息词', key: 'keyInfoTerms', width: 300,
                          render: (_value, row) => <div className="project-key-info-terms-cell">{row.keyInfoTerms.length ? <Space wrap size={[4, 4]}>{row.keyInfoTerms.slice(0, 6).map((term) => <Tag color="blue" key={term}>{term}</Tag>)}{row.keyInfoTerms.length > 6 && <Tag>+{row.keyInfoTerms.length - 6}</Tag>}</Space> : <Text type="secondary">待提取</Text>}<Text type="secondary">{row.keyInfoTermsSource === 'manual' ? '人工修改' : 'AI 提取'}</Text></div>
                        },
                        {
                          title: '最高匹配度', dataIndex: 'highestMatchScore', width: 150,
                          render: (value: number, row) => <Button type="link" className="project-score-button" onClick={() => setMatchRequirement(row)}>{value ? `${value.toFixed(1)}%` : '暂无结果'} <EyeOutlined /></Button>
                        },
                        {
                          title: '状态', dataIndex: 'status', width: 150,
                          render: (value: ProjectRequirementStatus, row) => <Space direction="vertical" size={2}><Select size="small" value={value} options={Object.entries(requirementStatusMeta).map(([key, item]) => ({ value: key, label: item.label }))} onChange={(next) => void updateRequirementStatus(row.id, next as ProjectRequirementStatus)} /><Text type="secondary">{row.statusSource === 'manual' ? '人工标记' : 'AI 初判'}</Text></Space>
                        },
                        { title: '匹配数据', dataIndex: 'matchCount', width: 100, render: (value: number) => `${value} 条` },
                        {
                          title: '操作', key: 'action', fixed: 'right', width: 230,
                          render: (_value, row) => <Space size={0}>
                            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setMatchRequirement(row)}>查看/编辑匹配词</Button>
                            <Popconfirm
                              title={`确认删除“${row.title}”？`}
                              description="删除后将同时清除该需求的匹配结果，且无法恢复。"
                              okText="删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => void deleteRequirement(row.id)}
                            >
                              <Button type="link" danger size="small" icon={<DeleteOutlined />} aria-label={`删除功能需求：${row.title}`}>删除</Button>
                            </Popconfirm>
                          </Space>
                        }
                      ]}
                    />
                  </Card>
                )}
              </div>
            )
          },
          {
            key: 'participants',
            label: `项目参与人 (${participants.length})`,
            children: (
              <ProjectParticipantsPanel
                participants={participants}
                loading={loading}
                onAdd={() => openParticipantEditor()}
                onEdit={openParticipantEditor}
                onDelete={(id) => void deleteParticipant(id)}
              />
            )
          },
          {
            key: 'plan',
            label: `项目计划 (${tasks.length})`,
            children: (
              <ProjectPlanPanel
                tasks={tasks}
                participants={participants}
                loading={loading}
                onCreate={createTaskFromList}
                onUpdate={updateTaskFromList}
                onMove={moveTaskFromList}
                organizationPeople={organizationPeople}
                onDelete={deleteTask}
              />
            )
          },
          {
            key: 'costs',
            label: `成本台账 (${costs.length})`,
            children: (
              <Card className="project-table-card" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openCostEditor()}>新增成本</Button>}>
                <ResizableTable<ProjectCostEntry>
                  tableKey="project-costs"
                  rowKey="id"
                  dataSource={costs}
                  scroll={{ x: 1160, y: projectDetailTableScrollY }}
                  pagination={{ pageSize: 10, showTotal: (count) => `共 ${count} 条成本明细` }}
                  columns={[
                    { title: '类型', dataIndex: 'type', width: 110, render: (value: ProjectCostEntry['type']) => <Tag color={value === 'estimated' ? 'blue' : 'orange'}>{value === 'estimated' ? '预计' : '实际'}</Tag> },
                    { title: '分类', dataIndex: 'category', width: 160 },
                    { title: '说明', dataIndex: 'description', ellipsis: true },
                    { title: '责任人', dataIndex: 'responsiblePersonName', width: 160, render: (value?: string) => value || <Text type="secondary">未指定</Text> },
                    { title: '金额', dataIndex: 'amount', width: 150, render: (value: number) => formatAmount(value) },
                    { title: '日期', dataIndex: 'occurredAt', width: 130, render: formatDate },
                    { title: '操作', key: 'action', width: 130, render: (_value, row) => <Space size={0}><Button type="link" size="small" icon={<EditOutlined />} onClick={() => openCostEditor(row)}>编辑</Button><Popconfirm title="确认删除这条成本明细？" onConfirm={() => void deleteCost(row.id)}><Button type="link" danger size="small" icon={<DeleteOutlined />}>删除</Button></Popconfirm></Space> }
                  ]}
                />
              </Card>
            )
          },
          {
            key: 'assets',
            label: `项目资产 (${assets.length})`,
            children: (
              <Card className="project-table-card" extra={<Button type="primary" icon={<LinkOutlined />} onClick={() => { setAssetModalOpen(true); void loadRecords() }}>关联数据中心记录</Button>}>
                {assets.length ? <ResizableTable<ProjectAsset> tableKey="project-assets" rowKey="recordUid" dataSource={assets} pagination={{ pageSize: 10 }} scroll={{ x: 800, y: projectDetailTableScrollY }} columns={[{ title: '数据名称', dataIndex: 'name', render: (value: string, row) => <Button type="link" className="project-table-link" onClick={() => void openRecord(row.recordUid)}>{value || row.recordUid}</Button> }, { title: '类型', dataIndex: 'nodeType', width: 160 }, { title: '业务编号', dataIndex: 'itemId', width: 180 }, { title: '关联时间', dataIndex: 'linkedAt', width: 180, render: formatDate }, { title: '操作', key: 'action', width: 110, render: (_value, row) => <Popconfirm title="取消项目资产关联？" onConfirm={() => void unlinkAsset(row.recordUid)}><Button type="link" danger size="small" icon={<DisconnectOutlined />}>取消关联</Button></Popconfirm> }]} /> : <Empty description="尚未关联数据中心记录" />}
              </Card>
            )
          },
          {
            key: 'knowledge',
            label: '技术协议',
            children: (
              <Card className="project-knowledge-card">
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="当前协议">
                    {current.currentDocumentName ? (
                      <Button
                        type="link"
                        className="project-document-inline-link"
                        icon={<EyeOutlined />}
                        onClick={() => void openDocumentPreview()}
                        title={`在线预览：${current.currentDocumentName}`}
                      >
                        {current.currentDocumentName}
                      </Button>
                    ) : '尚未上传'}
                  </Descriptions.Item>
                  <Descriptions.Item label="知识库状态"><ProjectStatus project={current} /></Descriptions.Item>
                  <Descriptions.Item label="分析说明">{current.analysisMessage || '上传技术协议后自动建立索引并识别功能需求'}</Descriptions.Item>
                  <Descriptions.Item label="匹配说明">{current.matchMessage || '确认项目后开始匹配数据中心记录'}</Descriptions.Item>
                </Descriptions>
                <Space className="project-knowledge-actions" wrap>
                  <Button type="primary" icon={<UploadOutlined />} onClick={() => void uploadAgreement()}>上传技术协议</Button>
                  {current.analysisStatus === 'failed' && <Button icon={<ReloadOutlined />} onClick={() => void retryAnalysis()}>重试分析</Button>}
                  {current.requirementCount > 0 && <Button icon={<SyncOutlined />} onClick={() => void startMatching()}>重新匹配</Button>}
                </Space>
              </Card>
            )
          }
        ]}
      />

      <MatchDrawer requirement={matchRequirement} open={Boolean(matchRequirement)} onClose={() => setMatchRequirement(null)} onOpenRecord={(uid) => void openRecord(uid)} onLinkAsset={(uid) => void linkAsset(uid)} onSaveKeyInfoTerms={saveRequirementKeyInfoTerms} />

      <Modal title="编辑项目基本信息" open={editModalOpen} onCancel={() => setEditModalOpen(false)} footer={null} destroyOnHidden afterOpenChange={(open) => { if (open) editForm.setFieldsValue(current) }}>
        <ProjectForm form={editForm} onFinish={(values) => void saveProject(values)} organizationPeople={organizationPeople} currentProject={current} />
      </Modal>

      <Modal title={editingCost ? '编辑成本明细' : '新增成本明细'} open={costModalOpen} onCancel={() => setCostModalOpen(false)} onOk={() => void costForm.submit()} destroyOnHidden afterOpenChange={(open) => { if (open) costForm.setFieldsValue(editingCost
        ? { type: editingCost.type, category: editingCost.category, description: editingCost.description, amount: editingCost.amount, occurredAt: editingCost.occurredAt.slice(0, 10), assetRecordUid: editingCost.assetRecordUid, responsibleParticipantId: editingCost.responsibleParticipantId }
        : { type: 'estimated', occurredAt: new Date().toISOString().slice(0, 10), amount: 0, responsibleParticipantId: undefined }) }}>
        <Form form={costForm} layout="vertical" onFinish={(values) => void saveCost(values)}>
          <Form.Item name="type" label="成本类型" rules={[{ required: true }]}><Select options={[{ value: 'estimated', label: '预计成本' }, { value: 'actual', label: '实际成本' }]} /></Form.Item>
          <Form.Item name="category" label="成本分类" rules={[{ required: true, message: '请输入成本分类' }]}><Input placeholder="例如：人力、采购、差旅" /></Form.Item>
          <Form.Item name="responsibleParticipantId" label="责任人" extra="只能选择当前已绑定的项目参与人"><Select allowClear showSearch optionFilterProp="label" placeholder="可选：关联项目参与人" options={participants.map((participant) => ({ value: participant.id, label: `${participant.personName}${participant.department ? ` · ${participant.department}` : ''}` }))} /></Form.Item>
          <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true, message: '请输入金额' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} addonAfter="元" /></Form.Item>
          <Form.Item name="occurredAt" label="日期"><Input type="date" /></Form.Item>
        </Form>
      </Modal>

      <Modal title={editingParticipant ? '编辑项目参与人员' : '绑定项目参与人员'} open={participantModalOpen} onCancel={() => setParticipantModalOpen(false)} onOk={() => void participantForm.submit()} destroyOnHidden width={680}>
        <Form form={participantForm} layout="vertical" onFinish={(values) => void saveParticipant(values)}>
          <Form.Item name="personId" label="组织人员" rules={[{ required: true, message: '请选择组织人员' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择人员"
              options={organizationPeople
                .filter((person) => person.status === 'active' || person.id === editingParticipant?.personId)
                .filter((person) => person.id === editingParticipant?.personId || !participants.some((item) => item.personId === person.id))
                .map((person) => ({ value: person.id, label: `${person.name}${person.department ? ` · ${person.department}` : ''} · ${formatRate(person.hourlyRate)}` }))}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(previous, next) => previous.personId !== next.personId}>
            {({ getFieldValue }) => {
              const selected = organizationPeople.find((person) => person.id === getFieldValue('personId'))
              return selected ? <div className="project-participant-rate-hint"><ClockCircleOutlined /> 当前报价：<strong>{formatRate(selected.hourlyRate)}</strong>，绑定后将保存为本项目报价快照</div> : <div className="project-participant-rate-hint is-muted">选择人员后显示当前工时报价</div>
            }}
          </Form.Item>
          <div className="project-form-grid">
            <Form.Item name="startDate" label="参与开始时间" rules={[{ required: true, message: '请选择开始时间' }]}><Input type="date" /></Form.Item>
            <Form.Item name="endDate" label="参与结束时间" rules={[{ required: true, message: '请选择结束时间' }]}><Input type="date" /></Form.Item>
          </div>
          <Form.Item name="notes" label="参与说明"><Input.TextArea rows={3} placeholder="例如：负责前端开发和联调" /></Form.Item>
        </Form>
      </Modal>

      <Modal
        className="project-record-detail-modal"
        title={recordDetail ? (
          <div className="project-record-modal-title">
            <DatabaseOutlined />
            <span>数据中心记录</span>
            <span className="project-record-modal-name">{recordDetail.name}</span>
          </div>
        ) : '数据中心记录'}
        open={Boolean(recordDetail)}
        onCancel={() => setRecordDetail(null)}
        footer={null}
        centered
        mask={false}
        zIndex={1100}
        width={860}
      >
        {recordDetail && (
          <div className="project-record-detail">
            <div className="project-record-detail-summary">
              <div>
                <Text type="secondary">记录名称</Text>
                <Title level={5}>{recordDetail.name}</Title>
              </div>
              <Space wrap size={[6, 6]}>
                <Tag color="purple">{recordDetail.nodeType}</Tag>
                {recordDetail.itemId && <Tag>{recordDetail.itemId}</Tag>}
                {recordDetail.images.length > 0 && <Tag>{recordDetail.images.length} 张图片</Tag>}
              </Space>
            </div>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="UID">{recordDetail.uid}</Descriptions.Item>
              <Descriptions.Item label="类型">{recordDetail.nodeType}</Descriptions.Item>
              <Descriptions.Item label="业务编号">{recordDetail.itemId || '—'}</Descriptions.Item>
              <Descriptions.Item label="项目 UID">{recordDetail.projectId || '—'}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{formatDate(recordDetail.lastModifyTime)}</Descriptions.Item>
              <Descriptions.Item label="图片数量">{recordDetail.images.length}</Descriptions.Item>
            </Descriptions>
            <section className="project-record-description-section">
              <div className="project-record-section-heading">
                <Text strong>描述</Text>
                <Text type="secondary">已过滤原始 HTML 标签</Text>
              </div>
              <RichDescription html={recordDetail.description} images={recordDetail.images} />
            </section>
            <Collapse
              className="project-record-raw-collapse"
              defaultActiveKey={[]}
              items={[{
                key: 'raw',
                label: '查看原始字段（JSON）',
                children: <pre className="project-record-json">{JSON.stringify(recordDetail.raw, null, 2)}</pre>
              }]}
            />
          </div>
        )}
      </Modal>

      <Modal
        className="project-document-preview-modal"
        title={(
          <div className="project-document-preview-title">
            <FileTextOutlined />
            <span>协议附件</span>
            <span className="project-document-preview-name" title={documentPreview?.document.fileName || current.currentDocumentName}>
              {documentPreview?.document.fileName || current.currentDocumentName || '文件预览'}
            </span>
          </div>
        )}
        open={documentPreviewOpen}
        onCancel={() => setDocumentPreviewOpen(false)}
        footer={null}
        centered
        destroyOnHidden
        width={1080}
      >
        <div className="project-document-preview">
          {documentPreviewLoading && (
            <div className="project-document-preview-state">
              <Spin size="small" />
              <Text type="secondary">正在加载协议附件…</Text>
            </div>
          )}
          {!documentPreviewLoading && documentPreviewError && (
            <Alert
              type="error"
              showIcon
              title="协议附件无法预览"
              description={documentPreviewError}
            />
          )}
          {!documentPreviewLoading && !documentPreviewError && documentPreview?.document.extension === '.pdf' && documentPreview.contentBase64 && (
            <PdfDocumentPreview
              contentBase64={documentPreview.contentBase64}
              fileName={documentPreview.document.fileName}
            />
          )}
          {!documentPreviewLoading && !documentPreviewError && documentPreview && documentPreview.document.extension !== '.pdf' && (
            <div className="project-document-text-preview">
              <div className="project-document-text-preview-meta">
                <Tag color="purple">文本预览</Tag>
                <Text type="secondary">已从知识库索引提取正文，原文件格式：{documentPreview.document.extension.toUpperCase()}</Text>
              </div>
              {documentPreviewText(documentPreview.document) ? (
                <pre>{documentPreviewText(documentPreview.document)}</pre>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前文件没有可预览的文本内容" />
              )}
            </div>
          )}
        </div>
      </Modal>

      <Modal title="关联数据中心记录" open={assetModalOpen} onCancel={() => setAssetModalOpen(false)} footer={null} width={900}>
        <div className="project-asset-search"><Input.Search allowClear prefix={<SearchOutlined />} placeholder="搜索数据名称、编号或内容" value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} onSearch={() => void loadRecords()} enterButton="搜索" /></div>
        <ResizableTable<RecordRow> tableKey="project-asset-picker" rowKey="uid" dataSource={records.filter((row) => !assets.some((asset) => asset.recordUid === row.uid))} pagination={{ total: recordTotal, pageSize: 50, showTotal: (count) => `共 ${count} 条数据` }} scroll={{ x: 760, y: projectCompactTableScrollY }} columns={[{ title: '数据名称', dataIndex: 'name', render: (value: string) => value }, { title: '类型', dataIndex: 'nodeType', width: 160 }, { title: '业务编号', dataIndex: 'itemId', width: 180 }, { title: '操作', key: 'action', width: 110, render: (_value, row) => <Button type="link" icon={<LinkOutlined />} onClick={() => void linkAsset(row.uid)}>关联</Button> }]} />
      </Modal>
    </div>
  )
}

export function ProjectManagementPage({
  refreshKey,
  onChanged
}: {
  refreshKey: number
  onChanged: () => void
}): React.JSX.Element {
  const { message } = AntApp.useApp()
  const [projects, setProjects] = useState<ManagedProject[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [organizationPeople, setOrganizationPeople] = useState<OrganizationPerson[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<'projects' | 'people'>('projects')
  const [progress, setProgress] = useState<ProjectAnalysisProgress | null>(null)
  const [createForm] = Form.useForm<ManagedProjectInput>()

  const loadProjects = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.visslm.listManagedProjects({ page, pageSize, search })
      setProjects(result.rows)
      setTotal(result.total)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects, refreshKey])

  useEffect(() => window.visslm.onProjectProgress((next) => {
    setProgress(next)
    void loadProjects()
  }), [loadProjects])

  useEffect(() => {
    if (!createModalOpen) return
    void window.visslm.listOrganizationPeople({ page: 1, pageSize: 100 }).then((result) => setOrganizationPeople(result.rows))
  }, [createModalOpen])

  const createProject = async (values: ManagedProjectInput): Promise<void> => {
    const created = await window.visslm.createManagedProject(projectInputFromValues(values as unknown as Record<string, unknown>))
    setCreateModalOpen(false)
    createForm.resetFields()
    setSelectedProjectId(created.id)
    await loadProjects()
    onChanged()
    message.success('项目已创建')
  }

  const uploadAgreement = async (): Promise<void> => {
    const result = await window.visslm.startProjectTechnicalAgreementUpload()
    if (result.canceled) return
    if (!result.ok || !result.projectId) {
      message.error(result.message)
      return
    }
    setSelectedProjectId(result.projectId)
    await loadProjects()
    onChanged()
    message.success(result.message)
  }

  const importProjectData = async (): Promise<void> => {
    try {
      const result = await window.visslm.importManagedProjectData()
      if (result.canceled) return
      if (!result.ok) {
        message.error(result.message)
        return
      }
      const importedProject = result.projectId
        ? await window.visslm.getManagedProject(result.projectId)
        : null
      await loadProjects()
      if (importedProject) {
        setProjects((rows) => rows.some((row) => row.id === importedProject.id) ? rows : [importedProject, ...rows].slice(0, pageSize))
        setSelectedProjectId(importedProject.id)
      }
      onChanged()
      if (result.warningCount) message.warning(`${result.message}，请检查导入后的关联数据`)
      else message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '项目完整数据导入失败')
    }
  }

  const deleteProject = async (id: string): Promise<void> => {
    try {
      const result = await window.visslm.deleteManagedProject(id)
      if (!result.ok) {
        message.warning(result.message)
        return
      }
      if (selectedProjectId === id) setSelectedProjectId(null)
      await loadProjects()
      onChanged()
      message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '项目删除失败')
    }
  }

  if (selectedProjectId) {
    const selected = projects.find((project) => project.id === selectedProjectId)
    if (selected) {
      return <ProjectDetail project={selected} progress={progress} onBack={() => { setSelectedProjectId(null); void loadProjects() }} onChanged={() => { void loadProjects(); onChanged() }} onDeleted={() => { setSelectedProjectId(null); void loadProjects(); onChanged() }} />
    }
  }

  return (
    <div className="project-management-module">
      <Tabs
        className="project-module-tabs"
        activeKey={activeSection}
        onChange={(key) => setActiveSection(key as 'projects' | 'people')}
        items={[{ key: 'projects', label: '项目列表', children: null }, { key: 'people', label: '组织人员', children: null }]}
      />
      {activeSection === 'people' ? <OrganizationPeoplePage onChanged={onChanged} /> : <div className="project-management-page page-stack">
        <div className="project-page-toolbar">
        <div>
          <Title level={4}>项目管理</Title>
          <Text type="secondary">集中管理项目成本、协议需求和数据中心资产</Text>
        </div>
        <Space wrap>
          <Button icon={<FileAddOutlined />} onClick={() => void uploadAgreement()}>上传技术协议创建</Button>
          <Button icon={<ImportOutlined />} onClick={() => void importProjectData()}>导入项目数据</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>手动创建项目</Button>
        </Space>
        </div>
        {progress && progress.status === 'running' && (
        <Alert showIcon icon={<SyncOutlined spin />} title={progress.message} description={progress.total ? `进度 ${progress.current}/${progress.total}` : '任务正在后台执行'} type="info" />
        )}
        <Card className="project-list-card">
        <div className="project-list-filter"><Input.Search allowClear prefix={<SearchOutlined />} placeholder="搜索项目名称或客户名称" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} onSearch={() => void loadProjects()} style={{ width: 320 }} /><Text type="secondary">共 {total} 个项目</Text></div>
        <ResizableTable<ManagedProject>
          tableKey="project-list"
          rowKey="id"
          loading={loading}
          dataSource={projects}
          scroll={{ x: 1250, y: projectAppTableScrollY }}
          pagination={{ current: page, pageSize, total, showSizeChanger: true, showTotal: (count) => `共 ${count} 个项目` }}
          onChange={(pagination: TablePaginationConfig) => { setPage(pagination.current ?? 1); setPageSize(pagination.pageSize ?? 20) }}
          columns={[
            { title: '项目名称', dataIndex: 'projectName', width: 240, fixed: 'left', render: (value: string, row) => <Button type="link" className="project-table-link project-name-link" onClick={() => setSelectedProjectId(row.id)}><ProjectOutlined /> {value}</Button> },
            { title: '客户名称', dataIndex: 'customerName', width: 170, ellipsis: true },
            { title: '合同金额', dataIndex: 'contractAmount', width: 140, render: formatAmount },
            { title: '预计成本', dataIndex: 'estimatedCost', width: 140, render: formatAmount },
            { title: '剩余额度', dataIndex: 'remainingQuota', width: 140, render: (value: number) => <Text type={value < 0 ? 'danger' : undefined}>{formatAmount(value)}</Text> },
            { title: '交付提醒', key: 'delivery', width: 150, render: (_value, row) => deliveryHint(row) ? <Tag color={deliveryHint(row)?.color}>{deliveryHint(row)?.label}</Tag> : <Text type="secondary">未设置日期</Text> },
            { title: '需求进度', key: 'requirements', width: 210, render: (_value, row) => <Space size={4} wrap><Tag>未标记 {row.unmarkedCount}</Tag><Tag color="success">满足 {row.satisfiedCount}</Tag><Tag color="processing">开发 {row.toDevelopCount}</Tag><Tag color="warning">协商 {row.toNegotiateCount}</Tag></Space> },
            { title: '状态', key: 'status', width: 190, render: (_value, row) => <ProjectStatus project={row} /> },
            { title: '更新时间', dataIndex: 'updatedAt', width: 150, render: formatDate },
             {
               title: '操作',
               key: 'action',
               fixed: 'right',
               width: 176,
               render: (_value, row) => (
                 <Space size={4}>
                   <Button type="link" size="small" onClick={() => setSelectedProjectId(row.id)}>查看详情</Button>
                   <Popconfirm
                     title={`确认删除“${row.projectName}”？`}
                     description="项目及其完整项目数据将被删除，且无法恢复。"
                     okText="删除项目"
                     cancelText="取消"
                     okButtonProps={{ danger: true }}
                     onConfirm={() => void deleteProject(row.id)}
                   >
                     <Button danger type="link" size="small" icon={<DeleteOutlined />} aria-label={`删除项目：${row.projectName}`}>删除</Button>
                   </Popconfirm>
                 </Space>
               )
             }
          ]}
        />
        </Card>
        <Modal title="手动创建项目" open={createModalOpen} onCancel={() => setCreateModalOpen(false)} footer={null} width={820} destroyOnHidden afterOpenChange={(open) => { if (open) createForm.setFieldsValue({ deliveryReminderDays: 7, riskFactor: 0 }) }}>
          <ProjectForm form={createForm} onFinish={(values) => void createProject(values)} organizationPeople={organizationPeople} />
        </Modal>
      </div>}
    </div>
  )
}
