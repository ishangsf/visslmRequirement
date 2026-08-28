import type {
  DashboardDomainCatalog,
  DashboardDomainComponent,
  DashboardDomainQuestion,
  DashboardGoldenScenario,
  DashboardMetricSourceField,
  DashboardThresholdOperator,
  DashboardQualityPolicy,
  MetricCatalogEntry,
  ProcessBinding
} from '../../shared/dashboard-domain'

/**
 * First-slice domain catalog for the SDLC/GJB5000B dashboard design.
 *
 * These are deliberately controlled sample semantics. The catalog is a
 * planning and validation contract, not a compliance certificate. Production
 * wiring must be supplied by a platform adapter that resolves real project,
 * process, tailoring and evidence records without generating arbitrary SQL.
 */

const sourceField = (
  sourceKey: string,
  nodeType: string,
  field: string,
  relationKey: string,
  availability: DashboardMetricSourceField['availability'],
  note?: string
): DashboardMetricSourceField => ({
  sourceKey,
  nodeType,
  field,
  relationKey,
  availability,
  ...(note ? { note } : {})
})

const sampleThreshold = (
  id: string,
  label: string,
  operator: DashboardThresholdOperator,
  value: number | readonly [number, number],
  interpretation: string
) => ({ id, label, operator, value, interpretation })

const sampleBaselineId = 'sample-tailoring-baseline-v1'

