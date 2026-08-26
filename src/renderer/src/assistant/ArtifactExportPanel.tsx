import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FileWordOutlined,
  FileZipOutlined,
  LoadingOutlined,
  StopOutlined
} from '@ant-design/icons'
import { Button, Divider, Radio, Spin, Tag, Typography } from 'antd'
import type { ReactNode } from 'react'
import './artifact-export.css'

export type ArtifactExportFormat = 'docx' | 'xlsx' | 'pptx' | 'zip'

export type ArtifactExportGenerationStatus =
  | 'idle'
  | 'previewing'
  | 'generating'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type ArtifactExportHistoryStatus =
  | 'queued'
  | 'generating'
  | 'generated'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'active'
  | 'reverted'

export interface ArtifactExportCounts {
  evidenceCount?: number
  recordCount?: number
  documentCount?: number
  dataRowCount?: number
  queryMatchedCount?: number
  recordEvidenceCount?: number
  documentEvidenceCount?: number
}

/**
 * Renderer-only compatibility shape for the unified artifact export preview.
 *
 * The optional aliases intentionally cover both the new export service shape
 * (`summary`, `evidence`, `stats`) and the existing AssistantArtifactPreview
 * (`contentPreview`, `impact`, `input`). The parent can pass a mapped shared
 * preview without coupling this presentational component to the main process.
 */
export interface ArtifactExportPreview {
  previewId?: string
  id?: string
  title: string
  summary?: string
  contentPreview?: string
  format?: ArtifactExportFormat
  fileName?: string
  evidence?: ArtifactExportCounts
  stats?: ArtifactExportCounts
  counts?: ArtifactExportCounts
  evidenceCount?: number
  dataRowCount?: number
  impact?: ArtifactExportCounts & {
    sourceWriteCount?: number
  }
  rollbackPoint?: string
  input?: {
    evidenceBlocks?: readonly unknown[]
    dataViews?: readonly unknown[]
  }
}

/**
 * A history item can be passed directly from a newer export service or from
 * the legacy AssistantArtifact list. Legacy `type` values are rendered as a
 * ZIP bundle until the parent maps them to an explicit export format.
 */
export interface ArtifactExportHistoryItem {
  id: string
  title: string
  format?: ArtifactExportFormat
  type?: ArtifactExportFormat | string
  status?: ArtifactExportHistoryStatus
  createdAt?: string
  updatedAt?: string
  fileName?: string
  evidenceCount?: number
  dataRowCount?: number
  sizeLabel?: string
  summary?: string
}

export interface AssistantSkillPresentation {
  id: 'knowledge-base' | 'artifact'
  mention: string
  name: string
  description: string
}

/** User-facing skill cards used by the assistant entrypoint and quick actions. */
export const assistantSkillPresentation = {
  'knowledge-base': {
    id: 'knowledge-base',
    mention: '@知识库专家',
    name: '知识库专家',
    description: '检索本地知识库，定位文档证据并给出可追溯的回答。'
  },
  artifact: {
    id: 'artifact',
    mention: '@交付物专家',
    name: '交付物专家',
    description: '将已核验的回答和证据整理为报告、表格、演示文稿或导出包。'
  }
} satisfies Record<AssistantSkillPresentation['id'], AssistantSkillPresentation>

export const artifactExportFormats: readonly ArtifactExportFormat[] = [
  'docx',
  'xlsx',
  'pptx',
  'zip'
]

type FormatMeta = {
  label: string
  shortLabel: string
  description: string
  Icon: typeof FileWordOutlined
}

const formatMeta: Record<ArtifactExportFormat, FormatMeta> = {
  docx: {
    label: '报告 · DOCX',
    shortLabel: '报告',
    description: '结构化文字报告',
    Icon: FileWordOutlined
  },
  xlsx: {
    label: '表格 · XLSX',
    shortLabel: '表格',
    description: '证据与数据明细',
    Icon: FileExcelOutlined
  },
  pptx: {
    label: '演示 · PPTX',
    shortLabel: '演示',
    description: '汇报型演示文稿',
    Icon: FilePptOutlined
  },
  zip: {
    label: '导出包 · ZIP',
    shortLabel: '导出包',
    description: '报告、表格与附件',
    Icon: FileZipOutlined
  }
}

export const artifactExportFormatLabel = (format: ArtifactExportFormat): string =>
  formatMeta[format].label

