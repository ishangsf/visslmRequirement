import type {
  AssistantActivityKind,
  AssistantActivityStatus
} from '../../shared/expert-types'
import type { AssistantIntentDecision } from '../../shared/types'

export interface AssistantWorkLogDraft {
  kind: AssistantActivityKind
  stage: string
  title?: string
  summary: string
  status: AssistantActivityStatus
}

const taskLabel = (taskType: AssistantIntentDecision['taskType']): string => ({
  conversation: '普通对话',
  record_query: '数据中心查询',
  knowledge_qa: '知识库问答',
  mixed_analysis: '混合分析',
  visualization: '可视化交付',
  requirement_matching: '需求匹配',
  artifact_generation: '交付物生成'
}[taskType])

const sourceLabel = (sourceMode: AssistantIntentDecision['sourceMode']): string => ({
  conversation: '当前对话',
  records: '数据中心记录',
  knowledge: '知识库文档',
  mixed: '数据中心记录与知识库文档'
}[sourceMode])

const skillLabel = (skillId: AssistantIntentDecision['skillId']): string => ({
  general: '通用助手',
  'knowledge-base': '知识库专家',
  visualization: '可视化专家',
  'requirement-analysis': '需求分析专家',
  artifact: '交付物专家'
}[skillId])

/** Create the safe narrative emitted when the trusted intent is available. */
export const workLogForIntent = (decision: AssistantIntentDecision): AssistantWorkLogDraft => ({
  kind: 'narrative',
  stage: 'task-judgment',
  title: '任务判断已完成',
  summary: `已确认${taskLabel(decision.taskType)}，执行来源为${sourceLabel(decision.sourceMode)}。`,
  status: 'completed'
})

/** Create the safe narrative emitted after the execution skill is selected. */
export const workLogForSkill = (decision: AssistantIntentDecision): AssistantWorkLogDraft => ({
  kind: 'narrative',
  stage: 'skill-selection',
  title: '技能已选择',
  summary: `已选择${skillLabel(decision.skillId)}处理${taskLabel(decision.taskType)}。`,
  status: 'completed'
})

/**
 * Convert an internal progress stage into a user-facing activity.  The
 * progress message is deliberately ignored: it may be changed by an Agent
 * implementation and must never become a channel for raw tool arguments,
 * prompts, or provider reasoning.
 */
