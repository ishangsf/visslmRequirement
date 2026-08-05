import {
  ArrowRightOutlined,
  CalendarOutlined,
  DatabaseOutlined,
  DollarOutlined,
  EyeOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PartitionOutlined,
  ProjectOutlined,
  ReloadOutlined,
  SearchOutlined,
  ShareAltOutlined,
  TeamOutlined,
  UpOutlined
} from '@ant-design/icons'
import { Button, Empty, Input, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import type { EChartsOption } from 'echarts'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import type {
  ManagedProject,
  ProjectAsset,
  ProjectCostEntry,
  ProjectDocumentSnapshot,
  ProjectParticipant,
  ProjectPlanTask,
  ProjectRequirement
} from '../../../shared/project-types'

const { Text, Title } = Typography

type RelationshipNodeKind = 'project' | 'document' | 'requirement' | 'asset' | 'participant' | 'task' | 'cost'
type RelationshipGraphMode = 'flow' | 'network'
type RelationshipFlowStageKey = 'upstream' | 'project' | 'business' | 'execution'
type RelationshipPathDirection = 'upstream' | 'downstream'

type RelationshipNodeMetadata = {
  label: string
  value: string
}

type RelationshipGraphNode = {
  id: string
  name: string
  kind: RelationshipNodeKind
  typeLabel: string
  description: string
  metadata: RelationshipNodeMetadata[]
  symbolSize: number
  relatedRecordUid?: string
  relatedRequirementId?: string
  isAggregate?: boolean
  aggregateKind?: RelationshipNodeKind
  itemStyle?: {
    color: string
    borderColor: string
    borderWidth: number
    shadowBlur?: number
    shadowColor?: string
    opacity?: number
  }
  category?: number
  x?: number
  y?: number
}

type RelationshipGraphLink = {
  source: string
  target: string
  relation: string
  originalKeys?: string[]
}

type RelationshipGraphPalette = {
  surfaceRaised: string
  surfaceSoft: string
  surfaceOverlay: string
  stroke: string
  strokeStrong: string
  textMain: string
  textMuted: string
  accent: string
  accentSoft: string
  stateSuccess: string
  stateInfo: string
  stateWarning: string
  stateError: string
}

const relationshipNodeMeta: Record<RelationshipNodeKind, { label: string; icon: React.ReactNode }> = {
  project: { label: '项目', icon: <ProjectOutlined /> },
  document: { label: '协议', icon: <FileTextOutlined /> },
  requirement: { label: '需求', icon: <FileSearchOutlined /> },
  asset: { label: '资产', icon: <DatabaseOutlined /> },
  participant: { label: '参与人', icon: <TeamOutlined /> },
  task: { label: '计划', icon: <CalendarOutlined /> },
  cost: { label: '成本', icon: <DollarOutlined /> }
}

const relationshipNodeKinds: RelationshipNodeKind[] = [
  'document',
  'requirement',
  'asset',
  'participant',
  'task',
  'cost'
]

const relationshipFlowStages: Array<{
  key: RelationshipFlowStageKey
  label: string
  description: string
}> = [
  { key: 'upstream', label: '上游输入', description: '协议与来源' },
  { key: 'project', label: '项目中枢', description: '当前项目' },
  { key: 'business', label: '业务对象', description: '需求与资产' },
  { key: 'execution', label: '执行产出', description: '计划、人员与成本' }
]

const relationshipFlowStageByKind: Record<RelationshipNodeKind, RelationshipFlowStageKey> = {
  document: 'upstream',
  project: 'project',
  requirement: 'business',
  asset: 'business',
  task: 'execution',
  participant: 'execution',
  cost: 'execution'
}

const requirementStatusLabels: Record<ProjectRequirement['status'], string> = {
  unmarked: '未标记',
  satisfied: '已满足',
  to_develop: '待开发',
  to_negotiate: '待协商'
}

const taskStatusLabels: Record<ProjectPlanTask['status'], string> = {
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '已阻塞'
}

const taskTypeLabels: Record<ProjectPlanTask['taskType'], string> = {
  milestone: '里程碑',
  phase: '阶段',
  task: '普通任务'
}

const readCssVariable = (name: string, fallback: string): string => {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

const readRelationshipGraphPalette = (): RelationshipGraphPalette => ({
  surfaceRaised: readCssVariable('--surface-raised', '#131720'),
  surfaceSoft: readCssVariable('--surface-soft', '#171b25'),
  surfaceOverlay: readCssVariable('--surface-overlay', '#171b24'),
  stroke: readCssVariable('--stroke', 'rgba(255, 255, 255, 0.085)'),
  strokeStrong: readCssVariable('--stroke-strong', 'rgba(255, 255, 255, 0.13)'),
  textMain: readCssVariable('--text-main', '#eef1f7'),
  textMuted: readCssVariable('--text-muted', '#929bad'),
  accent: readCssVariable('--accent', '#7c6cff'),
  accentSoft: readCssVariable('--accent-soft', 'rgba(124, 108, 255, 0.16)'),
  stateSuccess: readCssVariable('--state-success', '#49d597'),
  stateInfo: readCssVariable('--state-info', '#60b9ff'),
  stateWarning: readCssVariable('--state-warning', '#f2b45c'),
  stateError: readCssVariable('--state-error', '#ef6b73')
})

const useRelationshipGraphPalette = (): RelationshipGraphPalette => {
  const [themeRevision, setThemeRevision] = useState(0)

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return useMemo(() => readRelationshipGraphPalette(), [themeRevision])
}

const compactGraphLabel = (value: string, maxLength = 18): string => {
  const normalized = value.trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

const escapeGraphHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[character] ?? character))

const formatGraphDate = (value?: string): string => {
  if (!value) return '未设置'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN')
}

const formatGraphAmount = (value: number): string =>
  `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const buildRelationshipGraph = (
  project: ManagedProject,
  requirements: ProjectRequirement[],
  assets: ProjectAsset[],
  participants: ProjectParticipant[],
  tasks: ProjectPlanTask[],
  costs: ProjectCostEntry[],
  documents: ProjectDocumentSnapshot[],
  palette: RelationshipGraphPalette
): { nodes: RelationshipGraphNode[]; links: RelationshipGraphLink[] } => {
  const colors: Record<RelationshipNodeKind, string> = {
    project: palette.accent,
    document: palette.stateInfo,
    requirement: palette.accent,
    asset: palette.stateInfo,
    participant: palette.stateSuccess,
    task: palette.stateWarning,
    cost: palette.stateError
  }
  const categoryIndex = new Map(relationshipNodeKinds.map((kind, index) => [kind, index]))
  const nodes: RelationshipGraphNode[] = []
  const links: RelationshipGraphLink[] = []
  const nodeIds = new Set<string>()
  const linkKeys = new Set<string>()

  const addNode = (node: Omit<RelationshipGraphNode, 'category' | 'itemStyle'>): void => {
    if (nodeIds.has(node.id)) return
    const color = colors[node.kind]
    nodeIds.add(node.id)
    nodes.push({
      ...node,
      category: node.kind === 'project' ? undefined : categoryIndex.get(node.kind),
      itemStyle: {
        color,
        borderColor: palette.surfaceRaised,
        borderWidth: node.kind === 'project' ? 3 : 2,
        ...(node.kind === 'project' ? { shadowBlur: 24, shadowColor: palette.accentSoft } : {})
      }
    })
  }

  const addLink = (source: string, target: string, relation: string): void => {
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) return
    const key = `${source}:${target}:${relation}`
    if (linkKeys.has(key)) return
    linkKeys.add(key)
    links.push({ source, target, relation })
  }

  const projectNodeId = `project:${project.id}`
  addNode({
    id: projectNodeId,
    name: project.projectName,
    kind: 'project',
    typeLabel: '当前项目',
    description: '关系图谱中心节点',
    metadata: [
      { label: '客户', value: project.customerName || '未填写' },
      { label: '需求', value: `${project.requirementCount} 条` },
      { label: '资产', value: `${project.assetCount} 条` },
      { label: '计划', value: `${project.taskCount} 项` }
    ],
    symbolSize: 72
  })

  documents.forEach((document) => {
    const nodeId = `document:${document.id}`
    addNode({
      id: nodeId,
      name: document.fileName,
      kind: 'document',
      typeLabel: '技术协议',
      description: document.isCurrent ? '当前生效协议附件' : '项目协议附件',
      metadata: [
        { label: '格式', value: document.extension.toUpperCase() || '未知' },
        { label: '索引分块', value: `${document.chunkCount} 个` },
        { label: '状态', value: document.status || '未知' },
        { label: '关联时间', value: formatGraphDate(document.linkedAt) }
      ],
      symbolSize: document.isCurrent ? 36 : 30
    })
    addLink(nodeId, projectNodeId, '协议输入')
  })

  requirements.forEach((requirement) => {
    const nodeId = `requirement:${requirement.id}`
    addNode({
      id: nodeId,
      name: `REQ-${String(requirement.requirementNo).padStart(3, '0')} ${requirement.title}`,
      kind: 'requirement',
      typeLabel: '功能需求',
      description: requirement.content,
      relatedRequirementId: requirement.id,
      metadata: [
        { label: '模块', value: requirement.module || '未分类' },
        { label: '状态', value: requirementStatusLabels[requirement.status] },
        { label: '匹配数据', value: `${requirement.matchCount} 条` },
        { label: '最高匹配度', value: requirement.highestMatchScore ? `${requirement.highestMatchScore.toFixed(1)}%` : '暂无' },
        { label: '下游数据', value: `${assets.filter((asset) => asset.requirements.some((item) => item.requirementId === requirement.id)).length} 条` }
      ],
      symbolSize: requirement.status === 'satisfied' ? 34 : 30
    })
    addLink(projectNodeId, nodeId, '拆解需求')
  })

  assets.forEach((asset) => {
    const nodeId = `asset:${asset.recordUid}`
    addNode({
      id: nodeId,
      name: asset.name || asset.itemId || asset.recordUid,
      kind: 'asset',
      typeLabel: asset.nodeType || '数据资产',
      description: asset.description || '已关联的数据中心记录',
      relatedRecordUid: asset.recordUid,
      metadata: [
        { label: '类型', value: asset.nodeType || '未知' },
        { label: '业务编号', value: asset.itemId || '未填写' },
        { label: '关联需求', value: `${asset.requirements.length} 条` },
        { label: '关联时间', value: formatGraphDate(asset.linkedAt) }
      ],
      symbolSize: 34
    })
    addLink(projectNodeId, nodeId, '关联资产')
    asset.requirements.forEach((requirement) => {
      addLink(`requirement:${requirement.requirementId}`, nodeId, '关联下游数据')
    })
  })

  participants.forEach((participant) => {
    const nodeId = `participant:${participant.id}`
    addNode({
      id: nodeId,
      name: participant.personName,
      kind: 'participant',
      typeLabel: participant.role || '项目参与人',
      description: participant.notes || '项目参与人',
      metadata: [
        { label: '部门', value: participant.department || '未填写' },
        { label: '角色', value: participant.role || '未填写' },
        { label: '参与周期', value: `${formatGraphDate(participant.startDate)} - ${formatGraphDate(participant.endDate)}` },
        { label: '预计成本', value: formatGraphAmount(participant.estimatedCost) }
      ],
      symbolSize: 32
    })
    addLink(projectNodeId, nodeId, '建立参与关系')
  })

  tasks.forEach((task) => {
    const nodeId = `task:${task.id}`
    addNode({
      id: nodeId,
      name: task.title,
      kind: 'task',
      typeLabel: taskTypeLabels[task.taskType],
      description: task.description || '项目计划项',
      metadata: [
        { label: '状态', value: taskStatusLabels[task.status] },
        { label: '进度', value: `${Math.round(task.progressPercent)}%` },
        { label: '时间', value: `${formatGraphDate(task.startDate)} - ${formatGraphDate(task.endDate)}` },
        { label: '负责人', value: task.ownerName || '未分配' },
        { label: '关联需求', value: `${task.requirements.length} 条` }
      ],
      symbolSize: task.taskType === 'milestone' ? 36 : 28
    })
    addLink(projectNodeId, nodeId, '生成计划')
    task.requirements.forEach((requirement) => {
      addLink(`requirement:${requirement.requirementId}`, nodeId, '关联计划任务')
    })
    if (task.parentTaskId) addLink(`task:${task.parentTaskId}`, nodeId, '分解计划')
    if (task.ownerPersonId) {
      const participant = participants.find((item) => item.personId === task.ownerPersonId)
      if (participant) addLink(nodeId, `participant:${participant.id}`, '负责执行')
    }
  })

  costs.forEach((cost) => {
    const nodeId = `cost:${cost.id}`
    addNode({
      id: nodeId,
      name: `${cost.category || '成本'} · ${formatGraphAmount(cost.amount)}`,
      kind: 'cost',
      typeLabel: cost.type === 'actual' ? '实际成本' : '预计成本',
      description: cost.description || '项目成本明细',
      relatedRecordUid: cost.assetRecordUid,
      metadata: [
        { label: '分类', value: cost.category || '未分类' },
        { label: '金额', value: formatGraphAmount(cost.amount) },
        { label: '日期', value: formatGraphDate(cost.occurredAt) },
        { label: '责任人', value: cost.responsiblePersonName || '未分配' }
      ],
      symbolSize: 28
    })
    addLink(projectNodeId, nodeId, '记录成本')
    if (cost.assetRecordUid) addLink(`asset:${cost.assetRecordUid}`, nodeId, '资产产生成本')
    if (cost.responsibleParticipantId) addLink(nodeId, `participant:${cost.responsibleParticipantId}`, '成本责任人')
  })

  return { nodes, links }
}

const getNodeColor = (kind: RelationshipNodeKind, palette: RelationshipGraphPalette): string => {
  if (kind === 'project' || kind === 'requirement') return palette.accent
  if (kind === 'document' || kind === 'asset') return palette.stateInfo
  if (kind === 'participant') return palette.stateSuccess
  if (kind === 'task') return palette.stateWarning
  return palette.stateError
}

const getRelationshipLinkKey = (link: RelationshipGraphLink): string =>
  `${link.source}:${link.target}:${link.relation}`

const getFlowAggregateNodeId = (kind: RelationshipNodeKind): string => `flow-group:${kind}`

const getRelationshipFlowStage = (kind: RelationshipNodeKind): (typeof relationshipFlowStages)[number] =>
  relationshipFlowStages.find((stage) => stage.key === relationshipFlowStageByKind[kind]) ?? relationshipFlowStages[1]

const layoutRelationshipFlowNodes = (nodes: RelationshipGraphNode[]): RelationshipGraphNode[] => {
  const stageX: Record<RelationshipFlowStageKey, number> = {
    upstream: 80,
    project: 420,
    business: 860,
    execution: 1340
  }
  const laneOffset: Record<RelationshipNodeKind, number> = {
    project: 0,
    document: 0,
    requirement: -150,
    asset: 170,
    task: -150,
    participant: 80,
    cost: 300
  }
  const groups = new Map<RelationshipNodeKind, RelationshipGraphNode[]>()
  ;(['project', ...relationshipNodeKinds] as RelationshipNodeKind[]).forEach((kind) => groups.set(kind, []))
  nodes.forEach((node) => groups.get(node.kind)?.push(node))

  const gridByKind = new Map<RelationshipNodeKind, { rows: number; columns: number; rowGap: number; columnGap: number }>()
  let maxGroupHeight = 0
  groups.forEach((group, kind) => {
    const rows = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(group.length))))
    const columns = Math.max(1, Math.ceil(group.length / rows))
    const dense = group.length > 16
    const rowGap = dense ? 48 : 64
    const columnGap = dense ? 48 : 72
    maxGroupHeight = Math.max(maxGroupHeight, (rows - 1) * rowGap)
    gridByKind.set(kind, { rows, columns, rowGap, columnGap })
  })
  const virtualHeight = Math.max(440, maxGroupHeight + 140)

  return nodes.map((node) => {
    const stage = getRelationshipFlowStage(node.kind)
    const group = groups.get(node.kind) ?? []
    const grid = gridByKind.get(node.kind) ?? { rows: 1, columns: 1, rowGap: 64, columnGap: 72 }
    const index = Math.max(0, group.findIndex((item) => item.id === node.id))
    const row = index % grid.rows
    const column = Math.floor(index / grid.rows)
    const gridWidth = Math.max(0, (grid.columns - 1) * grid.columnGap)
    const groupHeight = Math.max(0, (grid.rows - 1) * grid.rowGap)
    return {
      ...node,
      x: stageX[stage.key] + laneOffset[node.kind] - gridWidth / 2 + column * grid.columnGap,
      y: (virtualHeight - groupHeight) / 2 + row * grid.rowGap
    }
  })
}

const buildFlowDisplayGraph = (
  nodes: RelationshipGraphNode[],
  links: RelationshipGraphLink[],
  expandedKinds: Set<RelationshipNodeKind>
): { nodes: RelationshipGraphNode[]; links: RelationshipGraphLink[] } => {
  const nodesByKind = new Map<RelationshipNodeKind, RelationshipGraphNode[]>()
  nodes.forEach((node) => {
    const current = nodesByKind.get(node.kind) ?? []
    current.push(node)
    nodesByKind.set(node.kind, current)
  })
  const collapsedKinds = new Set(
    relationshipNodeKinds.filter((kind) => (nodesByKind.get(kind)?.length ?? 0) > 16 && !expandedKinds.has(kind))
  )
  if (!collapsedKinds.size) return { nodes, links }

  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const displayNodes = nodes
    .filter((node) => !collapsedKinds.has(node.kind))
    .slice()
  collapsedKinds.forEach((kind) => {
    const members = nodesByKind.get(kind) ?? []
    displayNodes.push({
      id: getFlowAggregateNodeId(kind),
      name: `${relationshipNodeMeta[kind].label} · ${members.length} 项`,
      kind,
      typeLabel: `${relationshipNodeMeta[kind].label}集合`,
      description: `已聚合 ${members.length} 个${relationshipNodeMeta[kind].label}节点，点击展开明细`,
      metadata: [
        { label: '节点数', value: `${members.length} 个` },
        { label: '查看方式', value: '点击集合节点或右侧索引' }
      ],
      symbolSize: 54,
      isAggregate: true,
      aggregateKind: kind
    })
  })

  const linkMap = new Map<string, RelationshipGraphLink>()
  links.forEach((link) => {
    const sourceNode = nodesById.get(link.source)
    const targetNode = nodesById.get(link.target)
    if (!sourceNode || !targetNode) return
    const source = collapsedKinds.has(sourceNode.kind) ? getFlowAggregateNodeId(sourceNode.kind) : link.source
    const target = collapsedKinds.has(targetNode.kind) ? getFlowAggregateNodeId(targetNode.kind) : link.target
    if (source === target) return
    const key = `${source}:${target}:${link.relation}`
    const originalKey = getRelationshipLinkKey(link)
    const existing = linkMap.get(key)
    if (existing) {
      existing.originalKeys = [...(existing.originalKeys ?? []), originalKey]
      return
    }
    linkMap.set(key, {
      source,
      target,
      relation: link.relation,
      originalKeys: [originalKey]
    })
  })

  return {
    nodes: displayNodes,
    links: [...linkMap.values()].map((link) => {
      const count = link.originalKeys?.length ?? 1
      return count > 1 ? { ...link, relation: `${link.relation} · ${count} 项` } : link
    })
  }
}

const collectRelationshipPath = (
  startId: string,
  links: RelationshipGraphLink[],
  direction: RelationshipPathDirection
): { nodeIds: Set<string>; linkKeys: Set<string> } => {
  const adjacentLinks = new Map<string, RelationshipGraphLink[]>()
  links.forEach((link) => {
    const nodeId = direction === 'upstream' ? link.target : link.source
    const current = adjacentLinks.get(nodeId) ?? []
    current.push(link)
    adjacentLinks.set(nodeId, current)
  })

  const nodeIds = new Set<string>()
  const linkKeys = new Set<string>()
  const pending = [startId]
  while (pending.length > 0) {
    const currentId = pending.shift()
    if (!currentId || nodeIds.has(currentId)) continue
    nodeIds.add(currentId)
    ;(adjacentLinks.get(currentId) ?? []).forEach((link) => {
      linkKeys.add(getRelationshipLinkKey(link))
      const nextId = direction === 'upstream' ? link.source : link.target
      if (!nodeIds.has(nextId)) pending.push(nextId)
    })
  }

  nodeIds.delete(startId)
  return { nodeIds, linkKeys }
}

const relationshipGraphTooltip = (node: RelationshipGraphNode): string => {
  const details = node.metadata
    .slice(0, 3)
    .map((item) => `${escapeGraphHtml(item.label)}：${escapeGraphHtml(item.value)}`)
    .join('<br />')
  return `<strong>${escapeGraphHtml(compactGraphLabel(node.name, 36))}</strong><br /><span>${escapeGraphHtml(node.typeLabel)}</span>${details ? `<br />${details}` : ''}`
}

export function ProjectRelationshipGraph({
  project,
  requirements,
  assets,
  participants,
  tasks,
  costs,
  documents,
  onOpenRecord,
  onOpenRequirement
}: {
  project: ManagedProject
  requirements: ProjectRequirement[]
  assets: ProjectAsset[]
  participants: ProjectParticipant[]
  tasks: ProjectPlanTask[]
  costs: ProjectCostEntry[]
  documents: ProjectDocumentSnapshot[]
  onOpenRecord: (uid: string) => void
  onOpenRequirement: (requirementId: string) => void
}): React.JSX.Element {
  const palette = useRelationshipGraphPalette()
  const [selectedKinds, setSelectedKinds] = useState<Set<RelationshipNodeKind>>(() => new Set(relationshipNodeKinds))
  const [viewMode, setViewMode] = useState<RelationshipGraphMode>('flow')
  const [search, setSearch] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [expandedFlowKinds, setExpandedFlowKinds] = useState<Set<RelationshipNodeKind>>(() => new Set())
  const [isCanvasFullscreen, setIsCanvasFullscreen] = useState(false)
  const [graphKey, setGraphKey] = useState(0)
  const graph = useMemo(
    () => buildRelationshipGraph(project, requirements, assets, participants, tasks, costs, documents, palette),
    [assets, costs, documents, palette, participants, project, requirements, tasks]
  )

  const matchingNodeIds = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return null
    const directMatches = new Set(
      graph.nodes
        .filter((node) => [node.name, node.typeLabel, node.description, ...node.metadata.map((item) => item.value)]
          .some((value) => value.toLocaleLowerCase().includes(query)))
        .map((node) => node.id)
    )
    const relatedMatches = new Set(directMatches)
    graph.links.forEach((link) => {
      if (directMatches.has(link.source)) relatedMatches.add(link.target)
      if (directMatches.has(link.target)) relatedMatches.add(link.source)
    })
    return relatedMatches
  }, [graph.links, graph.nodes, search])

  const visibleNodes = useMemo(() => {
    const projectNodeId = `project:${project.id}`
    return graph.nodes.filter((node) => {
      if (node.id === projectNodeId) return true
      if (!selectedKinds.has(node.kind)) return false
      return !matchingNodeIds || matchingNodeIds.has(node.id)
    })
  }, [graph.nodes, matchingNodeIds, project.id, selectedKinds])

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes])
  const visibleLinks = useMemo(
    () => graph.links.filter((link) => visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)),
    [graph.links, visibleNodeIds]
  )
  const flowDisplayGraph = useMemo(
    () => buildFlowDisplayGraph(visibleNodes, visibleLinks, expandedFlowKinds),
    [expandedFlowKinds, visibleLinks, visibleNodes]
  )
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedNodeLinks = selectedNode
    ? visibleLinks.filter((link) => link.source === selectedNode.id || link.target === selectedNode.id)
    : []
  const selectedNodeUpstreamLinks = selectedNodeLinks.filter((link) => link.target === selectedNode?.id)
  const selectedNodeDownstreamLinks = selectedNodeLinks.filter((link) => link.source === selectedNode?.id)
  const selectedLabelNodeIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>()
    const ids = new Set([selectedNodeId])
    if (selectedNodeLinks.length > 16) return ids
    selectedNodeLinks.slice(0, 8).forEach((link) => {
      ids.add(link.source === selectedNodeId ? link.target : link.source)
    })
    return ids
  }, [selectedNodeId, selectedNodeLinks])

  const selectedPath = useMemo(() => {
    if (!selectedNodeId) return null
    const upstream = collectRelationshipPath(selectedNodeId, visibleLinks, 'upstream')
    const downstream = collectRelationshipPath(selectedNodeId, visibleLinks, 'downstream')
    return {
      upstreamNodeIds: upstream.nodeIds,
      downstreamNodeIds: downstream.nodeIds,
      upstreamLinkKeys: upstream.linkKeys,
      downstreamLinkKeys: downstream.linkKeys,
      pathNodeIds: new Set([selectedNodeId, ...upstream.nodeIds, ...downstream.nodeIds]),
      pathLinkKeys: new Set([...upstream.linkKeys, ...downstream.linkKeys])
    }
  }, [selectedNodeId, visibleLinks])
  const broadSelection = Boolean(selectedNodeId && selectedNodeLinks.length > 16)
  const denseFlowGraph = viewMode === 'flow' && (flowDisplayGraph.nodes.length > 40 || flowDisplayGraph.links.length > 60)

  useEffect(() => {
    if (selectedNodeId && !visibleNodeIds.has(selectedNodeId)) setSelectedNodeId(null)
  }, [selectedNodeId, visibleNodeIds])

  useEffect(() => {
    if (!isCanvasFullscreen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsCanvasFullscreen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isCanvasFullscreen])

  const expandFlowKind = useCallback((kind: RelationshipNodeKind): void => {
    setExpandedFlowKinds((current) => {
      if (current.has(kind)) return current
      return new Set([...current, kind])
    })
  }, [])

  const selectRelationshipNode = useCallback((node: RelationshipGraphNode): void => {
    setSelectedNodeId(node.id)
    if (viewMode === 'flow' && (visibleNodes.filter((item) => item.kind === node.kind).length ?? 0) > 16) {
      expandFlowKind(node.kind)
    }
  }, [expandFlowKind, viewMode, visibleNodes])

  const handleChartClick = useCallback((params: unknown): void => {
    const data = (params as { data?: Partial<RelationshipGraphNode> }).data
    if (!data?.id || typeof data.id !== 'string') return
    if (data.isAggregate && data.aggregateKind) {
      expandFlowKind(data.aggregateKind)
      setSelectedNodeId(null)
      return
    }
    if (data.kind) selectRelationshipNode(data as RelationshipGraphNode)
  }, [expandFlowKind, selectRelationshipNode])

  const option = useMemo<EChartsOption>(() => {
    const chartGraph = viewMode === 'flow' ? flowDisplayGraph : { nodes: visibleNodes, links: visibleLinks }
    const positionedNodes = viewMode === 'flow' ? layoutRelationshipFlowNodes(chartGraph.nodes) : chartGraph.nodes
    const nodeKindCounts = new Map<RelationshipNodeKind, number>()
    chartGraph.nodes.forEach((node) => {
      nodeKindCounts.set(node.kind, (nodeKindCounts.get(node.kind) ?? 0) + 1)
    })
    const nodes = positionedNodes.map((node) => {
      const isSelected = selectedNodeId === node.id
      const isPathNode = !selectedNodeId || selectedPath?.pathNodeIds.has(node.id)
      const stage = getRelationshipFlowStage(node.kind)
      const denseKind = viewMode === 'flow' && (nodeKindCounts.get(node.kind) ?? 0) > 16
      const shouldShowLabel = viewMode === 'network'
        || !denseKind
        || selectedNodeId === node.id
        || (!broadSelection && selectedLabelNodeIds.has(node.id))
      return {
        ...node,
        symbolSize: isSelected
          ? Math.max(node.symbolSize, 34)
          : denseKind
            ? Math.min(node.symbolSize, 22)
            : node.symbolSize,
        label: {
          show: shouldShowLabel,
          position: (viewMode === 'flow'
            ? node.kind === 'project'
              ? 'inside'
              : stage.key === 'execution'
                ? 'left'
                : 'right'
            : 'right') as 'inside' | 'left' | 'right',
          color: isPathNode ? palette.textMain : palette.textMuted,
          fontSize: node.kind === 'project' ? 12 : 11,
          fontWeight: isSelected ? 700 : 500,
          formatter: (params: { name?: string | number }) => compactGraphLabel(String(params.name ?? ''), node.kind === 'project' ? 22 : 18)
        },
        itemStyle: {
          ...node.itemStyle,
          opacity: isPathNode ? 1 : 0.2,
          borderColor: isSelected ? palette.textMain : node.itemStyle?.borderColor,
          borderWidth: isSelected ? 3 : node.itemStyle?.borderWidth,
          shadowBlur: isSelected ? 24 : node.itemStyle?.shadowBlur,
          shadowColor: isSelected ? palette.accentSoft : node.itemStyle?.shadowColor
        }
      }
    })
    const links = chartGraph.links.map((link) => {
      const linkKey = getRelationshipLinkKey(link)
      const originalKeys = link.originalKeys ?? [linkKey]
      const isPathLink = !selectedNodeId || originalKeys.some((originalKey) => selectedPath?.pathLinkKeys.has(originalKey))
      const isUpstreamLink = originalKeys.some((originalKey) => selectedPath?.upstreamLinkKeys.has(originalKey))
      const isDownstreamLink = originalKeys.some((originalKey) => selectedPath?.downstreamLinkKeys.has(originalKey))
      const simplifyLinks = denseFlowGraph && (!selectedNodeId || broadSelection)
      const isEmphasizedLink = isPathLink && !broadSelection && !simplifyLinks
      const linkColor = selectedNodeId && isEmphasizedLink
        ? isUpstreamLink
          ? palette.stateInfo
          : palette.accent
        : palette.strokeStrong
      return {
        ...link,
        lineStyle: {
          color: linkColor,
          opacity: simplifyLinks
            ? 0.18
            : broadSelection
            ? 0.16
            : isPathLink
              ? (viewMode === 'flow' ? 0.78 : 0.62)
              : 0.14,
          width: selectedNodeId && isEmphasizedLink ? 2.4 : simplifyLinks ? 0.85 : viewMode === 'flow' ? 1.35 : 1,
          type: (!simplifyLinks && (isEmphasizedLink || !selectedNodeId) ? 'solid' : 'dashed') as 'solid' | 'dashed',
          curveness: viewMode === 'flow' ? (simplifyLinks ? 0.04 : 0.08) : 0.1
        },
        label: {
          show: Boolean(selectedNodeId && isEmphasizedLink),
          color: isUpstreamLink ? palette.stateInfo : isDownstreamLink ? palette.accent : palette.textMuted,
          fontSize: 10
        }
      }
    })
    return {
      animation: viewMode === 'network' && visibleNodes.length < 260,
      backgroundColor: 'transparent',
      title: visibleNodes.length ? undefined : { text: '当前筛选没有可展示的节点', left: 'center', top: 'middle', textStyle: { color: palette.textMuted, fontSize: 13, fontWeight: 500 } },
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: palette.surfaceOverlay,
        borderColor: palette.strokeStrong,
        textStyle: { color: palette.textMain, fontSize: 12 },
        formatter: (params: unknown) => {
          const data = (params as { data?: RelationshipGraphNode }).data
          return data?.id ? relationshipGraphTooltip(data) : ''
        }
      },
      legend: {
        show: false
      },
      series: [
        {
          type: 'graph',
          layout: viewMode === 'flow' ? 'none' : 'force',
          data: nodes,
          links,
          categories: relationshipNodeKinds.map((kind) => ({ name: relationshipNodeMeta[kind].label })),
          roam: true,
          draggable: true,
          focusNodeAdjacency: true,
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: viewMode === 'flow' ? [0, denseFlowGraph ? 7 : 10] : [0, 8],
          label: {
            show: true,
            position: 'right',
            color: palette.textMain,
            fontSize: 11,
            formatter: (params) => compactGraphLabel(String(params.name ?? ''))
          },
          lineStyle: {
            color: palette.strokeStrong,
            opacity: viewMode === 'flow' ? 0.68 : 0.58,
            width: 1,
            curveness: viewMode === 'flow' ? 0.08 : 0.1
          },
          emphasis: {
            focus: 'adjacency',
            lineStyle: { width: 2, opacity: 0.92, color: palette.accent }
          },
          edgeLabel: {
            show: Boolean(selectedNodeId && !broadSelection && !denseFlowGraph),
            color: palette.textMuted,
            fontSize: 10,
            formatter: (params) => String((params.data as RelationshipGraphLink | undefined)?.relation ?? '')
          },
          scaleLimit: { min: 0.45, max: 2.8 },
          force: viewMode === 'network'
            ? {
                repulsion: visibleNodes.length > 160 ? 330 : 460,
                gravity: 0.08,
                edgeLength: visibleNodes.length > 160 ? [80, 150] : [100, 190],
                friction: 0.72,
                layoutAnimation: visibleNodes.length < 260
              }
            : undefined
        }
      ]
    }
  }, [broadSelection, denseFlowGraph, flowDisplayGraph, palette, selectedLabelNodeIds, selectedNodeId, selectedNodeLinks.length, selectedPath, viewMode, visibleLinks, visibleNodes])

  const toggleKind = (kind: RelationshipNodeKind): void => {
    setSelectedKinds((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  const resetGraph = (): void => {
    setSelectedNodeId(null)
    setExpandedFlowKinds(new Set())
    setGraphKey((key) => key + 1)
  }

  const openSelectedNode = (): void => {
    if (!selectedNode) return
    if (selectedNode.relatedRecordUid) onOpenRecord(selectedNode.relatedRecordUid)
    if (selectedNode.relatedRequirementId) onOpenRequirement(selectedNode.relatedRequirementId)
  }

  const renderPathGroup = (direction: RelationshipPathDirection): React.JSX.Element => {
    const pathNodeIds = direction === 'upstream' ? selectedPath?.upstreamNodeIds : selectedPath?.downstreamNodeIds
    const directLinks = direction === 'upstream' ? selectedNodeUpstreamLinks : selectedNodeDownstreamLinks
    const pathNodes = visibleNodes
      .filter((node) => pathNodeIds?.has(node.id))
      .slice(0, 4)
    const isUpstream = direction === 'upstream'
    return (
      <div className={`project-relationship-path-group ${isUpstream ? 'is-upstream' : 'is-downstream'}`}>
        <div className="project-relationship-path-heading">
          <span>
            <ArrowRightOutlined rotate={isUpstream ? 180 : 0} aria-hidden="true" />
            {isUpstream ? '上游路径' : '下游路径'}
          </span>
          <strong>{pathNodeIds?.size ?? 0} 个</strong>
        </div>
        <Text type="secondary">直接 {directLinks.length} 条关系</Text>
        {pathNodes.length > 0 ? (
          <div className="project-relationship-path-nodes">
            {pathNodes.map((node) => (
              <button
                type="button"
                className="project-relationship-path-node"
                key={node.id}
                title={node.name}
                onClick={() => selectRelationshipNode(node)}
              >
                <span className={`project-relationship-filter-dot is-${node.kind}`} aria-hidden="true" />
                <span>{compactGraphLabel(node.name, 18)}</span>
              </button>
            ))}
            {(pathNodeIds?.size ?? 0) > pathNodes.length ? <small>还有 {(pathNodeIds?.size ?? 0) - pathNodes.length} 个</small> : null}
          </div>
        ) : (
          <span className="project-relationship-path-empty">暂无可见路径</span>
        )}
      </div>
    )
  }

  return (
    <div className={`project-relationship-page ${isCanvasFullscreen ? 'is-canvas-fullscreen' : ''}`}>
      <div className="project-relationship-toolbar">
        <div className="project-relationship-toolbar-copy">
          <div className="project-relationship-title-row">
            <Title level={4}>项目关系图谱</Title>
            <Tag className="project-status-capsule" color="purple">实时数据</Tag>
          </div>
          <Text type="secondary">展示当前项目的协议、需求、数据资产、计划与资源关系；拖动节点可调整视图</Text>
        </div>
        <Space wrap className="project-relationship-toolbar-actions">
          <Segmented
            className="project-relationship-view-mode"
            value={viewMode}
            aria-label="关系图谱视图模式"
            options={[
              { value: 'flow', label: <span><PartitionOutlined />上下游路径</span> },
              { value: 'network', label: <span><ShareAltOutlined />自由关系</span> }
            ]}
            onChange={(value) => {
              if (value === 'flow' || value === 'network') setViewMode(value)
            }}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索节点或属性"
            aria-label="搜索关系图谱节点"
            style={{ width: 220 }}
          />
          <Tooltip title={isCanvasFullscreen ? '退出画布全屏' : '画布全屏'}>
            <Button
              type={isCanvasFullscreen ? 'primary' : 'text'}
              icon={isCanvasFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              aria-label={isCanvasFullscreen ? '退出画布全屏' : '画布全屏'}
              onClick={() => setIsCanvasFullscreen((fullscreen) => !fullscreen)}
            />
          </Tooltip>
          <Tooltip title="重新布局">
            <Button type="text" icon={<ReloadOutlined />} aria-label="重新布局关系图谱" onClick={resetGraph} />
          </Tooltip>
        </Space>
      </div>

      <div className="project-relationship-summary" aria-label="关系图谱统计">
        <div className="project-relationship-stat"><span>节点</span><strong>{Math.max(0, graph.nodes.length - 1)}</strong><Text type="secondary">项目数据</Text></div>
        <div className="project-relationship-stat"><span>关系</span><strong>{graph.links.length}</strong><Text type="secondary">已识别关联</Text></div>
        <div className="project-relationship-stat"><span>数据资产</span><strong>{assets.length}</strong><Text type="secondary">可打开详情</Text></div>
        <div className="project-relationship-stat"><span>需求覆盖</span><strong>{requirements.length}</strong><Text type="secondary">当前需求版本</Text></div>
      </div>

      <div className="project-relationship-filter-bar" aria-label="关系图谱节点筛选">
        <Text type="secondary">显示节点</Text>
        <div className="project-relationship-filters">
          {relationshipNodeKinds.map((kind) => {
            const meta = relationshipNodeMeta[kind]
            const active = selectedKinds.has(kind)
            const count = graph.nodes.filter((node) => node.kind === kind).length
            return (
              <button
                type="button"
                className={`project-relationship-filter ${active ? 'is-active' : ''}`}
                key={kind}
                aria-pressed={active}
                aria-label={`${active ? '隐藏' : '显示'}${meta.label}节点，共 ${count} 个`}
                onClick={() => toggleKind(kind)}
              >
                <span className={`project-relationship-filter-dot is-${kind}`} aria-hidden="true" />
                {meta.label}<strong>{count}</strong>
              </button>
            )
          })}
        </div>
        <Text type="secondary" className="project-relationship-filter-result">画布显示 {Math.max(0, (viewMode === 'flow' ? flowDisplayGraph.nodes.length : visibleNodes.length) - 1)} 个节点</Text>
      </div>

      <div className="project-relationship-workbench">
        <section className="project-relationship-canvas-panel" aria-label="项目关系图谱画布">
          <div className="project-relationship-canvas-heading">
            <div>
              <Text strong>{viewMode === 'flow' ? '上下游路径' : '自由关系网络'}</Text>
              <Text type="secondary">{viewMode === 'flow' ? '箭头由上游指向下游，集合节点可展开，点击节点可查看完整路径' : '保留交叉关系，拖动节点可查看关联密度'}</Text>
            </div>
            <div className="project-relationship-canvas-heading-actions">
              <Text type="secondary">当前项目：{compactGraphLabel(project.projectName, 24)}</Text>
              <Tooltip title="收起展开节点">
                <Button
                  size="small"
                  type={expandedFlowKinds.size > 0 ? 'primary' : 'text'}
                  icon={<UpOutlined />}
                  aria-label="收起展开节点"
                  disabled={expandedFlowKinds.size === 0}
                  onClick={resetGraph}
                />
              </Tooltip>
            </div>
          </div>
          {viewMode === 'flow' ? (
            <div className="project-relationship-flow-guide" aria-label="上下游路径阶段">
              {relationshipFlowStages.map((stage, index) => (
                <React.Fragment key={stage.key}>
                  <div className={`project-relationship-flow-stage is-${stage.key}`}>
                    <span className="project-relationship-flow-stage-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="project-relationship-flow-stage-copy">
                      <strong>{stage.label}</strong>
                      <small>{stage.description}</small>
                    </span>
                  </div>
                  {index < relationshipFlowStages.length - 1 ? <ArrowRightOutlined className="project-relationship-flow-guide-arrow" aria-hidden="true" /> : null}
                </React.Fragment>
              ))}
            </div>
          ) : null}
          <div className="project-relationship-direction-legend" aria-label="关系方向说明">
            <span><ArrowRightOutlined aria-hidden="true" />箭头方向：上游 → 下游</span>
            <span className="is-upstream">上游路径</span>
            <span className="is-downstream">下游路径</span>
          </div>
          <div className="project-relationship-chart">
            {(viewMode === 'flow' ? flowDisplayGraph.nodes.length : visibleNodes.length) > 1 ? (
              <ReactECharts
                key={`${graphKey}:${viewMode}`}
                option={option}
                notMerge
                lazyUpdate
                opts={{ renderer: 'svg' }}
                onEvents={{ click: handleChartClick }}
                style={{ width: '100%', height: '100%' }}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选没有可展示的关系" />
            )}
          </div>
        </section>

        <aside className="project-relationship-inspector" aria-label="关系图谱节点详情">
          <div className="project-relationship-inspector-section">
            <div className="project-relationship-inspector-heading"><Text strong>节点详情</Text><Text type="secondary">{selectedNode ? selectedNode.typeLabel : '点击节点查看上下文'}</Text></div>
            {selectedNode ? (
              <div className="project-relationship-selected-node">
                <div className="project-relationship-selected-type">
                  <span className={`project-relationship-filter-dot is-${selectedNode.kind}`} aria-hidden="true" />
                  <Text type="secondary">{relationshipNodeMeta[selectedNode.kind].label}</Text>
                </div>
                <Title level={5} title={selectedNode.name}>{selectedNode.name}</Title>
                <Text type="secondary" className="project-relationship-selected-description">{selectedNode.description || '暂无描述'}</Text>
                <dl className="project-relationship-metadata">
                  {selectedNode.metadata.map((item) => <div key={item.label}><dt>{item.label}</dt><dd title={item.value}>{item.value}</dd></div>)}
                </dl>
                <div className="project-relationship-path-summary" aria-label={`${selectedNode.name}上下游路径`}>
                  {renderPathGroup('upstream')}
                  {renderPathGroup('downstream')}
                </div>
                {selectedNode.relatedRecordUid || selectedNode.relatedRequirementId ? (
                  <Button type="primary" ghost icon={<EyeOutlined />} onClick={openSelectedNode}>
                    {selectedNode.relatedRecordUid ? '查看数据详情' : '查看需求匹配'}
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="project-relationship-inspector-empty"><ProjectOutlined /><Text type="secondary">选择一个节点查看它与其它数据的连接</Text></div>
            )}
          </div>
          <div className="project-relationship-inspector-section project-relationship-node-index-section">
            <div className="project-relationship-inspector-heading"><Text strong>节点索引</Text><Text type="secondary">{visibleNodes.length - 1} 个</Text></div>
            <div className="project-relationship-node-index" role="list" aria-label="关系图谱节点索引">
              {visibleNodes.filter((node) => node.kind !== 'project').map((node) => (
                <button
                  type="button"
                  className={`project-relationship-node-index-item ${selectedNodeId === node.id ? 'is-selected' : ''}`}
                  key={node.id}
                  role="listitem"
                  aria-pressed={selectedNodeId === node.id}
                  onClick={() => selectRelationshipNode(node)}
                  title={node.name}
                >
                  <span className={`project-relationship-filter-dot is-${node.kind}`} aria-hidden="true" />
                  <span className="project-relationship-node-index-name">{node.name}</span>
                  <small>{node.typeLabel}</small>
                </button>
              ))}
            </div>
          </div>
          {selectedNode && selectedNodeLinks.length > 0 && (
            <div className="project-relationship-inspector-section project-relationship-links-section">
              <div className="project-relationship-inspector-heading"><Text strong>直接关联</Text><Text type="secondary">{selectedNodeLinks.length} 条</Text></div>
              <div className="project-relationship-link-list">
                {selectedNodeLinks.slice(0, 8).map((link) => {
                  const otherId = link.source === selectedNode.id ? link.target : link.source
                  const other = graph.nodes.find((node) => node.id === otherId)
                  if (!other) return null
                  const isDownstream = link.source === selectedNode.id
                  return (
                    <div className={`project-relationship-link-row ${isDownstream ? 'is-downstream' : 'is-upstream'}`} key={`${link.source}:${link.target}:${link.relation}`}>
                      <span className="project-relationship-link-direction" aria-label={isDownstream ? '下游' : '上游'}>
                        <ArrowRightOutlined rotate={isDownstream ? 0 : 180} aria-hidden="true" />
                      </span>
                      <span className="project-relationship-link-relation">{link.relation}</span>
                      <strong title={other.name}>{compactGraphLabel(other.name, 22)}</strong>
                    </div>
                  )
                })}
                {selectedNodeLinks.length > 8 && <Text type="secondary">还有 {selectedNodeLinks.length - 8} 条关系</Text>}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