export type ArtifactExportPanelProps = {
  preview: ArtifactExportPreview | null
  format: ArtifactExportFormat
  onFormatChange: (format: ArtifactExportFormat) => void
  busy?: boolean
  history?: readonly ArtifactExportHistoryItem[]
  generationStatus?: ArtifactExportGenerationStatus
  statusMessage?: string
  disabled?: boolean
  showHistory?: boolean
  onConfirm: () => void | Promise<void>
  onCancel: () => void
  onHistorySelect?: (item: ArtifactExportHistoryItem) => void
  className?: string
}

const firstFiniteNumber = (...values: Array<number | undefined>): number | undefined => {
  const value = values.find((candidate) => (
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
  ))
  return value === undefined ? undefined : Math.round(value)
}

const countLabel = (value: number | undefined): string => value === undefined ? '—' : value.toLocaleString('zh-CN')

const resolveCounts = (preview: ArtifactExportPreview | null): Required<Pick<ArtifactExportCounts, 'evidenceCount' | 'recordCount' | 'documentCount' | 'dataRowCount'>> => {
  if (!preview) {
    return {
      evidenceCount: 0,
      recordCount: 0,
      documentCount: 0,
      dataRowCount: 0
    }
  }

  const sources = [preview.evidence, preview.stats, preview.counts, preview.impact]
  const recordCount = firstFiniteNumber(
    ...sources.map((source) => source?.recordCount ?? source?.recordEvidenceCount)
  )
  const documentCount = firstFiniteNumber(
    ...sources.map((source) => source?.documentCount ?? source?.documentEvidenceCount)
  )
  const dataRowCount = firstFiniteNumber(
    ...sources.map((source) => source?.dataRowCount ?? source?.queryMatchedCount),
    preview.dataRowCount
  )
  const evidenceCount = firstFiniteNumber(
    ...sources.map((source) => source?.evidenceCount),
    preview.evidenceCount,
    preview.input?.evidenceBlocks ? preview.input.evidenceBlocks.length : undefined,
    recordCount !== undefined || documentCount !== undefined
      ? (recordCount ?? 0) + (documentCount ?? 0)
      : undefined
  )

  return {
    evidenceCount: evidenceCount ?? 0,
    recordCount: recordCount ?? 0,
    documentCount: documentCount ?? 0,
    dataRowCount: dataRowCount ?? 0
  }
}

const formatOfHistoryItem = (item: ArtifactExportHistoryItem): ArtifactExportFormat => {
  if (item.format && item.format in formatMeta) return item.format
  if (item.type && item.type in formatMeta) return item.type as ArtifactExportFormat
  return 'zip'
}

const historyStatusLabel = (status: ArtifactExportHistoryStatus | undefined): string => {
  switch (status) {
    case 'queued': return '排队中'
    case 'generating': return '生成中'
    case 'generated':
    case 'succeeded':
    case 'active': return '已生成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'reverted': return '已撤销'
    default: return '待处理'
  }
}

const historyStatusTone = (status: ArtifactExportHistoryStatus | undefined): string => {
  switch (status) {
    case 'failed': return 'error'
    case 'cancelled':
    case 'reverted': return 'warning'
    case 'generated':
    case 'succeeded':
    case 'active': return 'success'
    case 'queued':
    case 'generating': return 'info'
    default: return 'neutral'
  }
}

const formatTimestamp = (value: string | undefined): string | null => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const statusMeta: Record<ArtifactExportGenerationStatus, {
  label: string
  tone: string
  Icon: typeof CheckCircleOutlined
  spinning?: boolean
}> = {
  idle: { label: '待确认', tone: 'neutral', Icon: ClockCircleOutlined },
  previewing: { label: '正在准备预览', tone: 'info', Icon: LoadingOutlined, spinning: true },
  generating: { label: '正在生成', tone: 'info', Icon: LoadingOutlined, spinning: true },
  succeeded: { label: '已生成', tone: 'success', Icon: CheckCircleOutlined },
  failed: { label: '生成失败', tone: 'error', Icon: ExclamationCircleOutlined },
  cancelled: { label: '已取消', tone: 'warning', Icon: StopOutlined }
}

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode => (
  <div className="assistant-artifact-export__stat">
    <span className="assistant-artifact-export__stat-label">{label}</span>
    <strong className="assistant-artifact-export__stat-value">{value}</strong>
    {hint ? <span className="assistant-artifact-export__stat-hint">{hint}</span> : null}
  </div>
)

