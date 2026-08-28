import type { DataScope } from '../../shared/query-spec'
import type {
  DashboardDomainRole,
  DashboardScenarioStatus
} from '../../shared/dashboard-domain'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'

/**
 * The request parser is deliberately a recognizer, not a planner.  It only
 * identifies the controlled domain vocabulary and leaves role clarification,
 * data availability and activation decisions to the planner.
 */
export interface DashboardDomainRequestResult {
  recognized: boolean
  role?: DashboardDomainRole
  scenario?: string
  scenarioStatus?: DashboardScenarioStatus
  tailoringBaselineId?: string
  permissions?: readonly string[]
  provenance?: {
    source: 'local-single-user-policy'
  }
  request: string
  scope: DataScope
}

const localPermissions = ['project:read', 'process:evidence:read'] as const
const localProvenance = { source: 'local-single-user-policy' } as const

const roleMatchers: readonly {
  role: DashboardDomainRole
  pattern: RegExp
}[] = [
  {
    role: 'project-owner',
    pattern: /项目负责人|项目经理|项目主管|项目\s*owner|project\s+owner/i
  },
  {
    role: 'qa-epg',
    pattern: /qa\s*[/／]\s*epg|qa\s+epg|质量(?:保证|与过程)?负责人|过程负责人|质量工程组/i
  },
  {
    role: 'rd-lead',
    pattern: /研发负责人|研发主管|开发负责人|技术负责人|研发组长|rd\s*lead/i
  },
  {
    role: 'model-org-manager',
    pattern: /型号(?:与|和|\/)组织(?:管理)?负责人|型号组织管理负责人|组织管理负责人|型号负责人|组织负责人|model\s*[/／-]?\s*org/i
  }
]

/**
 * Match the most specific terms first so that a GJB process-evidence request
 * is not mistaken for a generic quality request.  Scenario ids/statuses are
 * resolved from the catalog below rather than duplicated here.
 */
const scenarioMatchers: readonly {
  id: string
  pattern: RegExp
}[] = [
  {
    id: 'gjb5000b-compliance',
    pattern: /gjb\s*[- ]?\s*5000\s*b|gjb5000b|过程证据|过程符合(?:度|性)?|裁剪基线|过程审计/i
  },
  {
    id: 'software-quality',
    pattern: /软件研发生命周期质量|软件质量|研发质量/i
  },
  {
    id: 'requirements-delivery',
    pattern: /需求(?:到|至)交付(?:全链路)?|需求交付|需求完成|需求管理|需求状态|双向追溯/i
  },
  {
    id: 'plan-milestone',
    pattern: /计划与里程碑|里程碑|项目计划/i
  },
  {
    id: 'test-validation',
    pattern: /测试(?:与|和)?验证(?:充分性)?|验证测试|测试质量|测试大屏/i
  },
  {
    id: 'configuration-change',
    pattern: /配置与变更|配置变更|变更管理|配置管理/i
  },
  {
    id: 'organization-improvement',
    pattern: /组织改进|组织能力|过程改进/i
  },
  {
    id: 'project-overview',
    pattern: /项目综合态势|综合态势|项目健康(?:度)?|项目总览|项目概览/i
  }
]

const domainPatterns: readonly RegExp[] = [
  /软件研发(?:生命周期)?/i,
  /生命周期/i,
  /gjb\s*[- ]?\s*5000\s*b|gjb5000b/i,
  /项目(?:综合态势|健康(?:度)?|总览|概览)/i,
  /需求(?:到|至)交付|需求交付|需求管理|双向追溯|项目计划|里程碑/i,
  /过程证据|过程符合|裁剪基线|过程审计/i,
  /软件质量|研发质量|测试(?:与|和)?验证|配置变更|组织改进/i
]

const sampleBaselinePattern = /受控样例|controlled\s+sample|sample-tailoring-baseline-v1/i

const findScenario = (question: string): {
  id: string
  status: DashboardScenarioStatus
} | undefined => {
  const match = scenarioMatchers.find(({ pattern }) => pattern.test(question))
  if (match) {
    const scenario = dashboardDomainCatalog.scenarios.find(({ id }) => id === match.id)
    if (scenario) {
      return { id: scenario.id, status: scenario.status }
    }
  }

  return undefined
}

const cloneScope = (scope: DataScope): DataScope => ({ ...scope })

/**
 * Recognize a domain request while preserving the user's exact request and
 * scope.  No role is guessed from scenario words, and planned scenarios are
 * reported as planned rather than being activated or marked ready.
 */
export const resolveDashboardDomainRequest = (
  question: string,
  scope: DataScope
): DashboardDomainRequestResult => {
  const recognizedByScenario = scenarioMatchers.some(({ pattern }) => pattern.test(question))
  const recognizedByDomain = domainPatterns.some((pattern) => pattern.test(question))
  const recognized = recognizedByScenario || recognizedByDomain
  const preservedScope = cloneScope(scope)

  if (!recognized) {
    return {
      recognized: false,
      request: question,
      scope: preservedScope
    }
  }

  const matchedScenario = findScenario(question) ?? {
    id: 'project-overview',
    status: dashboardDomainCatalog.scenarios.find(({ id }) => id === 'project-overview')?.status ?? 'active'
  }
  const matchedRole = roleMatchers.find(({ pattern }) => pattern.test(question))?.role

  return {
    recognized: true,
    ...(matchedRole ? { role: matchedRole } : {}),
    scenario: matchedScenario.id,
    scenarioStatus: matchedScenario.status,
    ...(sampleBaselinePattern.test(question)
      ? { tailoringBaselineId: 'sample-tailoring-baseline-v1' }
      : {}),
    permissions: localPermissions,
    provenance: localProvenance,
    request: question,
    scope: preservedScope
  }
}
