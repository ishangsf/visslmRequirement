import type {
  AssistantClarificationOption,
  AssistantIntentDecision
} from '../../shared/types'

const concise = (value: string, fallback: string): string => {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized ? normalized.slice(0, 500) : fallback
}

export const buildAssistantClarificationOptions = (input: {
  originalQuestion: string
  clarificationQuestion: string
  intent?: AssistantIntentDecision
}): AssistantClarificationOption[] => {
  const originalQuestion = concise(input.originalQuestion, '请处理这个问题')
  const taskType = input.intent?.taskType ?? 'conversation'

  if (taskType === 'record_query' || taskType === 'mixed_analysis') {
    return [
      {
        id: 'use-current-data-scope',
        label: '按当前数据范围继续',
        description: '使用当前账号可访问的数据，不再要求确认内部查询参数。',
        prompt: `请按当前可访问的数据范围直接查询并回答：${originalQuestion}`,
        action: 'submit'
      },
      {
        id: 'add-record-filter',
        label: '补充对象或条件',
        description: '填写名称、项目、时间或其他业务筛选条件。',
        prompt: `${originalQuestion}\n\n补充对象或条件：`,
        action: 'compose'
      },
      {
        id: 'switch-to-knowledge',
        label: '改查知识资料',
        description: '改为从知识库文档中查找答案。',
        prompt: `请从知识库资料中回答：${originalQuestion}`,
        action: 'submit'
      }
    ]
  }

  if (taskType === 'knowledge_qa') {
    return [
      {
        id: 'add-knowledge-topic',
        label: '补充资料主题',
        description: '填写文档、主题或关键字。',
        prompt: `${originalQuestion}\n\n要查找的资料主题：`,
        action: 'compose'
      },
      {
        id: 'switch-to-records',
        label: '改查数据记录',
        description: '改为查询数据中心中的结构化记录。',
        prompt: `请从数据中心记录中查询并回答：${originalQuestion}`,
        action: 'submit'
      }
    ]
  }

  if (taskType === 'requirement_matching') {
    return [
      {
        id: 'add-requirement-target',
        label: '补充需求名称',
        description: '填写要匹配或比较的具体需求。',
        prompt: `${originalQuestion}\n\n目标需求名称或编号：`,
        action: 'compose'
      },
      {
        id: 'use-current-requirements',
        label: '按当前需求范围继续',
        description: '使用当前会话和当前账号可访问的需求数据。',
        prompt: `请按当前会话中的需求对象和可访问范围直接处理：${originalQuestion}`,
        action: 'submit'
      }
    ]
  }

  if (taskType === 'artifact_generation') {
    return [
      {
        id: 'add-artifact-goal',
        label: '补充交付目标',
        description: '说明要生成的交付物及用途。',
        prompt: `${originalQuestion}\n\n交付物类型和用途：`,
        action: 'compose'
      },
      {
        id: 'answer-without-artifact',
        label: '先直接回答',
        description: '暂不生成文件或看板，只返回文字答案。',
        prompt: `暂不生成交付物，请直接回答：${originalQuestion}`,
        action: 'submit'
      }
    ]
  }

  return [
    {
      id: 'choose-record-query',
      label: '查询数据记录',
      description: '从数据中心统计、筛选或列出记录。',
      prompt: `请查询数据中心记录，具体目标是：${originalQuestion}`,
      action: 'compose'
    },
    {
      id: 'choose-knowledge-search',
      label: '查找知识资料',
      description: '从知识库文档中查找答案。',
      prompt: `请查询知识库资料，具体问题是：${originalQuestion}`,
      action: 'compose'
    },
    {
      id: 'choose-direct-answer',
      label: '直接回答问题',
      description: '不访问业务数据，按普通问答处理。',
      prompt: `请直接回答，不查询数据中心或知识库：${originalQuestion}`,
      action: 'submit'
    }
  ]
}