export const workLogForStatus = (stage: string, message = ''): AssistantWorkLogDraft => {
  const normalizedStage = stage.trim().toLocaleLowerCase()
  if (normalizedStage === 'classify') {
    return {
      kind: 'narrative',
      stage: 'task-judgment',
      title: '确认任务范围',
      summary: '正在确认请求目标与上下文。',
      status: 'running'
    }
  }
  if (normalizedStage === 'skill') {
    return {
      kind: 'narrative',
      stage: 'skill-selection',
      title: '选择执行技能',
      summary: '正在选择与任务来源匹配的执行技能。',
      status: 'running'
    }
  }
  if (normalizedStage === 'scope') {
    const confirmed = /已确认|确认完成/u.test(message)
    return {
      kind: 'checkpoint',
      stage: 'scope-confirmation',
      title: confirmed ? '范围已确认' : '确认执行范围',
      summary: confirmed ? '范围已确认，开始执行。' : '正在等待执行范围确认。',
      status: confirmed ? 'completed' : 'running'
    }
  }
  if (normalizedStage === 'query' || normalizedStage === 'scan' || normalizedStage === 'inspect' ||
      normalizedStage === 'profile' || normalizedStage === 'execute') {
    return {
      kind: 'tool',
      stage: 'query',
      title: normalizedStage === 'profile' ? '检查数据范围' : '执行数据查询',
      summary: normalizedStage === 'profile'
        ? '正在检查已确认范围内的字段与数据可用性。'
        : '正在按已确认计划查询数据中心记录。',
      status: 'running'
    }
  }
  if (normalizedStage === 'retrieve' || normalizedStage === 'search' || normalizedStage === 'locate' ||
      normalizedStage === 'recall' || normalizedStage === 'rerank' || normalizedStage === 'score' ||
      normalizedStage === 'explain') {
    return {
      kind: 'tool',
      stage: 'retrieval',
      title: normalizedStage === 'retrieve' || normalizedStage === 'search' ? '检索文档证据' : '核查候选证据',
      summary: normalizedStage === 'retrieve' || normalizedStage === 'search'
        ? '正在按已确认范围检索知识库文档证据。'
        : '正在按已确认范围核查候选证据。',
      status: 'running'
    }
  }
  if (normalizedStage === 'verify' || normalizedStage === 'validate') {
    return {
      kind: 'checkpoint',
      stage: 'evidence-verification',
      title: '核验证据',
      summary: '正在核对查询结果、证据来源与问题口径。',
      status: 'running'
    }
  }
  if (normalizedStage === 'answer' || normalizedStage === 'delivery' || normalizedStage === 'artifact') {
    return {
      kind: 'checkpoint',
      stage: 'delivery-preparation',
      title: '准备交付',
      summary: '正在整理可核验的最终回答与引用。',
      status: 'running'
    }
  }
  if (normalizedStage === 'intent') {
    return {
      kind: 'narrative',
      stage: 'task-judgment',
      title: '确认可视化目标',
      summary: '正在确认可视化目标与数据范围。',
      status: 'running'
    }
  }
  if (normalizedStage === 'compose' || normalizedStage === 'persist' || normalizedStage === 'summary') {
    return {
      kind: 'checkpoint',
      stage: 'delivery-preparation',
      title: '准备专业交付',
      summary: '正在整理已核验的专业分析结果。',
      status: 'running'
    }
  }
  if (normalizedStage === 'repair') {
    return {
      kind: 'narrative',
      stage: 'evidence-verification',
      title: '修正校验结果',
      summary: '正在根据校验结果修正交付内容。',
      status: 'running'
    }
  }
  if (normalizedStage === 'route' || normalizedStage === 'plan' || normalizedStage === 'generate') {
    return {
      kind: 'narrative',
      stage: normalizedStage,
      title: '形成执行计划',
      summary: '正在根据已确认任务形成执行步骤。',
      status: 'running'
    }
  }
  return {
    kind: 'narrative',
    stage: 'execution',
    title: '执行任务',
    summary: '正在执行已确认的助手任务。',
    status: 'running'
  }
}

export const workLogForEvidence = (records: number, documents: number): AssistantWorkLogDraft => {
  const safeRecords = Number.isFinite(records) && records >= 0 ? Math.trunc(records) : 0
  const safeDocuments = Number.isFinite(documents) && documents >= 0 ? Math.trunc(documents) : 0
  const parts: string[] = []
  if (safeRecords > 0) parts.push(`数据中心 ${safeRecords} 条记录`)
  if (safeDocuments > 0) parts.push(`知识库 ${safeDocuments} 条文档证据`)
  return {
    kind: 'checkpoint',
    stage: 'evidence',
    title: '证据已返回',
    summary: parts.length ? `已获得${parts.join('、')}，进入核验。` : '本轮未获得可核验证据。',
    status: parts.length ? 'completed' : 'warning'
  }
}

export const workLogForVerification = (): AssistantWorkLogDraft => ({
  kind: 'checkpoint',
  stage: 'evidence-verification',
  title: '证据核验完成',
  summary: '已确认回答只使用本轮可核验来源。',
  status: 'completed'
})

export const workLogForDelivery = (): AssistantWorkLogDraft => ({
  kind: 'checkpoint',
  stage: 'delivery-preparation',
  title: '交付准备完成',
  summary: '已形成最终回答与可核验引用。',
  status: 'completed'
})

export const workLogForFailure = (stage = 'execution'): AssistantWorkLogDraft => ({
  kind: 'checkpoint',
  stage: new Set([
    'task-judgment',
    'skill-selection',
    'scope-confirmation',
    'query',
    'retrieval',
    'evidence',
    'evidence-verification',
    'delivery-preparation',
    'execution'
  ]).has(stage) ? stage : 'execution',
  title: '执行未完成',
  summary: '当前阶段未完成，未交付未经核验的结果。',
  status: 'failed'
})