export function ArtifactExportPanel({
  preview,
  format,
  onFormatChange,
  busy = false,
  history = [],
  generationStatus = 'idle',
  statusMessage,
  disabled = false,
  showHistory = true,
  onConfirm,
  onCancel,
  onHistorySelect,
  className
}: ArtifactExportPanelProps): React.JSX.Element {
  const counts = resolveCounts(preview)
  const selectedFormat = formatMeta[format]
  const SelectedFormatIcon = selectedFormat.Icon
  const currentStatus = busy && generationStatus === 'idle' ? 'generating' : generationStatus
  const status = statusMeta[currentStatus]
  const StatusIcon = status.Icon
  const summary = preview?.summary?.trim() || preview?.contentPreview?.trim() || '暂无摘要，生成时将以已核验证据为准。'
  const previewTitleId = 'assistant-artifact-export-preview-title'
  const historyTitleId = 'assistant-artifact-export-history-title'
  const panelClassName = ['assistant-artifact-export', className].filter(Boolean).join(' ')

  return (
    <section className={panelClassName} aria-label="AI 交付物生成">
      <header className="assistant-artifact-export__header">
        <div className="assistant-artifact-export__heading">
          <span className="assistant-artifact-export__header-icon" aria-hidden="true">
            <ExportOutlined />
          </span>
          <div>
            <Typography.Title level={4} className="assistant-artifact-export__title">
              生成交付物
            </Typography.Title>
            <Typography.Text className="assistant-artifact-export__subtitle">
              交付物专家 · 仅使用已核验的回答与证据
            </Typography.Text>
          </div>
        </div>
        <div
          className={`assistant-artifact-export__status assistant-artifact-export__status--${status.tone}`}
          role="status"
          aria-live="polite"
        >
          <StatusIcon className={status.spinning ? 'assistant-artifact-export__status-icon--spinning' : undefined} />
          <span>{statusMessage || status.label}</span>
        </div>
      </header>

      <div className="assistant-artifact-export__body">
        <div className="assistant-artifact-export__main">
          <fieldset className="assistant-artifact-export__format-fieldset">
            <legend>导出格式</legend>
            <Radio.Group
              className="assistant-artifact-export__format-group"
              value={format}
              onChange={(event) => onFormatChange(event.target.value as ArtifactExportFormat)}
              optionType="button"
              buttonStyle="solid"
              aria-label="选择交付物导出格式"
              disabled={busy || disabled}
            >
              {artifactExportFormats.map((item) => {
                const meta = formatMeta[item]
                const Icon = meta.Icon
                return (
                  <Radio.Button key={item} value={item} className="assistant-artifact-export__format-option">
                    <Icon aria-hidden="true" />
                    <span className="assistant-artifact-export__format-option-copy">
                      <strong>{meta.shortLabel}</strong>
                      <small>{item.toUpperCase()}</small>
                    </span>
                  </Radio.Button>
                )
              })}
            </Radio.Group>
            <span className="assistant-artifact-export__format-description">
              {selectedFormat.description}
            </span>
          </fieldset>

          <div className="assistant-artifact-export__preview-card" aria-labelledby={previewTitleId}>
            <div className="assistant-artifact-export__section-heading">
              <div>
                <span className="assistant-artifact-export__eyebrow">预览摘要</span>
                <Typography.Title id={previewTitleId} level={5} className="assistant-artifact-export__preview-title">
                  {preview?.title || '尚未选择回答'}
                </Typography.Title>
              </div>
              <Tag className="assistant-artifact-export__format-tag">
                <SelectedFormatIcon aria-hidden="true" /> {selectedFormat.label}
              </Tag>
            </div>
            <div className={`assistant-artifact-export__summary${preview ? '' : ' is-empty'}`}>
              {preview ? summary : '请先在会话中选择一条包含证据的回答。'}
            </div>
            {preview?.fileName ? (
              <div className="assistant-artifact-export__file-name">
                <span>目标文件</span>
                <strong title={preview.fileName}>{preview.fileName}</strong>
              </div>
            ) : null}
            {preview?.rollbackPoint ? (
              <div className="assistant-artifact-export__safe-note">
                <CheckCircleOutlined aria-hidden="true" />
                <span>{preview.rollbackPoint}</span>
              </div>
            ) : (
              <div className="assistant-artifact-export__safe-note">
                <CheckCircleOutlined aria-hidden="true" />
                <span>生成前会再次校验证据；不会直接修改数据中心或知识库。</span>
              </div>
            )}
          </div>

          <div className="assistant-artifact-export__stats" aria-label="交付物依据统计">
            <Stat label="证据" value={countLabel(counts.evidenceCount)} hint="已核验依据" />
            <Stat label="数据行" value={countLabel(counts.dataRowCount)} hint="查询结果" />
            <Stat label="记录依据" value={countLabel(counts.recordCount)} hint="数据中心" />
            <Stat label="文档依据" value={countLabel(counts.documentCount)} hint="知识库" />
          </div>
        </div>

        {showHistory ? (
          <aside className="assistant-artifact-export__history" aria-labelledby={historyTitleId}>
            <div className="assistant-artifact-export__section-heading assistant-artifact-export__section-heading--compact">
              <div>
                <span className="assistant-artifact-export__eyebrow">最近生成</span>
                <Typography.Title id={historyTitleId} level={5} className="assistant-artifact-export__history-title">
                  交付物记录
                </Typography.Title>
              </div>
              <span className="assistant-artifact-export__history-count">{history.length}</span>
            </div>
            {history.length ? (
              <ul className="assistant-artifact-export__history-list">
                {history.map((item) => {
                  const itemFormat = formatOfHistoryItem(item)
                  const itemMeta = formatMeta[itemFormat]
                  const ItemIcon = itemMeta.Icon
                  const timestamp = formatTimestamp(item.updatedAt || item.createdAt)
                  const itemBody = (
                    <>
                      <span className="assistant-artifact-export__history-icon" aria-hidden="true">
                        <ItemIcon />
                      </span>
                      <span className="assistant-artifact-export__history-copy">
                        <strong title={item.title}>{item.title}</strong>
                        <span>
                          {itemMeta.shortLabel} · {historyStatusLabel(item.status)}
                          {timestamp ? ` · ${timestamp}` : ''}
                        </span>
                      </span>
                      <span className={`assistant-artifact-export__history-state assistant-artifact-export__history-state--${historyStatusTone(item.status)}`}>
                        {historyStatusLabel(item.status)}
                      </span>
                    </>
                  )
                  return (
                    <li key={item.id} className="assistant-artifact-export__history-item">
                      {onHistorySelect ? (
                        <button
                          type="button"
                          className="assistant-artifact-export__history-button"
                          onClick={() => onHistorySelect(item)}
                          aria-label={`选择${item.title}，${itemMeta.label}，${historyStatusLabel(item.status)}`}
                        >
                          {itemBody}
                        </button>
                      ) : (
                        <div className="assistant-artifact-export__history-button is-static">
                          {itemBody}
                        </div>
                      )}
                      {item.evidenceCount !== undefined || item.dataRowCount !== undefined || item.sizeLabel ? (
                        <span className="assistant-artifact-export__history-meta">
                          {item.evidenceCount !== undefined ? `${item.evidenceCount.toLocaleString('zh-CN')} 条证据` : null}
                          {item.dataRowCount !== undefined ? ` · ${item.dataRowCount.toLocaleString('zh-CN')} 行` : null}
                          {item.sizeLabel ? ` · ${item.sizeLabel}` : null}
                        </span>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="assistant-artifact-export__history-empty" role="status">
                <ClockCircleOutlined aria-hidden="true" />
                <span>还没有生成记录</span>
              </div>
            )}
          </aside>
        ) : null}
      </div>

      <Divider className="assistant-artifact-export__divider" />
      <footer className="assistant-artifact-export__footer">
        <Typography.Text className="assistant-artifact-export__footer-note">
          {busy ? <Spin size="small" aria-label="正在生成交付物" /> : null}
          {busy ? '正在生成，请稍候…' : '确认后才会生成文件并写入本地导出目录。'}
        </Typography.Text>
        <div className="assistant-artifact-export__actions">
          <Button type="text" onClick={onCancel} disabled={busy} aria-label="取消交付物生成">
            取消
          </Button>
          <Button
            type="primary"
            icon={<ExportOutlined aria-hidden="true" />}
            loading={busy}
            disabled={!preview || disabled}
            onClick={() => void onConfirm()}
            aria-label={`确认生成${selectedFormat.label}`}
          >
            确认生成
          </Button>
        </div>
      </footer>
    </section>
  )
}

export default ArtifactExportPanel