const metrics: readonly MetricCatalogEntry[] = [
  {
    id: 'project-health',
    label: '项目健康度',
    definition: '按版本化的受控规则汇总项目进展、需求、质量、风险与成本信号的综合指标；缺少任一必需来源时必须标记不可判定。',
    formulaVersion: 'sample-project-health-v1',
    sourceFields: [
      sourceField('sample.pm_projects.risk_factor', 'pm_projects', 'risk_factor', 'pm_projects.id', 'partial', '仅表示项目风险因子，不等同于健康分。'),
      sourceField('sample.pm_project_tasks.progress_percent', 'pm_project_tasks', 'progress_percent', 'pm_project_tasks.project_id -> pm_projects.id', 'partial'),
      sourceField('sample.pm_requirements.status', 'pm_requirements', 'status', 'pm_requirements.project_id -> pm_projects.id', 'partial'),
      sourceField('sample.pm_projects.actual_cost', 'pm_projects', 'actual_cost', 'pm_projects.id', 'partial')
    ],
    timeSemantics: '项目快照时点；以 source record 的 updatedAt/syncedAt 作为观察时间，不能混合不同快照。',
    applicableScopes: ['managed-project', 'project-portfolio'],
    thresholds: [
      sampleThreshold('sample-health-low', '受控样例：需关注', 'lt', 60, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-health-watch', '受控样例：观察', 'between', [60, 80], '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-health-good', '受控样例：稳定', 'gte', 80, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'model-org-manager'],
    processRequirementIds: ['process.project-health'],
    availability: 'partial',
    format: 'number',
    notes: ['当前仓库没有权威 healthScore 字段；真实平台适配器必须提供并版本化综合公式。']
  },
  {
    id: 'milestone-achievement',
    label: '里程碑达成率',
    definition: '项目计划中 taskType=milestone 的完成数量与里程碑总数之比；也可由 progressPercent 聚合，但口径必须由目录版本固定。',
    formulaVersion: 'sample-milestone-achievement-v1',
    sourceFields: [
      sourceField('sample.pm_project_tasks.task_type', 'pm_project_tasks', 'task_type', 'pm_project_tasks.project_id -> pm_projects.id', 'partial'),
      sourceField('sample.pm_project_tasks.status', 'pm_project_tasks', 'status', 'pm_project_tasks.project_id -> pm_projects.id', 'partial'),
      sourceField('sample.pm_project_tasks.progress_percent', 'pm_project_tasks', 'progress_percent', 'pm_project_tasks.project_id -> pm_projects.id', 'partial')
    ],
    timeSemantics: '项目计划快照时点；只纳入同一 project_id 下的 milestone 任务。',
    applicableScopes: ['managed-project'],
    thresholds: [
      sampleThreshold('sample-milestone-low', '受控样例：偏低', 'lt', 0.6, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-milestone-watch', '受控样例：观察', 'between', [0.6, 0.9], '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-milestone-good', '受控样例：较好', 'gte', 0.9, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'rd-lead'],
    processRequirementIds: ['process.milestone-tracking'],
    availability: 'partial',
    format: 'percent',
    numerator: 'status=completed 的 milestone 数量',
    denominator: 'taskType=milestone 的任务数量',
    notes: ['分母为零时返回 unavailable，不返回 0 以免混淆“无里程碑”和“未完成”。']
  },
  {
    id: 'requirement-completion',
    label: '需求完成率',
    definition: '已审核且属于已发布需求集的 satisfied 需求数量除以同口径 approved 需求数量。',
    formulaVersion: 'sample-requirement-completion-v1',
    sourceFields: [
      sourceField('sample.pm_requirements.review_status', 'pm_requirements', 'review_status', 'pm_requirements.project_id -> pm_projects.id', 'partial'),
      sourceField('sample.pm_requirements.status', 'pm_requirements', 'status', 'pm_requirements.project_id -> pm_projects.id', 'partial'),
      sourceField('sample.pm_requirement_sets.status', 'pm_requirement_sets', 'status', 'pm_requirement_sets.project_id -> pm_projects.id', 'partial')
    ],
    timeSemantics: '已发布需求集版本的审核快照时点；不得把 reviewing 草稿与 published 版本混计。',
    applicableScopes: ['managed-project'],
    thresholds: [
      sampleThreshold('sample-requirement-low', '受控样例：偏低', 'lt', 0.6, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-requirement-watch', '受控样例：观察', 'between', [0.6, 0.9], '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-requirement-good', '受控样例：较好', 'gte', 0.9, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.requirement-status'],
    availability: 'partial',
    format: 'percent',
    numerator: 'approved + published + status=satisfied 的需求数',
    denominator: 'approved + published 的需求数',
    notes: ['statusSource 仍需随结果保存，以区分 ai、manual、system_rule 与 legacy_unverified。']
  },
  {
    id: 'defect-density',
    label: '缺陷密度',
    definition: '经确认的缺陷数量除以同一范围和版本下的受控规模分母；当前仓库只有通用记录与可选字段，缺少生产规模分母。',
    formulaVersion: 'sample-defect-density-v1',
    sourceFields: [
      sourceField('sample.records.issue.node_type', 'Issue', 'node_type', 'records.project_id -> external Project UID', 'insufficient', 'Issue 仅在脱敏样例中出现，需真实平台确认。'),
      sourceField('sample.records.issue.status', 'Issue', 'status', 'records.uid', 'insufficient'),
      sourceField('sample.records.scope_size_denominator', 'Project', 'controlledSize', 'records.project_id -> external Project UID', 'missing', '当前 AnalyticsRecord/PM 模型没有受控规模字段。')
    ],
    timeSemantics: '项目/版本快照；缺陷和规模分母必须来自同一 scope 与同一版本。',
    applicableScopes: ['analytics-project', 'release-version'],
    thresholds: [
      sampleThreshold('sample-defect-low', '受控样例：较低', 'lte', 0.05, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-defect-watch', '受控样例：观察', 'between', [0.05, 0.15], '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-defect-high', '受控样例：偏高', 'gt', 0.15, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['qa-epg', 'rd-lead'],
    processRequirementIds: ['process.defect-classification'],
    availability: 'insufficient',
    format: 'number',
    numerator: '受控缺陷数量',
    denominator: '受控规模（待平台适配器提供）',
    notes: ['没有规模分母时必须澄清或显示 unavailable，禁止退化为缺陷总数。']
  },
  {
    id: 'high-risk-count',
    label: '高风险数',
    definition: '风险登记项中达到已批准阈值的风险数量；项目 riskFactor 只能作为候选信号，不能直接当作风险项计数。',
    formulaVersion: 'sample-high-risk-count-v1',
    sourceFields: [
      sourceField('sample.pm_projects.risk_factor', 'pm_projects', 'risk_factor', 'pm_projects.id', 'insufficient', '当前只有项目级风险因子，没有风险登记项与阈值版本。'),
      sourceField('sample.records.risk-register', 'Risk', 'severity', 'records.project_id -> external Project UID', 'missing', '真实 Risk nodeType/字段需平台目录确认。')
    ],
    timeSemantics: '风险登记快照时点；阈值必须与 metric formulaVersion 一同记录。',
    applicableScopes: ['managed-project', 'analytics-project'],
    thresholds: [
      sampleThreshold('sample-risk-high', '受控样例：高风险', 'gte', 0.8, '仅为样例阈值，不能视为官方阈值'),
      sampleThreshold('sample-risk-medium', '受控样例：中风险', 'between', [0.5, 0.8], '仅为样例阈值，不能视为官方阈值')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'model-org-manager'],
    processRequirementIds: ['process.risk-register'],
    availability: 'insufficient',
    format: 'number',
    notes: ['未确认 Risk 记录、分类字段和阈值时，不能由 riskFactor 静默替代。']
  },
  {
    id: 'process-compliance',
    label: '过程合规率',
    definition: '已声明裁剪基线下，具备充分证据且通过受控检查的过程活动数量除以适用检查总数；当前仓库没有过程证据模型。',
    formulaVersion: 'sample-process-compliance-v1',
    sourceFields: [
      sourceField('sample.process.tailoring-baseline', 'ProcessBaseline', 'baselineId', 'process.projectId -> baselineId', 'missing', '当前没有 ProcessBaseline 表或等价记录。'),
      sourceField('sample.process.activity-evidence', 'ProcessEvidence', 'evidenceStatus', 'evidence.activityId -> projectId', 'missing', '当前没有过程活动/工作产品/证据记录。'),
      sourceField('sample.process.check-result', 'ProcessCheck', 'result', 'check.activityId -> evidenceId', 'missing', '当前没有受控检查结果。')
    ],
    timeSemantics: '项目过程审计快照；必须绑定裁剪基线版本与证据生成时间。',
    applicableScopes: ['managed-project', 'process-audit'],
    thresholds: [
      sampleThreshold('sample-process-low', '受控样例：不足', 'lt', 0.8, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-process-good', '受控样例：充分', 'gte', 0.8, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['qa-epg', 'model-org-manager', 'project-owner'],
    processRequirementIds: ['process.baseline-evidence'],
    availability: 'missing',
    format: 'percent',
    numerator: '有充分证据且检查通过的适用活动数',
    denominator: '裁剪基线声明的适用活动数',
    notes: ['没有基线、活动、工作产品和证据时必须阻断“合规”结论。']
  },
  {
    id: 'requirement-stability',
    label: '需求稳定度',
    definition: '当前受控需求基线中未发生实质变更的需求数量占基线需求总数的比例；必须绑定同一基线版本和统计周期。',
    formulaVersion: 'sample-requirement-stability-v1',
    sourceFields: [
      sourceField('sample.requirements.baseline_total', 'RequirementsDeliverySample', 'baselineRequirementCount', 'record.projectId -> requirementBaseline.projectId', 'partial'),
      sourceField('sample.requirements.changed_count', 'RequirementsDeliverySample', 'changedRequirementCount', 'record.baselineId -> requirementBaseline.id', 'partial')
    ],
    timeSemantics: '需求基线快照；变更数量与基线总量必须属于同一版本和统计截止时间。',
    applicableScopes: ['managed-project', 'requirement-baseline'],
    thresholds: [
      sampleThreshold('sample-requirement-stability-low', '受控样例：波动较大', 'lt', 0.8, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-requirement-stability-good', '受控样例：相对稳定', 'gte', 0.8, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.requirement-baseline-control'],
    availability: 'partial',
    format: 'percent',
    numerator: '基线需求总数 - 统计周期内实质变更需求数',
    denominator: '同一基线版本的需求总数'
  },
  {
    id: 'requirement-review-completion',
    label: '需求评审完成率',
    definition: '已完成受控评审并形成结论的需求数量占应评审需求总数的比例。',
    formulaVersion: 'sample-requirement-review-completion-v1',
    sourceFields: [
      sourceField('sample.requirements.review_status', 'RequirementsDeliverySample', 'reviewCompletion', 'record.projectId -> requirementReview.projectId', 'partial')
    ],
    timeSemantics: '需求评审快照；只统计当前基线声明的应评审需求。',
    applicableScopes: ['managed-project', 'requirement-baseline'],
    thresholds: [
      sampleThreshold('sample-review-low', '受控样例：未完成', 'lt', 0.9, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-review-good', '受控样例：已覆盖', 'gte', 0.9, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.requirement-review'],
    availability: 'partial',
    format: 'percent'
  },
  {
    id: 'requirement-change-rate',
    label: '需求变更率',
    definition: '统计周期内经批准的实质变更需求数量占周期开始时受控基线需求总数的比例。',
    formulaVersion: 'sample-requirement-change-rate-v1',
    sourceFields: [
      sourceField('sample.requirements.approved_changes', 'RequirementsDeliverySample', 'requirementChangeRate', 'record.baselineId -> changeRequest.baselineId', 'partial')
    ],
    timeSemantics: '按需求基线快照时间形成趋势，不得跨基线直接累计。',
    applicableScopes: ['managed-project', 'requirement-baseline'],
    thresholds: [
      sampleThreshold('sample-change-low', '受控样例：较稳定', 'lte', 0.1, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-change-watch', '受控样例：需关注', 'gt', 0.1, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.requirement-change-control'],
    availability: 'partial',
    format: 'percent'
  },
  {
    id: 'development-completion',
    label: '开发完成率',
    definition: '已实现并通过开发侧完成判定的受控需求数量占当前基线需求总数的比例。',
    formulaVersion: 'sample-development-completion-v1',
    sourceFields: [
      sourceField('sample.delivery.development_status', 'RequirementsDeliverySample', 'developmentCompletion', 'record.requirementId -> developmentItem.requirementId', 'partial')
    ],
    timeSemantics: '交付快照；完成状态必须与当前需求基线一致。',
    applicableScopes: ['managed-project', 'release-version'],
    thresholds: [
      sampleThreshold('sample-development-low', '受控样例：偏低', 'lt', 0.8, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-development-good', '受控样例：较好', 'gte', 0.8, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'rd-lead'],
    processRequirementIds: ['process.requirement-development'],
    availability: 'partial',
    format: 'percent'
  },
  {
    id: 'requirement-test-coverage',
    label: '需求测试覆盖率',
    definition: '至少关联一个已纳入当前验证范围测试用例的受控需求数量占应验证需求总数的比例。',
    formulaVersion: 'sample-requirement-test-coverage-v1',
    sourceFields: [
      sourceField('sample.delivery.test_coverage', 'RequirementsDeliverySample', 'testCoverage', 'record.requirementId -> testCase.requirementId', 'insufficient', '当前仅有受控汇总值，真实适配器需提供需求与测试用例关系。'),
      sourceField('sample.validation.requirement_coverage', 'TestValidationSample', 'testCoverage', 'record.requirementSetId -> testCase.requirementId', 'insufficient', '测试充分性场景的受控覆盖汇总值。')
    ],
    timeSemantics: '验证范围快照；需求和测试用例必须属于同一版本。',
    applicableScopes: ['managed-project', 'release-version'],
    thresholds: [
      sampleThreshold('sample-test-coverage-low', '受控样例：不足', 'lt', 0.9, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-test-coverage-good', '受控样例：充分', 'gte', 0.9, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.requirement-verification'],
    availability: 'insufficient',
    format: 'percent'
  },
  {
    id: 'bidirectional-traceability',
    label: '双向追溯完整率',
    definition: '同时具备上游来源和下游设计、实现或验证关系的受控需求数量占应追溯需求总数的比例。',
    formulaVersion: 'sample-bidirectional-traceability-v1',
    sourceFields: [
      sourceField('sample.delivery.traceability', 'RequirementsDeliverySample', 'traceabilityCompleteness', 'record.requirementId -> traceLink.requirementId', 'insufficient', '当前仅有受控汇总值，真实适配器需提供可审计追溯边。')
    ],
    timeSemantics: '需求基线与交付版本联合快照；追溯边必须保留方向、对象版本和状态。',
    applicableScopes: ['managed-project', 'requirement-baseline', 'release-version'],
    thresholds: [
      sampleThreshold('sample-traceability-low', '受控样例：不完整', 'lt', 1, '正式使用前应由业务确认完整率要求'),
      sampleThreshold('sample-traceability-complete', '受控样例：完整', 'eq', 1, '仅表示受控样例达到全量关联')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.bidirectional-traceability'],
    availability: 'insufficient',
    format: 'percent'
  },
  {
    id: 'plan-completion-rate',
    label: '计划完成率',
    definition: '统计快照中按计划应完成且已完成的任务数量占应完成任务总数的比例。',
    formulaVersion: 'sample-plan-completion-rate-v1',
    sourceFields: [
      sourceField('sample.plan.completion', 'PlanMilestoneSample', 'planCompletionRate', 'record.projectId -> plan.projectId', 'partial')
    ],
    timeSemantics: '项目计划快照；分子分母必须使用同一数据日期和计划版本。',
    applicableScopes: ['managed-project', 'project-plan'],
    thresholds: [
      sampleThreshold('sample-plan-completion-low', '受控样例：偏低', 'lt', 0.8, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-plan-completion-good', '受控样例：正常', 'gte', 0.8, '仅为样例分段，需业务确认后启用')
    ],
    ownerRoles: ['project-owner', 'rd-lead'],
    processRequirementIds: ['process.plan-monitoring'],
    availability: 'partial',
    format: 'percent'
  },
  {
    id: 'schedule-variance-days',
    label: '进度偏差天数',
    definition: '当前计划快照相对已批准基准计划的进度日期偏差；正值表示延期，负值表示提前。',
    formulaVersion: 'sample-schedule-variance-days-v1',
    sourceFields: [
      sourceField('sample.plan.schedule_variance', 'PlanMilestoneSample', 'scheduleVarianceDays', 'record.planVersion -> baselinePlan.version', 'partial')
    ],
    timeSemantics: '按计划快照时间形成趋势，必须保留对比的基准计划版本。',
    applicableScopes: ['managed-project', 'project-plan'],
    thresholds: [
      sampleThreshold('sample-schedule-on-time', '受控样例：按计划', 'lte', 0, '仅为样例分段，需业务确认后启用'),
      sampleThreshold('sample-schedule-watch', '受控样例：有偏差', 'gt', 0, '正值表示相对基准计划延期')
    ],
    ownerRoles: ['project-owner', 'rd-lead'],
    processRequirementIds: ['process.schedule-variance-review'],
    availability: 'partial',
    unit: '天',
    format: 'duration'
  },
  {
    id: 'delayed-task-count',
    label: '延期任务数',
    definition: '选定统计周期各计划快照中已超过计划完成日期且尚未完成的任务数量平均值。',
    formulaVersion: 'sample-delayed-task-count-v1',
    sourceFields: [
      sourceField('sample.plan.delayed_tasks', 'PlanMilestoneSample', 'delayedTaskCount', 'record.projectId -> task.projectId', 'partial')
    ],
    timeSemantics: '周期快照平均；当前 QuerySpec 不支持 latest，因此不得把结果标注为当前延期任务数。',
    applicableScopes: ['managed-project', 'project-plan'],
    thresholds: [
      sampleThreshold('sample-delayed-none', '受控样例：无延期', 'eq', 0, '仅为样例分段'),
      sampleThreshold('sample-delayed-watch', '受控样例：存在延期', 'gt', 0, '需要下钻延期任务明细')
    ],
    ownerRoles: ['project-owner', 'rd-lead'],
    processRequirementIds: ['process.delayed-task-control'],
    availability: 'partial',
    format: 'number'
  },
  {
    id: 'critical-path-risk-score',
    label: '关键路径风险评分',
    definition: '依据关键路径任务的剩余浮动、阻塞和依赖状态形成的版本化风险评分。',
    formulaVersion: 'sample-critical-path-risk-v1',
    sourceFields: [
      sourceField('sample.plan.critical_path_risk', 'PlanMilestoneSample', 'criticalPathRiskScore', 'record.milestoneId -> criticalPath.milestoneId', 'insufficient', '当前仅有受控汇总分，真实适配器需提供任务依赖与浮动时间。')
    ],
    timeSemantics: '里程碑计划快照；风险评分必须绑定依赖网络版本。',
    applicableScopes: ['managed-project', 'project-plan'],
    thresholds: [
      sampleThreshold('sample-critical-risk-low', '受控样例：低风险', 'lt', 0.5, '仅为样例分段'),
      sampleThreshold('sample-critical-risk-high', '受控样例：高风险', 'gte', 0.8, '仅为样例分段')
    ],
    ownerRoles: ['project-owner', 'rd-lead'],
    processRequirementIds: ['process.critical-path-review'],
    availability: 'insufficient',
    format: 'number'
  },
  {
    id: 'milestone-forecast-delay-days',
    label: '里程碑预测延期天数',
    definition: '基于当前进度预测的里程碑日期相对批准目标日期的偏差天数；用于表达预测日期风险。',
    formulaVersion: 'sample-milestone-forecast-delay-v1',
    sourceFields: [
      sourceField('sample.plan.milestone_forecast', 'PlanMilestoneSample', 'milestoneForecastDelayDays', 'record.milestoneId -> milestone.id', 'insufficient', '正式场景应同时返回目标日期和预测日期。')
    ],
    timeSemantics: '里程碑快照；预测模型版本、目标日期和预测生成时间必须留痕。',
    applicableScopes: ['managed-project', 'project-plan'],
    thresholds: [
      sampleThreshold('sample-forecast-on-time', '受控样例：预计按期', 'lte', 0, '非正值表示预测不晚于目标日期'),
      sampleThreshold('sample-forecast-late', '受控样例：预计延期', 'gt', 0, '正值表示预测晚于目标日期')
    ],
    ownerRoles: ['project-owner', 'rd-lead'],
    processRequirementIds: ['process.milestone-forecast-review'],
    availability: 'insufficient',
    unit: '天',
    format: 'duration'
  },
  {
    id: 'critical-defect-count',
    label: '严重缺陷数',
    definition: '当前受控质量快照中严重度达到已批准阈值且尚未关闭的缺陷数量。',
    formulaVersion: 'sample-critical-defect-count-v1',
    sourceFields: [
      sourceField('sample.quality.critical_defects', 'SoftwareQualitySample', 'criticalDefectCount', 'record.releaseId -> defect.releaseId', 'partial')
    ],
    timeSemantics: '发布或阶段质量快照；严重度阈值、确认状态和关闭状态必须属于同一口径版本。',
    applicableScopes: ['managed-project', 'release-version', 'quality-baseline'],
    thresholds: [
      sampleThreshold('sample-critical-defect-none', '受控样例：无严重遗留', 'eq', 0, '仅为样例分段'),
      sampleThreshold('sample-critical-defect-open', '受控样例：存在严重遗留', 'gt', 0, '需要下钻缺陷明细')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.severe-defect-review'],
    availability: 'partial',
    format: 'number'
  },
  {
    id: 'open-defect-count',
    label: '开放缺陷数',
    definition: '质量快照时点已经确认且尚未关闭的缺陷数量；按快照时间形成趋势。',
    formulaVersion: 'sample-open-defect-count-v1',
    sourceFields: [
      sourceField('sample.quality.open_defects', 'SoftwareQualitySample', 'openDefectCount', 'record.releaseId -> defect.releaseId', 'partial')
    ],
    timeSemantics: '质量快照趋势；不得把不同版本或不同缺陷确认口径直接拼接。',
    applicableScopes: ['managed-project', 'release-version'],
    thresholds: [
      sampleThreshold('sample-open-defect-zero', '受控样例：已清零', 'eq', 0, '仅为样例分段'),
      sampleThreshold('sample-open-defect-existing', '受控样例：仍有开放项', 'gt', 0, '需要结合严重度和发布条件判断')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.defect-status-monitoring'],
    availability: 'partial',
    format: 'number'
  },
  {
    id: 'defect-reopen-rate',
    label: '缺陷重开率',
    definition: '统计周期内被重新打开的已关闭缺陷数量占周期内关闭缺陷总数的比例。',
    formulaVersion: 'sample-defect-reopen-rate-v1',
    sourceFields: [
      sourceField('sample.quality.reopen_rate', 'SoftwareQualitySample', 'defectReopenRate', 'record.releaseId -> defectHistory.releaseId', 'insufficient', '真实适配器需提供缺陷状态历史。')
    ],
    timeSemantics: '统计周期；重开和关闭事件必须来自同一缺陷状态历史。',
    applicableScopes: ['managed-project', 'release-version'],
    thresholds: [
      sampleThreshold('sample-reopen-low', '受控样例：较低', 'lte', 0.05, '仅为样例分段'),
      sampleThreshold('sample-reopen-watch', '受控样例：需关注', 'gt', 0.05, '应核验关闭判定和回归测试')
    ],
    ownerRoles: ['qa-epg', 'rd-lead', 'project-owner'],
    processRequirementIds: ['process.defect-closure-verification'],
    availability: 'insufficient',
    format: 'percent'
  },
  {
    id: 'mean-defect-repair-hours',
    label: '缺陷修复时长',
    definition: '统计周期内已关闭缺陷从确认到修复完成的平均小时数。',
    formulaVersion: 'sample-mean-defect-repair-hours-v1',
    sourceFields: [
      sourceField('sample.quality.repair_hours', 'SoftwareQualitySample', 'meanRepairHours', 'record.moduleId -> defect.moduleId', 'insufficient', '真实适配器需提供确认时间与修复完成时间。')
    ],
    timeSemantics: '统计周期；排除暂停时间等规则必须随 formulaVersion 固定。',
    applicableScopes: ['managed-project', 'release-version', 'software-module'],
    thresholds: [
      sampleThreshold('sample-repair-fast', '受控样例：较快', 'lte', 48, '仅为样例分段'),
      sampleThreshold('sample-repair-slow', '受控样例：偏慢', 'gt', 48, '需要下钻模块和严重度')
    ],
    ownerRoles: ['qa-epg', 'rd-lead'],
    processRequirementIds: ['process.defect-resolution'],
    availability: 'insufficient',
    unit: '小时',
    format: 'duration'
  },
  {
    id: 'residual-defect-risk-score',
    label: '遗留缺陷风险评分',
    definition: '按严重度、影响范围、存在时长和规避措施形成的版本化遗留缺陷风险评分。',
    formulaVersion: 'sample-residual-defect-risk-v1',
    sourceFields: [
      sourceField('sample.quality.residual_risk', 'SoftwareQualitySample', 'residualDefectRiskScore', 'record.moduleId -> residualDefect.moduleId', 'insufficient', '当前仅有受控汇总分，正式适配器需提供风险构成。')
    ],
    timeSemantics: '发布评审快照；评分必须绑定发布范围、风险规则版本和规避措施状态。',
    applicableScopes: ['managed-project', 'release-version', 'software-module'],
    thresholds: [
      sampleThreshold('sample-residual-risk-low', '受控样例：低风险', 'lt', 0.5, '仅为样例分段'),
      sampleThreshold('sample-residual-risk-high', '受控样例：高风险', 'gte', 0.8, '不得仅凭总分替代发布评审')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.release-defect-risk-review'],
    availability: 'insufficient',
    format: 'number'
  },
  {
    id: 'test-case-execution-rate',
    label: '测试用例执行率',
    definition: '当前验证范围内已执行测试用例数量占计划执行测试用例总数的比例。',
    formulaVersion: 'sample-test-case-execution-rate-v1',
    sourceFields: [
      sourceField('sample.test.execution_rate', 'TestValidationSample', 'testExecutionRate', 'record.testScopeId -> testCase.scopeId', 'partial')
    ],
    timeSemantics: '测试执行快照；计划范围和执行结果必须属于同一测试版本。',
    applicableScopes: ['managed-project', 'release-version', 'test-scope'],
    thresholds: [
      sampleThreshold('sample-test-execution-low', '受控样例：未充分执行', 'lt', 0.9, '仅为样例分段'),
      sampleThreshold('sample-test-execution-good', '受控样例：执行充分', 'gte', 0.9, '仅为样例分段')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.test-execution-control'],
    availability: 'partial',
    format: 'percent'
  },
  {
    id: 'test-pass-rate',
    label: '测试通过率',
    definition: '已执行且结果有效的测试用例中通过用例数量所占比例；阻塞和未执行用例不得计入通过数。',
    formulaVersion: 'sample-test-pass-rate-v1',
    sourceFields: [
      sourceField('sample.test.pass_rate', 'TestValidationSample', 'testPassRate', 'record.testRunId -> testResult.runId', 'partial')
    ],
    timeSemantics: '测试运行快照；无效结果、阻塞和重跑规则必须随公式版本固定。',
    applicableScopes: ['managed-project', 'release-version', 'test-run'],
    thresholds: [
      sampleThreshold('sample-test-pass-low', '受控样例：偏低', 'lt', 0.9, '仅为样例分段'),
      sampleThreshold('sample-test-pass-good', '受控样例：较好', 'gte', 0.9, '仅为样例分段')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.test-result-review'],
    availability: 'partial',
    format: 'percent'
  },
  {
    id: 'code-coverage-rate',
    label: '代码覆盖率',
    definition: '在声明的覆盖类型和排除规则下，被执行覆盖的代码元素占可覆盖代码元素总量的比例。',
    formulaVersion: 'sample-code-coverage-rate-v1',
    sourceFields: [
      sourceField('sample.test.code_coverage', 'TestValidationSample', 'codeCoverageRate', 'record.buildId -> coverageReport.buildId', 'insufficient', '真实适配器需声明行、分支或条件覆盖类型。')
    ],
    timeSemantics: '构建与测试快照；覆盖报告必须绑定构建版本和排除规则。',
    applicableScopes: ['managed-project', 'release-version', 'build-version'],
    thresholds: [
      sampleThreshold('sample-code-coverage-low', '受控样例：不足', 'lt', 0.8, '仅为样例分段'),
      sampleThreshold('sample-code-coverage-good', '受控样例：较好', 'gte', 0.8, '仅为样例分段')
    ],
    ownerRoles: ['qa-epg', 'rd-lead'],
    processRequirementIds: ['process.code-coverage-review'],
    availability: 'insufficient',
    format: 'percent'
  },
  {
    id: 'test-automation-rate',
    label: '测试自动化率',
    definition: '当前测试范围内可自动执行且已纳入受控流水线的测试用例数量占适合自动化用例总数的比例。',
    formulaVersion: 'sample-test-automation-rate-v1',
    sourceFields: [
      sourceField('sample.test.automation_rate', 'TestValidationSample', 'testAutomationRate', 'record.testScopeId -> automationSuite.scopeId', 'partial')
    ],
    timeSemantics: '测试范围快照；自动化适用性分母和流水线状态必须固定。',
    applicableScopes: ['managed-project', 'release-version', 'test-scope'],
    thresholds: [
      sampleThreshold('sample-automation-low', '受控样例：偏低', 'lt', 0.6, '仅为样例分段'),
      sampleThreshold('sample-automation-good', '受控样例：较好', 'gte', 0.6, '仅为样例分段')
    ],
    ownerRoles: ['qa-epg', 'rd-lead'],
    processRequirementIds: ['process.test-automation-governance'],
    availability: 'partial',
    format: 'percent'
  },
  {
    id: 'blocked-test-case-count',
    label: '阻塞测试用例数',
    definition: '当前测试快照中因环境、依赖、数据或产品缺陷无法继续执行的用例数量。',
    formulaVersion: 'sample-blocked-test-case-count-v1',
    sourceFields: [
      sourceField('sample.test.blocked_cases', 'TestValidationSample', 'blockedTestCaseCount', 'record.testSuiteId -> testCase.suiteId', 'insufficient', '真实适配器需提供阻塞原因和解除状态。')
    ],
    timeSemantics: '测试快照；同一用例重复阻塞不得重复计数。',
    applicableScopes: ['managed-project', 'release-version', 'test-suite'],
    thresholds: [
      sampleThreshold('sample-blocked-none', '受控样例：无阻塞', 'eq', 0, '仅为样例分段'),
      sampleThreshold('sample-blocked-existing', '受控样例：存在阻塞', 'gt', 0, '需要下钻阻塞原因和责任人')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.blocked-test-case-control'],
    availability: 'insufficient',
    format: 'number'
  },
  {
    id: 'configuration-item-control-rate',
    label: '配置项纳管率',
    definition: '当前交付范围内已识别且纳入配置管理的配置项数量占应纳管配置项总数的比例。',
    formulaVersion: 'sample-configuration-item-control-rate-v1',
    sourceFields: [sourceField('sample.configuration.item_control_rate', 'ConfigurationChangeSample', 'configurationItemControlRate', 'record.scopeId -> configurationItem.scopeId', 'partial')],
    timeSemantics: '配置状态快照；应纳管范围和配置项识别规则必须属于同一基线。',
    applicableScopes: ['managed-project', 'release-version', 'configuration-scope'],
    thresholds: [
      sampleThreshold('sample-ci-control-low', '受控样例：纳管不足', 'lt', 0.95, '仅为样例分段'),
      sampleThreshold('sample-ci-control-good', '受控样例：纳管充分', 'gte', 0.95, '仅为样例分段')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.configuration-identification'],
    availability: 'partial',
    format: 'percent'
  },
  {
    id: 'baseline-completeness-rate',
    label: '基线完整率',
    definition: '当前基线中已按要求纳入、标识并完成状态确认的工作产品数量占基线应包含工作产品总数的比例。',
    formulaVersion: 'sample-baseline-completeness-rate-v1',
    sourceFields: [sourceField('sample.configuration.baseline_completeness', 'ConfigurationChangeSample', 'baselineCompletenessRate', 'record.baselineId -> baselineItem.baselineId', 'insufficient', '真实适配器需提供基线清单、版本标识和批准状态。')],
    timeSemantics: '基线审计快照；基线范围、版本和批准状态必须同时冻结。',
    applicableScopes: ['managed-project', 'release-version', 'configuration-baseline'],
    thresholds: [
      sampleThreshold('sample-baseline-incomplete', '受控样例：不完整', 'lt', 1, '需下钻缺失工作产品'),
      sampleThreshold('sample-baseline-complete', '受控样例：完整', 'eq', 1, '仅为样例分段')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.configuration-baseline-audit'],
    availability: 'insufficient',
    format: 'percent'
  },
  {
    id: 'change-approval-rate',
    label: '变更审批率',
    definition: '统计周期内进入实施或关闭状态且具有有效事前审批记录的变更数量占同期进入实施或关闭状态变更总数的比例。',
    formulaVersion: 'sample-change-approval-rate-v1',
    sourceFields: [sourceField('sample.configuration.change_approval_rate', 'ConfigurationChangeSample', 'changeApprovalRate', 'record.changeSetId -> changeRequest.changeSetId', 'insufficient', '真实适配器需提供审批链和状态历史。')],
    timeSemantics: '变更统计周期；审批必须早于实施，撤回和驳回规则随公式版本固定。',
    applicableScopes: ['managed-project', 'release-version', 'change-set'],
    thresholds: [
      sampleThreshold('sample-change-approval-low', '受控样例：审批不足', 'lt', 1, '不得把补录审批视为事前批准'),
      sampleThreshold('sample-change-approval-good', '受控样例：审批完整', 'eq', 1, '仅为样例分段')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.change-approval-control'],
    availability: 'insufficient',
    format: 'percent'
  },
  {
    id: 'open-change-count',
    label: '未关闭变更数',
    definition: '当前快照中已受理但尚未完成验证并关闭的变更请求数量。',
    formulaVersion: 'sample-open-change-count-v1',
    sourceFields: [sourceField('sample.configuration.open_changes', 'ConfigurationChangeSample', 'openChangeCount', 'record.snapshotId -> changeRequest.snapshotId', 'partial')],
    timeSemantics: '变更状态快照趋势；不同时间点必须使用一致的关闭判定。',
    applicableScopes: ['managed-project', 'release-version'],
    thresholds: [
      sampleThreshold('sample-open-change-none', '受控样例：无积压', 'eq', 0, '仅为样例分段'),
      sampleThreshold('sample-open-change-existing', '受控样例：存在积压', 'gt', 0, '需要结合优先级和影响范围判断')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.change-status-monitoring'],
    availability: 'partial',
    format: 'number'
  },
  {
    id: 'reproducible-build-rate',
    label: '构建可复现率',
    definition: '使用受控源码、依赖、工具链和构建参数能够重复产出一致交付物的构建数量占验证构建总数的比例。',
    formulaVersion: 'sample-reproducible-build-rate-v1',
    sourceFields: [sourceField('sample.configuration.reproducible_build_rate', 'ConfigurationChangeSample', 'reproducibleBuildRate', 'record.buildId -> buildEvidence.buildId', 'missing', '真实适配器需提供构建环境、依赖锁定、制品校验和复现记录。')],
    timeSemantics: '构建验证快照；源码版本、依赖、工具链和参数必须被完整固定。',
    applicableScopes: ['managed-project', 'release-version', 'build-version'],
    thresholds: [
      sampleThreshold('sample-build-reproducibility-low', '受控样例：不可稳定复现', 'lt', 1, '需下钻环境或依赖差异'),
      sampleThreshold('sample-build-reproducibility-good', '受控样例：可复现', 'eq', 1, '仅为样例分段')
    ],
    ownerRoles: ['project-owner', 'qa-epg', 'rd-lead'],
    processRequirementIds: ['process.build-reproducibility-verification'],
    availability: 'missing',
    format: 'percent'
  }
]

const questions: readonly DashboardDomainQuestion[] = [
  {
    id: 'project-overview-health-question',
    question: '当前项目综合健康度如何，哪些信号拉低或支撑判断？',
    metricIds: ['project-health'],
    line: 'execution',
    slotRole: 'headline',
    preferredComponentTypes: ['kpi', 'gauge', 'insight'],
    required: true,
    priority: 100,
    clarificationKeys: ['project-key', 'health-formula-version']
  },
  {
    id: 'project-overview-milestone-question',
    question: '项目里程碑按当前计划的达成率是多少，是否存在延期信号？',
    metricIds: ['milestone-achievement'],
    line: 'execution',
    slotRole: 'trend',
    preferredComponentTypes: ['progress', 'line', 'bar'],
    required: true,
    priority: 90,
    clarificationKeys: ['project-key', 'milestone-denominator']
  },
  {
    id: 'project-overview-requirement-question',
    question: '已发布需求的完成率是多少，未完成需求集中在哪里？',
    metricIds: ['requirement-completion'],
    line: 'execution',
    slotRole: 'breakdown',
    preferredComponentTypes: ['gauge', 'bar', 'table'],
    required: true,
    priority: 90,
    clarificationKeys: ['project-key', 'published-requirement-set']
  },
  {
    id: 'project-overview-defect-question',
    question: '在确认的规模口径下，缺陷密度是否超过受控阈值？',
    metricIds: ['defect-density'],
    line: 'quality',
    slotRole: 'diagnosis',
    preferredComponentTypes: ['bar', 'line', 'table'],
    required: true,
    priority: 85,
    clarificationKeys: ['project-key', 'defect-node-type', 'size-denominator']
  },
  {
    id: 'project-overview-risk-question',
    question: '当前项目有多少已确认的高风险登记项，风险分布如何？',
    metricIds: ['high-risk-count'],
    line: 'execution',
    slotRole: 'headline',
    preferredComponentTypes: ['kpi', 'bar', 'table'],
    required: true,
    priority: 85,
    clarificationKeys: ['project-key', 'risk-register', 'risk-threshold-version']
  },
  {
    id: 'project-overview-process-question',
    question: '在声明的裁剪基线下，过程活动与证据的完成情况如何？',
    metricIds: ['process-compliance'],
    line: 'process',
    slotRole: 'diagnosis',
    preferredComponentTypes: ['progress', 'gauge', 'table'],
    required: true,
    priority: 80,
    clarificationKeys: ['project-key', 'tailoring-baseline', 'process-evidence']
  },
  {
    id: 'requirements-delivery-stability-question',
    question: '当前需求基线是否稳定，变更是否影响交付承诺？',
    metricIds: ['requirement-stability'],
    line: 'execution',
    slotRole: 'headline',
    preferredComponentTypes: ['kpi', 'gauge'],
    required: true,
    priority: 100,
    clarificationKeys: ['project-key', 'requirement-baseline']
  },
  {
    id: 'requirements-delivery-review-question',
    question: '应评审需求是否均已形成受控评审结论？',
    metricIds: ['requirement-review-completion'],
    line: 'process',
    slotRole: 'headline',
    preferredComponentTypes: ['progress', 'gauge'],
    required: true,
    priority: 95,
    clarificationKeys: ['requirement-baseline', 'review-evidence']
  },
  {
    id: 'requirements-delivery-change-question',
    question: '需求变更率如何变化，是否出现异常波动？',
    metricIds: ['requirement-change-rate'],
    line: 'execution',
    slotRole: 'trend',
    preferredComponentTypes: ['line', 'bar'],
    required: true,
    priority: 90,
    clarificationKeys: ['requirement-baseline', 'change-window']
  },
  {
    id: 'requirements-delivery-development-question',
    question: '当前基线需求的开发完成情况是否支撑交付节点？',
    metricIds: ['development-completion'],
    line: 'execution',
    slotRole: 'breakdown',
    preferredComponentTypes: ['gauge', 'progress'],
    required: true,
    priority: 90,
    clarificationKeys: ['release-version', 'development-status']
  },
  {
    id: 'requirements-delivery-test-question',
    question: '交付范围内的需求测试覆盖是否充分？',
    metricIds: ['requirement-test-coverage'],
    line: 'quality',
    slotRole: 'diagnosis',
    preferredComponentTypes: ['bar', 'gauge'],
    required: true,
    priority: 85,
    clarificationKeys: ['release-version', 'test-scope']
  },
  {
    id: 'requirements-delivery-trace-question',
    question: '需求上下游双向追溯是否完整，缺口集中在哪些快照？',
    metricIds: ['bidirectional-traceability'],
    line: 'process',
    slotRole: 'detail',
    preferredComponentTypes: ['funnel', 'table', 'bar'],
    required: true,
    priority: 85,
    clarificationKeys: ['requirement-baseline', 'trace-link']
  },
  {
    id: 'plan-milestone-completion-question',
    question: '当前统计周期的计划完成情况是否支撑项目目标？',
    metricIds: ['plan-completion-rate'],
    line: 'execution',
    slotRole: 'headline',
    preferredComponentTypes: ['progress', 'gauge'],
    required: true,
    priority: 100,
    clarificationKeys: ['project-key', 'plan-baseline']
  },
  {
    id: 'plan-milestone-delayed-question',
    question: '统计周期内平均有多少延期任务，需要优先处理哪些计划风险？',
    metricIds: ['delayed-task-count'],
    line: 'execution',
    slotRole: 'headline',
    preferredComponentTypes: ['kpi', 'table'],
    required: true,
    priority: 95,
    clarificationKeys: ['project-key', 'snapshot-window']
  },
  {
    id: 'plan-milestone-variance-question',
    question: '项目进度相对批准基准计划的偏差如何变化？',
    metricIds: ['schedule-variance-days'],
    line: 'execution',
    slotRole: 'trend',
    preferredComponentTypes: ['line', 'combo'],
    required: true,
    priority: 90,
    clarificationKeys: ['plan-baseline', 'snapshot-window']
  },
  {
    id: 'plan-milestone-critical-path-question',
    question: '哪些里程碑的关键路径风险最高，风险依据是否充分？',
    metricIds: ['critical-path-risk-score'],
    line: 'execution',
    slotRole: 'diagnosis',
    preferredComponentTypes: ['ranking', 'bar', 'table'],
    required: true,
    priority: 90,
    clarificationKeys: ['dependency-network', 'critical-path-rule']
  },
  {
    id: 'plan-milestone-forecast-question',
    question: '各里程碑预测日期相对目标日期可能延期多少天？',
    metricIds: ['milestone-forecast-delay-days'],
    line: 'execution',
    slotRole: 'detail',
    preferredComponentTypes: ['table', 'bar'],
    required: true,
    priority: 85,
    clarificationKeys: ['milestone-target-date', 'forecast-model-version']
  },
  {
    id: 'software-quality-critical-question',
    question: '当前发布范围是否仍有未关闭的严重缺陷？',
    metricIds: ['critical-defect-count'],
    line: 'quality',
    slotRole: 'headline',
    preferredComponentTypes: ['kpi', 'table'],
    required: true,
    priority: 100,
    clarificationKeys: ['release-version', 'defect-severity-threshold']
  },
  {
    id: 'software-quality-reopen-question',
    question: '缺陷关闭质量是否稳定，重开率是否超过受控阈值？',
    metricIds: ['defect-reopen-rate'],
    line: 'quality',
    slotRole: 'headline',
    preferredComponentTypes: ['gauge', 'progress'],
    required: true,
    priority: 95,
    clarificationKeys: ['defect-history', 'quality-window']
  },
  {
    id: 'software-quality-density-question',
    question: '在确认的软件规模分母下，各模块缺陷密度如何？',
    metricIds: ['defect-density'],
    line: 'quality',
    slotRole: 'breakdown',
    preferredComponentTypes: ['bar', 'ranking'],
    required: true,
    priority: 95,
    clarificationKeys: ['release-version', 'size-denominator']
  },
  {
    id: 'software-quality-trend-question',
    question: '开放缺陷数量随质量快照如何变化？',
    metricIds: ['open-defect-count'],
    line: 'quality',
    slotRole: 'trend',
    preferredComponentTypes: ['line', 'bar'],
    required: true,
    priority: 90,
    clarificationKeys: ['release-version', 'quality-window']
  },
  {
    id: 'software-quality-repair-question',
    question: '哪些模块的平均缺陷修复时长偏高？',
    metricIds: ['mean-defect-repair-hours'],
    line: 'quality',
    slotRole: 'diagnosis',
    preferredComponentTypes: ['ranking', 'bar'],
    required: true,
    priority: 85,
    clarificationKeys: ['defect-history', 'repair-duration-rule']
  },
  {
    id: 'software-quality-residual-risk-question',
    question: '遗留缺陷风险集中在哪些模块，是否满足发布评审条件？',
    metricIds: ['residual-defect-risk-score'],
    line: 'quality',
    slotRole: 'detail',
    preferredComponentTypes: ['table', 'ranking'],
    required: true,
    priority: 85,
    clarificationKeys: ['release-version', 'residual-risk-rule']
  },
  {
    id: 'test-validation-execution-question',
    question: '计划测试用例是否已被充分执行？',
    metricIds: ['test-case-execution-rate'],
    line: 'quality',
    slotRole: 'headline',
    preferredComponentTypes: ['progress', 'gauge'],
    required: true,
    priority: 100,
    clarificationKeys: ['release-version', 'test-scope']
  },
  {
    id: 'test-validation-pass-question',
    question: '有效执行结果的通过率是否满足当前验证目标？',
    metricIds: ['test-pass-rate'],
    line: 'quality',
    slotRole: 'headline',
    preferredComponentTypes: ['gauge', 'progress'],
    required: true,
    priority: 95,
    clarificationKeys: ['test-run', 'valid-result-rule']
  },
  {
    id: 'test-validation-requirement-coverage-question',
    question: '各需求集合是否均有充分的测试用例覆盖？',
    metricIds: ['requirement-test-coverage'],
    line: 'quality',
    slotRole: 'breakdown',
    preferredComponentTypes: ['bar', 'ranking'],
    required: true,
    priority: 95,
    clarificationKeys: ['requirement-baseline', 'test-scope']
  },
  {
    id: 'test-validation-code-coverage-question',
    question: '声明口径下的代码覆盖率如何变化？',
    metricIds: ['code-coverage-rate'],
    line: 'quality',
    slotRole: 'trend',
    preferredComponentTypes: ['line', 'bar'],
    required: true,
    priority: 90,
    clarificationKeys: ['build-version', 'coverage-type', 'coverage-exclusions']
  },
  {
    id: 'test-validation-automation-question',
    question: '适合自动化的测试用例是否已纳入受控流水线？',
    metricIds: ['test-automation-rate'],
    line: 'quality',
    slotRole: 'diagnosis',
    preferredComponentTypes: ['progress', 'gauge'],
    required: true,
    priority: 85,
    clarificationKeys: ['test-scope', 'automation-applicability']
  },
  {
    id: 'test-validation-blocked-question',
    question: '哪些测试套件存在阻塞用例，阻塞规模和原因如何？',
    metricIds: ['blocked-test-case-count'],
    line: 'quality',
    slotRole: 'detail',
    preferredComponentTypes: ['ranking', 'table'],
    required: true,
    priority: 85,
    clarificationKeys: ['test-suite', 'blocked-reason']
  },
  {
    id: 'configuration-change-item-control-question',
    question: '当前交付范围内应受控的配置项是否已全部纳管？',
    metricIds: ['configuration-item-control-rate'],
    line: 'process',
    slotRole: 'headline',
    preferredComponentTypes: ['progress', 'gauge'],
    required: true,
    priority: 100,
    clarificationKeys: ['configuration-scope', 'configuration-baseline']
  },
  {
    id: 'configuration-change-baseline-question',
    question: '各配置基线是否完整并具有可核验的版本和批准状态？',
    metricIds: ['baseline-completeness-rate'],
    line: 'process',
    slotRole: 'headline',
    preferredComponentTypes: ['gauge', 'progress'],
    required: true,
    priority: 95,
    clarificationKeys: ['configuration-baseline', 'baseline-audit']
  },
  {
    id: 'configuration-change-approval-question',
    question: '各变更集合在实施前是否完成有效审批？',
    metricIds: ['change-approval-rate'],
    line: 'process',
    slotRole: 'breakdown',
    preferredComponentTypes: ['bar', 'ranking'],
    required: true,
    priority: 95,
    clarificationKeys: ['change-set', 'approval-policy']
  },
  {
    id: 'configuration-change-open-trend-question',
    question: '未关闭变更数量随状态快照如何变化？',
    metricIds: ['open-change-count'],
    line: 'execution',
    slotRole: 'trend',
    preferredComponentTypes: ['line', 'bar'],
    required: true,
    priority: 90,
    clarificationKeys: ['release-version', 'change-window']
  },
  {
    id: 'configuration-change-reproducible-build-question',
    question: '各构建版本是否能够使用受控输入稳定复现交付物？',
    metricIds: ['reproducible-build-rate'],
    line: 'quality',
    slotRole: 'diagnosis',
    preferredComponentTypes: ['ranking', 'bar'],
    required: true,
    priority: 90,
    clarificationKeys: ['build-version', 'toolchain-version', 'artifact-checksum']
  }
]

const components: readonly DashboardDomainComponent[] = [
  {
    id: 'project-overview-health-card',
    label: '项目健康度',
    type: 'kpi',
    metricIds: ['project-health'],
    questionIds: ['project-overview-health-question'],
    line: 'execution',
    slotRole: 'headline'
  },
  {
    id: 'project-overview-milestone-card',
    label: '里程碑达成率',
    type: 'progress',
    metricIds: ['milestone-achievement'],
    questionIds: ['project-overview-milestone-question'],
    line: 'execution',
    slotRole: 'trend'
  },
  {
    id: 'project-overview-requirement-card',
    label: '需求完成率',
    type: 'gauge',
    metricIds: ['requirement-completion'],
    questionIds: ['project-overview-requirement-question'],
    line: 'execution',
    slotRole: 'breakdown'
  },
  {
    id: 'project-overview-defect-card',
    label: '缺陷密度',
    type: 'bar',
    metricIds: ['defect-density'],
    questionIds: ['project-overview-defect-question'],
    line: 'quality',
    slotRole: 'diagnosis'
  },
  {
    id: 'project-overview-risk-card',
    label: '高风险数',
    type: 'kpi',
    metricIds: ['high-risk-count'],
    questionIds: ['project-overview-risk-question'],
    line: 'execution',
    slotRole: 'headline'
  },
  {
    id: 'project-overview-process-card',
    label: '过程合规率',
    type: 'progress',
    metricIds: ['process-compliance'],
    questionIds: ['project-overview-process-question'],
    line: 'process',
    slotRole: 'diagnosis'
  },
  {
    id: 'requirements-delivery-stability-card',
    label: '需求稳定度',
    type: 'kpi',
    metricIds: ['requirement-stability'],
    questionIds: ['requirements-delivery-stability-question'],
    line: 'execution',
    slotRole: 'headline'
  },
  {
    id: 'requirements-delivery-review-card',
    label: '需求评审完成率',
    type: 'progress',
    metricIds: ['requirement-review-completion'],
    questionIds: ['requirements-delivery-review-question'],
    line: 'process',
    slotRole: 'headline'
  },
  {
    id: 'requirements-delivery-change-card',
    label: '需求变更率趋势',
    type: 'line',
    metricIds: ['requirement-change-rate'],
    questionIds: ['requirements-delivery-change-question'],
    line: 'execution',
    slotRole: 'trend'
  },
  {
    id: 'requirements-delivery-development-card',
    label: '开发完成率',
    type: 'gauge',
    metricIds: ['development-completion'],
    questionIds: ['requirements-delivery-development-question'],
    line: 'execution',
    slotRole: 'breakdown'
  },
  {
    id: 'requirements-delivery-test-card',
    label: '需求测试覆盖率',
    type: 'bar',
    metricIds: ['requirement-test-coverage'],
    questionIds: ['requirements-delivery-test-question'],
    line: 'quality',
    slotRole: 'diagnosis'
  },
  {
    id: 'requirements-delivery-trace-card',
    label: '双向追溯完整率',
    type: 'table',
    metricIds: ['bidirectional-traceability'],
    questionIds: ['requirements-delivery-trace-question'],
    line: 'process',
    slotRole: 'detail'
  },
  {
    id: 'plan-milestone-completion-card',
    label: '计划完成率',
    type: 'progress',
    metricIds: ['plan-completion-rate'],
    questionIds: ['plan-milestone-completion-question'],
    line: 'execution',
    slotRole: 'headline'
  },
  {
    id: 'plan-milestone-delayed-card',
    label: '周期平均延期任务数',
    type: 'kpi',
    metricIds: ['delayed-task-count'],
    questionIds: ['plan-milestone-delayed-question'],
    line: 'execution',
    slotRole: 'headline'
  },
  {
    id: 'plan-milestone-variance-card',
    label: '进度偏差趋势',
    type: 'line',
    metricIds: ['schedule-variance-days'],
    questionIds: ['plan-milestone-variance-question'],
    line: 'execution',
    slotRole: 'trend'
  },
  {
    id: 'plan-milestone-critical-path-card',
    label: '关键路径风险排行',
    type: 'ranking',
    metricIds: ['critical-path-risk-score'],
    questionIds: ['plan-milestone-critical-path-question'],
    line: 'execution',
    slotRole: 'diagnosis'
  },
  {
    id: 'plan-milestone-forecast-card',
    label: '里程碑预测延期明细',
    type: 'table',
    metricIds: ['milestone-forecast-delay-days'],
    questionIds: ['plan-milestone-forecast-question'],
    line: 'execution',
    slotRole: 'detail'
  },
  {
    id: 'software-quality-critical-card',
    label: '严重缺陷数',
    type: 'kpi',
    metricIds: ['critical-defect-count'],
    questionIds: ['software-quality-critical-question'],
    line: 'quality',
    slotRole: 'headline'
  },
  {
    id: 'software-quality-reopen-card',
    label: '缺陷重开率',
    type: 'gauge',
    metricIds: ['defect-reopen-rate'],
    questionIds: ['software-quality-reopen-question'],
    line: 'quality',
    slotRole: 'headline'
  },
  {
    id: 'software-quality-density-card',
    label: '模块缺陷密度',
    type: 'bar',
    metricIds: ['defect-density'],
    questionIds: ['software-quality-density-question'],
    line: 'quality',
    slotRole: 'breakdown'
  },
  {
    id: 'software-quality-trend-card',
    label: '开放缺陷趋势',
    type: 'line',
    metricIds: ['open-defect-count'],
    questionIds: ['software-quality-trend-question'],
    line: 'quality',
    slotRole: 'trend'
  },
  {
    id: 'software-quality-repair-card',
    label: '平均修复时长排行',
    type: 'ranking',
    metricIds: ['mean-defect-repair-hours'],
    questionIds: ['software-quality-repair-question'],
    line: 'quality',
    slotRole: 'diagnosis'
  },
  {
    id: 'software-quality-residual-risk-card',
    label: '遗留缺陷风险明细',
    type: 'table',
    metricIds: ['residual-defect-risk-score'],
    questionIds: ['software-quality-residual-risk-question'],
    line: 'quality',
    slotRole: 'detail'
  },
  {
    id: 'test-validation-execution-card',
    label: '测试用例执行率',
    type: 'progress',
    metricIds: ['test-case-execution-rate'],
    questionIds: ['test-validation-execution-question'],
    line: 'quality',
    slotRole: 'headline'
  },
  {
    id: 'test-validation-pass-card',
    label: '测试通过率',
    type: 'gauge',
    metricIds: ['test-pass-rate'],
    questionIds: ['test-validation-pass-question'],
    line: 'quality',
    slotRole: 'headline'
  },
  {
    id: 'test-validation-requirement-coverage-card',
    label: '需求测试覆盖率',
    type: 'bar',
    metricIds: ['requirement-test-coverage'],
    questionIds: ['test-validation-requirement-coverage-question'],
    line: 'quality',
    slotRole: 'breakdown'
  },
  {
    id: 'test-validation-code-coverage-card',
    label: '代码覆盖率趋势',
    type: 'line',
    metricIds: ['code-coverage-rate'],
    questionIds: ['test-validation-code-coverage-question'],
    line: 'quality',
    slotRole: 'trend'
  },
  {
    id: 'test-validation-automation-card',
    label: '测试自动化率',
    type: 'progress',
    metricIds: ['test-automation-rate'],
    questionIds: ['test-validation-automation-question'],
    line: 'quality',
    slotRole: 'diagnosis'
  },
  {
    id: 'test-validation-blocked-card',
    label: '阻塞测试用例排行',
    type: 'ranking',
    metricIds: ['blocked-test-case-count'],
    questionIds: ['test-validation-blocked-question'],
    line: 'quality',
    slotRole: 'detail'
  },
  {
    id: 'configuration-change-item-control-card',
    label: '配置项纳管率',
    type: 'progress',
    metricIds: ['configuration-item-control-rate'],
    questionIds: ['configuration-change-item-control-question'],
    line: 'process',
    slotRole: 'headline'
  },
  {
    id: 'configuration-change-baseline-card',
    label: '基线完整率',
    type: 'gauge',
    metricIds: ['baseline-completeness-rate'],
    questionIds: ['configuration-change-baseline-question'],
    line: 'process',
    slotRole: 'headline'
  },
  {
    id: 'configuration-change-approval-card',
    label: '变更审批率对比',
    type: 'bar',
    metricIds: ['change-approval-rate'],
    questionIds: ['configuration-change-approval-question'],
    line: 'process',
    slotRole: 'breakdown'
  },
  {
    id: 'configuration-change-open-trend-card',
    label: '未关闭变更趋势',
    type: 'line',
    metricIds: ['open-change-count'],
    questionIds: ['configuration-change-open-trend-question'],
    line: 'execution',
    slotRole: 'trend'
  },
  {
    id: 'configuration-change-reproducible-build-card',
    label: '构建可复现率排行',
    type: 'ranking',
    metricIds: ['reproducible-build-rate'],
    questionIds: ['configuration-change-reproducible-build-question'],
    line: 'quality',
    slotRole: 'diagnosis'
  }
]

const processBindings: readonly ProcessBinding[] = [
  {
    id: 'process.project-health',
    metricIds: ['project-health'],
    requirementId: 'sample-process-requirement-project-health',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-project-status-review',
    workProductId: 'sample-work-product-project-status',
    evidenceId: 'sample-evidence-project-status',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.project-health',
    evidenceRule: '项目状态快照与健康公式版本必须可追溯。',
    notes: '受控样例证据不足；真实平台适配器需接入项目状态审查记录。'
  },
  {
    id: 'process.milestone-tracking',
    metricIds: ['milestone-achievement'],
    requirementId: 'sample-process-requirement-milestone-tracking',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-milestone-review',
    workProductId: 'sample-work-product-milestone-plan',
    evidenceId: 'sample-evidence-milestone-review',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.milestone-tracking',
    evidenceRule: '里程碑计划、状态变更和评审记录必须关联到同一项目快照。'
  },
  {
    id: 'process.requirement-status',
    metricIds: ['requirement-completion'],
    requirementId: 'sample-process-requirement-requirement-status',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-requirement-review',
    workProductId: 'sample-work-product-requirement-baseline',
    evidenceId: 'sample-evidence-requirement-review',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.requirement-status',
    evidenceRule: '需求审核、发布版本和状态来源必须可回溯。'
  },
  {
    id: 'process.defect-classification',
    metricIds: ['defect-density'],
    requirementId: 'sample-process-requirement-defect-classification',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-defect-review',
    workProductId: 'sample-work-product-quality-report',
    evidenceId: 'sample-evidence-defect-review',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.defect-classification',
    evidenceRule: '缺陷分类、确认状态和规模分母必须来自同一版本范围。'
  },
  {
    id: 'process.risk-register',
    metricIds: ['high-risk-count'],
    requirementId: 'sample-process-requirement-risk-register',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-risk-review',
    workProductId: 'sample-work-product-risk-register',
    evidenceId: 'sample-evidence-risk-review',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.risk-register',
    evidenceRule: '风险登记项、等级阈值和处置状态必须可追踪。'
  },
  {
    id: 'process.baseline-evidence',
    metricIds: ['process-compliance'],
    requirementId: 'sample-process-requirement-baseline-evidence',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-process-audit',
    workProductId: 'sample-work-product-process-audit',
    evidenceId: 'sample-evidence-process-audit',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.baseline-evidence',
    evidenceRule: '裁剪基线、适用活动、工作产品和证据状态必须完整关联。'
  },
  {
    id: 'process.requirement-baseline-control',
    metricIds: ['requirement-stability'],
    requirementId: 'sample-process-requirement-baseline-control',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-requirement-baseline',
    workProductId: 'sample-work-product-requirement-baseline-status',
    evidenceId: 'sample-evidence-requirement-baseline',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.requirement-baseline-control',
    evidenceRule: '需求基线版本、变更范围和统计截止时间必须完整关联。'
  },
  {
    id: 'process.requirement-review',
    metricIds: ['requirement-review-completion'],
    requirementId: 'sample-process-requirement-review',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-requirement-review-completion',
    workProductId: 'sample-work-product-requirement-review-record',
    evidenceId: 'sample-evidence-requirement-review-completion',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.requirement-review',
    evidenceRule: '评审对象、参与人、结论和处置记录必须可追溯。'
  },
  {
    id: 'process.requirement-change-control',
    metricIds: ['requirement-change-rate'],
    requirementId: 'sample-process-requirement-change-control',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-requirement-change',
    workProductId: 'sample-work-product-change-request',
    evidenceId: 'sample-evidence-change-approval',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.requirement-change-control',
    evidenceRule: '变更申请、影响分析、审批和基线更新必须形成闭环。'
  },
  {
    id: 'process.requirement-development',
    metricIds: ['development-completion'],
    requirementId: 'sample-process-requirement-development',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-requirement-implementation',
    workProductId: 'sample-work-product-development-status',
    evidenceId: 'sample-evidence-development-completion',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.requirement-development',
    evidenceRule: '需求、实现项、完成判定和交付版本必须建立稳定关联。'
  },
  {
    id: 'process.requirement-verification',
    metricIds: ['requirement-test-coverage'],
    requirementId: 'sample-process-requirement-verification',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-requirement-verification',
    workProductId: 'sample-work-product-test-coverage',
    evidenceId: 'sample-evidence-requirement-test-links',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.requirement-verification',
    evidenceRule: '需求、测试用例、执行结果和验证版本必须完整关联。'
  },
  {
    id: 'process.bidirectional-traceability',
    metricIds: ['bidirectional-traceability'],
    requirementId: 'sample-process-bidirectional-traceability',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-traceability-review',
    workProductId: 'sample-work-product-traceability-matrix',
    evidenceId: 'sample-evidence-traceability-review',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.bidirectional-traceability',
    evidenceRule: '每条适用需求必须保留上游来源和下游设计、实现、验证关系。'
  },
  {
    id: 'process.plan-monitoring',
    metricIds: ['plan-completion-rate'],
    requirementId: 'sample-process-plan-monitoring',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-plan-monitoring',
    workProductId: 'sample-work-product-project-plan',
    evidenceId: 'sample-evidence-plan-snapshot',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.plan-monitoring',
    evidenceRule: '计划版本、数据日期、应完成任务范围和完成判定必须可追溯。'
  },
  {
    id: 'process.schedule-variance-review',
    metricIds: ['schedule-variance-days'],
    requirementId: 'sample-process-schedule-variance-review',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-schedule-review',
    workProductId: 'sample-work-product-schedule-analysis',
    evidenceId: 'sample-evidence-schedule-review',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.schedule-variance-review',
    evidenceRule: '当前计划必须与已批准基准计划进行同口径比较。'
  },
  {
    id: 'process.delayed-task-control',
    metricIds: ['delayed-task-count'],
    requirementId: 'sample-process-delayed-task-control',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-delayed-task-review',
    workProductId: 'sample-work-product-delayed-task-list',
    evidenceId: 'sample-evidence-delayed-task-actions',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.delayed-task-control',
    evidenceRule: '延期判定、责任人、处置动作和状态变化必须形成闭环。'
  },
  {
    id: 'process.critical-path-review',
    metricIds: ['critical-path-risk-score'],
    requirementId: 'sample-process-critical-path-review',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-critical-path-analysis',
    workProductId: 'sample-work-product-dependency-network',
    evidenceId: 'sample-evidence-critical-path-review',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.critical-path-review',
    evidenceRule: '关键路径必须由受控任务依赖网络和浮动时间计算得到。'
  },
  {
    id: 'process.milestone-forecast-review',
    metricIds: ['milestone-forecast-delay-days'],
    requirementId: 'sample-process-milestone-forecast-review',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-milestone-forecast',
    workProductId: 'sample-work-product-milestone-forecast',
    evidenceId: 'sample-evidence-milestone-forecast-review',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.milestone-forecast-review',
    evidenceRule: '目标日期、预测日期、预测模型版本和评审结论必须留痕。'
  },
  {
    id: 'process.severe-defect-review',
    metricIds: ['critical-defect-count'],
    requirementId: 'sample-process-severe-defect-review',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-severe-defect-review',
    workProductId: 'sample-work-product-severe-defect-list',
    evidenceId: 'sample-evidence-severe-defect-review',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.severe-defect-review',
    evidenceRule: '严重度阈值、确认状态、关闭状态和处置决定必须可追溯。'
  },
  {
    id: 'process.defect-status-monitoring',
    metricIds: ['open-defect-count'],
    requirementId: 'sample-process-defect-status-monitoring',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-defect-monitoring',
    workProductId: 'sample-work-product-defect-trend',
    evidenceId: 'sample-evidence-defect-snapshot',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.defect-status-monitoring',
    evidenceRule: '开放缺陷趋势必须来自同一确认口径和发布范围。'
  },
  {
    id: 'process.defect-closure-verification',
    metricIds: ['defect-reopen-rate'],
    requirementId: 'sample-process-defect-closure-verification',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-defect-closure-verification',
    workProductId: 'sample-work-product-defect-closure-record',
    evidenceId: 'sample-evidence-defect-history',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.defect-closure-verification',
    evidenceRule: '关闭、验证、重开事件和回归结果必须形成完整状态历史。'
  },
  {
    id: 'process.defect-resolution',
    metricIds: ['mean-defect-repair-hours'],
    requirementId: 'sample-process-defect-resolution',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-defect-resolution',
    workProductId: 'sample-work-product-defect-resolution-analysis',
    evidenceId: 'sample-evidence-defect-resolution-time',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.defect-resolution',
    evidenceRule: '缺陷确认、修复完成和暂停区间必须有受控时间戳。'
  },
  {
    id: 'process.release-defect-risk-review',
    metricIds: ['residual-defect-risk-score'],
    requirementId: 'sample-process-release-defect-risk-review',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-release-defect-risk-review',
    workProductId: 'sample-work-product-residual-risk-list',
    evidenceId: 'sample-evidence-release-risk-decision',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.release-defect-risk-review',
    evidenceRule: '遗留缺陷、影响分析、规避措施和发布决定必须完整关联。'
  },
  {
    id: 'process.test-execution-control',
    metricIds: ['test-case-execution-rate'],
    requirementId: 'sample-process-test-execution-control',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-test-execution',
    workProductId: 'sample-work-product-test-run',
    evidenceId: 'sample-evidence-test-execution-snapshot',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.test-execution-control',
    evidenceRule: '测试范围、计划用例、执行结果和测试版本必须完整关联。'
  },
  {
    id: 'process.test-result-review',
    metricIds: ['test-pass-rate'],
    requirementId: 'sample-process-test-result-review',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-test-result-review',
    workProductId: 'sample-work-product-test-result-summary',
    evidenceId: 'sample-evidence-test-result-review',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.test-result-review',
    evidenceRule: '通过、失败、阻塞、无效和重跑结果的判定规则必须固定。'
  },
  {
    id: 'process.code-coverage-review',
    metricIds: ['code-coverage-rate'],
    requirementId: 'sample-process-code-coverage-review',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-code-coverage-review',
    workProductId: 'sample-work-product-code-coverage-report',
    evidenceId: 'sample-evidence-code-coverage-report',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.code-coverage-review',
    evidenceRule: '覆盖类型、构建版本、排除规则和报告生成工具必须留痕。'
  },
  {
    id: 'process.test-automation-governance',
    metricIds: ['test-automation-rate'],
    requirementId: 'sample-process-test-automation-governance',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-test-automation-review',
    workProductId: 'sample-work-product-automation-scope',
    evidenceId: 'sample-evidence-automation-pipeline',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.test-automation-governance',
    evidenceRule: '自动化适用性、脚本状态和流水线运行证据必须可追溯。'
  },
  {
    id: 'process.blocked-test-case-control',
    metricIds: ['blocked-test-case-count'],
    requirementId: 'sample-process-blocked-test-case-control',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-blocked-test-case-review',
    workProductId: 'sample-work-product-blocked-test-list',
    evidenceId: 'sample-evidence-blocked-test-actions',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.blocked-test-case-control',
    evidenceRule: '阻塞原因、责任人、解除动作和重新执行结果必须形成闭环。'
  },
  {
    id: 'process.configuration-identification',
    metricIds: ['configuration-item-control-rate'],
    requirementId: 'sample-process-configuration-identification',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-configuration-identification',
    workProductId: 'sample-work-product-configuration-item-list',
    evidenceId: 'sample-evidence-configuration-status-accounting',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.configuration-identification',
    evidenceRule: '应纳管范围、配置项标识、版本和当前状态必须完整关联。'
  },
  {
    id: 'process.configuration-baseline-audit',
    metricIds: ['baseline-completeness-rate'],
    requirementId: 'sample-process-configuration-baseline-audit',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-configuration-baseline-audit',
    workProductId: 'sample-work-product-baseline-audit-record',
    evidenceId: 'sample-evidence-baseline-approval',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.configuration-baseline-audit',
    evidenceRule: '基线清单、工作产品版本、审计结果和批准记录必须一致。'
  },
  {
    id: 'process.change-approval-control',
    metricIds: ['change-approval-rate'],
    requirementId: 'sample-process-change-approval-control',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-change-control-board',
    workProductId: 'sample-work-product-change-approval-record',
    evidenceId: 'sample-evidence-change-approval-history',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.change-approval-control',
    evidenceRule: '变更申请、影响分析、审批决定和实施时间必须保持可追溯顺序。'
  },
  {
    id: 'process.change-status-monitoring',
    metricIds: ['open-change-count'],
    requirementId: 'sample-process-change-status-monitoring',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-change-status-review',
    workProductId: 'sample-work-product-change-status-report',
    evidenceId: 'sample-evidence-change-status-snapshot',
    evidenceStatus: 'insufficient',
    sourceKey: 'sample.process.change-status-monitoring',
    evidenceRule: '受理、实施、验证和关闭状态必须来自连续的变更状态历史。'
  },
  {
    id: 'process.build-reproducibility-verification',
    metricIds: ['reproducible-build-rate'],
    requirementId: 'sample-process-build-reproducibility-verification',
    tailoringBaselineId: sampleBaselineId,
    activityId: 'sample-activity-build-reproducibility-verification',
    workProductId: 'sample-work-product-reproducible-build-report',
    evidenceId: 'sample-evidence-build-artifact-checksum',
    evidenceStatus: 'missing',
    sourceKey: 'sample.process.build-reproducibility-verification',
    evidenceRule: '源码、依赖、工具链、参数、环境和制品校验值必须完整留痕。'
  }
]

const projectOverviewQuestionIds = questions
  .filter((question) => question.id.startsWith('project-overview-'))
  .map((question) => question.id)
const projectOverviewComponentIds = components
  .filter((component) => component.id.startsWith('project-overview-'))
  .map((component) => component.id)
const requirementsDeliveryQuestionIds = questions
  .filter((question) => question.id.startsWith('requirements-delivery-'))
  .map((question) => question.id)
const requirementsDeliveryComponentIds = components
  .filter((component) => component.id.startsWith('requirements-delivery-'))
  .map((component) => component.id)
const planMilestoneQuestionIds = questions
  .filter((question) => question.id.startsWith('plan-milestone-'))
  .map((question) => question.id)
const planMilestoneComponentIds = components
  .filter((component) => component.id.startsWith('plan-milestone-'))
  .map((component) => component.id)
const softwareQualityQuestionIds = questions
  .filter((question) => question.id.startsWith('software-quality-'))
  .map((question) => question.id)
const softwareQualityComponentIds = components
  .filter((component) => component.id.startsWith('software-quality-'))
  .map((component) => component.id)
const testValidationQuestionIds = questions
  .filter((question) => question.id.startsWith('test-validation-'))
  .map((question) => question.id)
const testValidationComponentIds = components
  .filter((component) => component.id.startsWith('test-validation-'))
  .map((component) => component.id)
const configurationChangeQuestionIds = questions
  .filter((question) => question.id.startsWith('configuration-change-'))
  .map((question) => question.id)
const configurationChangeComponentIds = components
  .filter((component) => component.id.startsWith('configuration-change-'))
  .map((component) => component.id)

const scenarios: readonly DashboardGoldenScenario[] = [
  {
    id: 'project-overview',
    name: '项目综合态势',
    description: '以项目执行、质量和过程证据为主线的第一期综合态势样例。',
    status: 'active',
    roleIds: ['project-owner', 'qa-epg', 'rd-lead', 'model-org-manager'],
    metricIds: [
      'project-health',
      'milestone-achievement',
      'requirement-completion',
      'defect-density',
      'high-risk-count',
      'process-compliance'
    ],
    questionIds: projectOverviewQuestionIds,
    componentIds: projectOverviewComponentIds,
    lines: ['execution', 'quality', 'process'],
    clarificationKeys: ['project-key', 'tailoring-baseline', 'data-permission']
  },
  {
    id: 'requirements-delivery',
    name: '需求到交付全链路',
    description: '需求完整性、稳定性、评审、开发、验证和双向追溯的受控样例。',
    status: 'active',
    roleIds: ['project-owner', 'qa-epg', 'rd-lead'],
    metricIds: [
      'requirement-stability',
      'requirement-review-completion',
      'requirement-change-rate',
      'development-completion',
      'requirement-test-coverage',
      'bidirectional-traceability'
    ],
    questionIds: requirementsDeliveryQuestionIds,
    componentIds: requirementsDeliveryComponentIds,
    lines: ['execution', 'quality', 'process'],
    clarificationKeys: ['project-key', 'requirement-baseline', 'release-version', 'data-permission']
  },
  {
    id: 'plan-milestone',
    name: '计划与里程碑执行',
    description: '计划完成、进度偏差、延期任务、关键路径和里程碑预测的受控样例。',
    status: 'active',
    roleIds: ['project-owner', 'rd-lead'],
    metricIds: [
      'plan-completion-rate',
      'schedule-variance-days',
      'delayed-task-count',
      'critical-path-risk-score',
      'milestone-forecast-delay-days'
    ],
    questionIds: planMilestoneQuestionIds,
    componentIds: planMilestoneComponentIds,
    lines: ['execution'],
    clarificationKeys: ['project-key', 'plan-baseline', 'snapshot-window', 'data-permission']
  },
  {
    id: 'software-quality',
    name: '软件质量与缺陷闭环',
    description: '缺陷密度、严重缺陷、状态趋势、关闭质量、修复效率和遗留风险的受控样例。',
    status: 'active',
    roleIds: ['project-owner', 'qa-epg', 'rd-lead'],
    metricIds: [
      'critical-defect-count',
      'defect-reopen-rate',
      'defect-density',
      'open-defect-count',
      'mean-defect-repair-hours',
      'residual-defect-risk-score'
    ],
    questionIds: softwareQualityQuestionIds,
    componentIds: softwareQualityComponentIds,
    lines: ['quality'],
    clarificationKeys: ['project-key', 'release-version', 'defect-threshold', 'data-permission']
  },
  {
    id: 'test-validation',
    name: '测试与验证充分性',
    description: '测试执行、结果质量、需求覆盖、代码覆盖、自动化和阻塞用例的受控样例。',
    status: 'active',
    roleIds: ['project-owner', 'qa-epg', 'rd-lead'],
    metricIds: [
      'test-case-execution-rate',
      'test-pass-rate',
      'requirement-test-coverage',
      'code-coverage-rate',
      'test-automation-rate',
      'blocked-test-case-count'
    ],
    questionIds: testValidationQuestionIds,
    componentIds: testValidationComponentIds,
    lines: ['quality', 'process'],
    clarificationKeys: ['project-key', 'release-version', 'test-scope', 'coverage-type']
  },
  {
    id: 'configuration-change',
    name: '配置管理与变更控制',
    description: '以配置项纳管、基线完整、变更审批和构建可复现为主线的受控样例。',
    status: 'active',
    roleIds: ['project-owner', 'qa-epg', 'rd-lead'],
    metricIds: [
      'configuration-item-control-rate',
      'baseline-completeness-rate',
      'change-approval-rate',
      'open-change-count',
      'reproducible-build-rate'
    ],
    questionIds: configurationChangeQuestionIds,
    componentIds: configurationChangeComponentIds,
    lines: ['process', 'execution', 'quality'],
    clarificationKeys: ['project-key', 'release-version', 'configuration-baseline', 'change-window']
  },
  {
    id: 'gjb5000b-compliance',
    name: '过程证据审计',
    description: '裁剪基线、过程活动和证据链的受控样例；不代表官方符合性结论。',
    status: 'planned',
    roleIds: ['qa-epg', 'model-org-manager'],
    metricIds: ['process-compliance'],
    questionIds: ['project-overview-process-question'],
    componentIds: ['project-overview-process-card'],
    lines: ['process']
  },
  {
    id: 'organization-improvement',
    name: '组织改进',
    description: '组织级项目风险和健康信号的受控样例。',
    status: 'planned',
    roleIds: ['model-org-manager', 'qa-epg'],
    metricIds: ['project-health', 'high-risk-count', 'process-compliance'],
    questionIds: [
      'project-overview-health-question',
      'project-overview-risk-question',
      'project-overview-process-question'
    ],
    componentIds: [
      'project-overview-health-card',
      'project-overview-risk-card',
      'project-overview-process-card'
    ],
    lines: ['organization', 'process']
  }
]

const qualityPolicy: DashboardQualityPolicy = {
  weights: {
    businessMetric: 30,
    processCompliance: 20,
    semanticConsistency: 20,
    layoutReadability: 15,
    dataTrust: 10,
    accessibilityInteraction: 5
  },
  formalAcceptanceThreshold: 90,
  previewThreshold: 80,
  vetoCodes: [
    'metric-definition-error',
    'fabricated-data',
    'permission-violation',
    'invalid-tailoring-baseline'
  ],
  notes: [
    '80-89 分仅允许预览，低于 80 分应修复或澄清。',
    '任一 veto code 命中时不得以总分覆盖门禁。',
    '阈值和权重属于应用质量策略，不是官方符合性结论。'
  ]
}

export const dashboardDomainCatalog: DashboardDomainCatalog = {
  version: '1.0',
  domainId: 'sdlc-gjb5000b-controlled-sample',
  roles: ['project-owner', 'qa-epg', 'rd-lead', 'model-org-manager'],
  scenarios,
  metrics,
  questions,
  components,
  processBindings,
  qualityPolicy
}

export const getDashboardDomainCatalog = (): DashboardDomainCatalog => dashboardDomainCatalog

export default dashboardDomainCatalog
