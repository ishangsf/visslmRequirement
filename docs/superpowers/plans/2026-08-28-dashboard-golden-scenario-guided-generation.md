# 黄金场景驱动大屏生成向导开发计划

> 状态：计划草案（只定义实施，不包含本计划阶段内的代码变更）  
> 依据：`docs/superpowers/specs/2026-08-28-sdlc-gjb5000b-dashboard-golden-scenarios-design.md`  
> 目标版本：VISSLM 工作台 v1.x 增量能力

## 1. 产品判断与开发目标

### 1.1 产品判断

黄金场景入口有价值，但不能被实现成“模板商城”或“逐个组件配置表单”。黄金场景应表达用户要解决的业务决策问题，并作为 AI 生成和质量门禁的受控输入；组件、查询、标题、布局和过程证据由统一生成链路编排，只有存在歧义或缺口时才让用户确认。

### 1.2 目标

- 让项目负责人、QA/EPG、研发负责人、型号/组织管理负责人可以从业务目标出发快速生成首版大屏。
- 将场景选择、AI 助手自然语言和已有大屏 AI 修改统一到同一个 `AnalysisBlueprint → DashboardSpec → QuerySpec` 链路。
- 在生成前透明展示数据准备度、字段映射、项目/权限范围和过程证据缺口。
- 生成结果继续经过语义、权限、数据可信度、布局和可访问性门禁，不因预置场景绕过 fail-closed 约束。
- 以首版可用率、语义正确率和生成耗时验证价值，避免仅以“能生成组件”作为成功标准。

### 1.3 非目标

- 不重新建设一套独立的 BI 查询或组件编排引擎。
- 不要求用户在主流程中手工配置每一个组件。
- 不允许用模拟数据填补正式大屏的关键指标缺失。
- 不替代 AI 助手自然语言入口，也不把自然语言能力降级为场景名称匹配。
- 不在本阶段扩展销售、财务等泛经营场景。

## 2. 现状与可复用基础

现有代码已经提供以下基础，开发应优先复用而不是复制：

- `src/main/experts/dashboard-domain-catalog.ts`：8 个黄金场景、指标、问题、组件和过程绑定目录。
- `src/main/experts/dashboard-domain-blueprint.ts`：场景到 `AnalysisBlueprint` 的受控编译。
- `src/main/experts/dashboard-domain-generation.ts`：蓝图到 `DashboardSpec/QuerySpec` 的生成、查询、回执和数据模式。
- `src/main/experts/dashboard-domain-chat.ts`：AI 助手场景识别、追问和生成入口。
- `src/main/experts/dashboard-domain-adapter.ts`：平台适配器、项目范围、权限和证据的 fail-closed 校验。
- `src/renderer/src/dashboard/DashboardStudio.tsx`：画布优先工作台、组件库、属性面板、AI 修改、检查、预览、保存。
- `src/renderer/src/dashboard/componentRegistry.ts` 与 `dashboardComponentFactory.ts`：内置组件定义和手工添加能力。
- `src/shared/dashboard.ts` 与 `src/shared/dashboard-domain.ts`：大屏、蓝图、语义绑定、领域目录和生成回执契约。
- 现有黄金场景、质量、UI 和 Electron smoke：可作为回归基线，不应被新入口分叉。

## 3. 目标用户与核心任务

| 用户 | 进入问题 | 最小需要确认的信息 | 生成后最关心的结果 |
| --- | --- | --- | --- |
| 项目负责人 | 项目能否按期、按质、合规交付 | 项目、周期、版本/阶段 | 健康度、里程碑、需求、质量、风险、过程符合度 |
| QA/EPG | 过程是否真实执行、证据是否充分 | 过程域、裁剪基线、审计周期 | 符合度、证据、偏差、不符合项整改 |
| 研发负责人 | 当前迭代卡在哪里、质量风险来自哪里 | 迭代/版本、团队范围、周期 | 任务、构建、测试、缺陷和阻塞 |
| 型号/组织负责人 | 哪些项目需要管理干预 | 组织、项目群、时间窗口 | 项目群矩阵、质量差异、资源/风险和改进 |

## 4. 目标用户流程

### 4.1 入口分流

在“可视化大屏”工作台提供“新建大屏”或“从场景开始”入口，显示三种路径：

1. **推荐黄金场景**：适合标准化管理问题，使用受控场景契约。
2. **自然语言描述目标**：进入 AI 助手/数据可视化专家，仍解析到同一场景与蓝图。
3. **自由搭建**：使用现有组件库和属性面板，不强制绑定黄金场景。

三条入口最终都只能产生同一种 `DashboardSpec`，并共享校验、审计、保存和版本机制。

### 4.2 场景中心

场景卡片按角色和决策主题分组，不按图表类型分组。每张卡片展示：

- 场景名称和业务问题。
- 适用角色。
- 预置的首屏结构（结论 → 趋势 → 诊断 → 明细）。
- 核心指标数量、过程证据要求和预计数据准备度。
- “可直接生成”“需补充字段”“需配置平台适配器”等状态。
- “查看示例”“开始配置”两个动作。

### 4.3 四步配置向导

#### Step 1：确认目标

- 选择角色和场景；显示业务问题、指标目录和默认组件结构。
- 允许用户修改面向对象、目标描述和大屏标题意图，但不允许直接改写指标口径。
- 若角色不适用场景，阻止继续并给出适用角色。

#### Step 2：数据准备度与权限

- 选择数据模式：受控样例（仅预览）或平台适配器（真实项目范围）。
- 选择组织/项目/版本/阶段/时间范围/基线等 `DataScope`。
- 展示每个核心指标的字段映射、可用性、敏感级别、数据行数和更新时间。
- 展示平台适配器的 allowed project、permissions、nodeTypes、tailoring baseline 和证据状态。
- 将缺口分为：可降级、需要用户确认、必须阻断；不得静默填充。

#### Step 3：确认分析口径

- 只呈现存在多个有效口径或用户可选择的少量决策项。
- 每项显示定义、公式版本、聚合方式、时间语义、阈值和来源。
- 组件不是主流程配置对象；提供“查看组件方案”而非要求逐组件编辑。
- 允许进入“高级设置”调整维度、排序、Top N、阈值或组件类型，调整后标记为用户覆盖并保留语义绑定。

#### Step 4：生成预览与验收

- 生成 `AnalysisBlueprint`、`DashboardSpec`、查询结果和领域回执。
- 预览页以画布为主，右侧显示生成回执：采用口径、数据范围、缺失项、可信度、过程证据和推荐行动。
- 每个组件可查看业务问题、指标、QuerySpec、数据来源和下钻目标。
- 执行质量检查；低于正式阈值只能预览/继续修改，触发一票否决时不得保存为正式产物。
- 用户确认后进入现有工作台，继续使用 AI 修改、组件库、属性面板、检查、版本、导出和保存。

### 4.4 AI 统一入口

场景中心提交的结构化输入应转换成与自然语言等价的 `DashboardDomainGenerationInput`；AI 助手识别出的场景也应回显为同一份向导草稿。两者不可各自维护一套标题生成、布局生成或权限判断逻辑。

## 5. 技术方案与契约

### 5.1 共享契约（先行）

建议在 `src/shared/dashboard-domain.ts` 增加以下类型，字段保持可序列化、无凭据：

```ts
export type DashboardScenarioEntry = 'gallery' | 'assistant' | 'blank'

export type DashboardReadinessLevel = 'ready' | 'partial' | 'blocked'

export interface DashboardScenarioReadiness {
  scenarioId: string
  level: DashboardReadinessLevel
  metricStatuses: Array<{
    metricId: string
    availability: DashboardMetricAvailability
    resolvedField?: string
    reason?: string
  }>
  projectIds: string[]
  missingPermissions: string[]
  missingEvidence: string[]
  warnings: string[]
  checkedAt: string
}

export interface DashboardScenarioDraft {
  entry: DashboardScenarioEntry
  scenarioId: string
  role: DashboardDomainRole
  scope: DataScope
  metricOverrides?: Record<string, unknown>
  componentOverrides?: Record<string, unknown>
  generatedAt: string
}
```

实际实现时应复用已有 `DataScope`，并由 validator 限制 overrides 的字段和大小；不能把任意 JSON 直接交给模型或查询引擎。

### 5.2 主进程服务边界

新建 `src/main/experts/dashboard-domain-readiness.ts`，职责仅限于：

- 读取目录、字段画像、项目范围和平台适配器。
- 计算场景的指标、问题、过程证据和权限准备度。
- 输出可解释、稳定、无敏感数据的 readiness 结果。
- 不生成 Dashboard，不执行未通过范围校验的查询。

扩展 `src/main/experts/dashboard-domain-chat.ts` 或抽取共享编排函数，使场景入口和 AI 助手都调用同一套：

```text
resolve scenario
  → build readiness
  → collect only required clarifications
  → compile blueprint
  → generate dashboard
  → validate/diagnose
```

### 5.3 IPC/API

优先新增两个窄接口，避免把主进程实现泄漏到 renderer：

- `dashboard-domain:readiness`：输入 `DashboardScenarioDraft` 的场景/角色/范围/适配器引用，输出 `DashboardScenarioReadiness`。
- `dashboard-domain:generate-from-scenario`：输入已确认的 draft，输出现有 `DashboardDomainGenerationResult` 或等价的统一结果。

同步修改：

- `src/main/index.ts` 注册 handler，并在 handler 内重新做输入校验和权限范围校验。
- `src/preload/index.ts` 暴露最小 API。
- `src/shared/types.ts` 扩展 `AppApi`，保持错误码和返回状态稳定。

若证明现有 `askAgent` 可以无损承载结构化 draft，则生成接口可以复用 `askAgent`，但 readiness 仍应独立，以便向导在生成前显示缺口。

### 5.4 前端组件边界

建议新增：

- `src/renderer/src/dashboard/DashboardScenarioGallery.tsx`：角色筛选、卡片、准备度状态和场景预览。
- `src/renderer/src/dashboard/DashboardScenarioWizard.tsx`：四步向导、草稿状态、错误/阻断/返回逻辑。
- `src/renderer/src/dashboard/dashboardScenarioUi.ts`：场景展示元数据、角色分组、状态文案和图标映射。

修改：

- `src/renderer/src/dashboard/DashboardStudio.tsx`：接入入口、打开向导、接收生成结果，不复制生成逻辑。
- `src/renderer/src/App.tsx`：必要时支持从 AI 助手跳转到大屏并携带 draft，不增加第二套 dashboard 状态。
- `src/renderer/src/styles.css`：沿用 `--surface-*`、`--stroke`、`--accent` 等主题变量，确保窄窗口和画布优先布局。

## 6. 分阶段实施计划

### Phase 0：价值验证与基线（1 个迭代）

**目标**：确认用户真正需要“场景入口”，而不是更多图表。

**任务**：

- 固化 8 个场景的角色、业务问题、核心指标、准备度状态和组件摘要。
- 选取“项目综合态势”和“GJB5000B 过程符合度与证据审计”作为代表场景。
- 记录当前自然语言生成的首版可用率、生成耗时、追问次数、质量分和手工修改比例。
- 用现有受控样例和平台适配器各准备一套可复现数据。

**产出**：场景入口验收指标、两场景 UI 线框/交互说明、基线报告。

**门禁**：若两个代表场景在真实数据准备度上均无法达到“可预览”，先补数据映射，不进入大规模 UI 开发。

### Phase 1：共享契约与 readiness 服务（1～2 个迭代）

**文件范围**：

- 修改 `src/shared/dashboard-domain.ts`、`src/shared/types.ts`。
- 新建 `src/main/experts/dashboard-domain-readiness.ts`。
- 修改 `src/main/index.ts`、`src/preload/index.ts`。

**任务**：

- 实现 draft、readiness 和稳定错误码。
- 明确 ready/partial/blocked 三态和阻断规则。
- 复用现有 adapter scope、permission、profile、evidence 校验。
- 为 readiness 增加脱敏和大小限制，禁止将无权字段带入模型上下文。

**验证**：

- 新增 `scripts/smoke-dashboard-scenario-readiness.ts`。
- 覆盖空项目、越权项目、缺字段、敏感字段、缺证据、裁剪基线不匹配、混合项目范围。
- 运行 `npm run typecheck`、现有 `smoke:dashboard-domain-platform-adapter`、`smoke:dashboard-gjb5000b-domain`。

### Phase 2：场景中心与入口分流（1 个迭代）

**文件范围**：

- 新建 `DashboardScenarioGallery.tsx`、`dashboardScenarioUi.ts`。
- 修改 `DashboardStudio.tsx`、`styles.css`。

**任务**：

- 实现场景卡片、角色筛选、准备度标签、示例预览和开始配置。
- 增加“推荐场景 / AI 描述 / 自由搭建”三入口。
- 场景展示文案直接来自受控目录映射，避免前端复制业务口径。
- 在 1200、1000、760、680px 宽度下保持卡片可读，不挤占画布。

**验证**：

- 新增 `scripts/smoke-dashboard-scenario-gallery-ui.mjs`。
- 验证键盘可达、焦点态、暗色/亮色主题、窄窗口换行和空 readiness 状态。
- 不改变现有 `smoke:dashboard-editor`、`smoke:dashboard-inspector-ui` 结果。

### Phase 3：四步配置向导（1～2 个迭代）

**文件范围**：

- 新建 `DashboardScenarioWizard.tsx`。
- 修改 `DashboardStudio.tsx`、`styles.css`。

**任务**：

- 实现 Step 1～4 的受控状态机和本地草稿恢复。
- Step 2 接入 readiness，按阻断级别显示操作：继续、补配置、返回适配器设置。
- Step 3 只呈现歧义项和高级设置；组件方案默认只读可解释。
- Step 4 接收统一生成结果，显示回执、质量报告和组件数据口径。
- 关闭/返回/刷新时保留未提交 draft；清理策略和版本号写入设计。

**验证**：

- 新增 `scripts/smoke-dashboard-scenario-wizard-ui.mjs`。
- 覆盖返回上一步、重复提交、生成中取消、查询失败保留成功组件、质量低于正式阈值、缺权限和缺字段。
- 验证所有数量与单位不换行、表格/明细只在内部滚动、不会把主画布撑高。

### Phase 4：统一生成链路和 AI 助手回写（1～2 个迭代）

**文件范围**：

- 修改 `src/main/experts/dashboard-domain-chat.ts`、`dashboard-domain-generation.ts`，必要时抽取共享 orchestration。
- 修改 `src/main/index.ts`、`src/renderer/src/App.tsx`、`DashboardAiDrawer.tsx`。

**任务**：

- 场景入口和自然语言入口统一解析到同一 `DashboardDomainGenerationInput`。
- AI 助手识别到黄金场景时，向大屏传递 draft 和 readiness，而不是复制生成结果。
- 统一标题生成、业务上下文、domainContext、domainReceipt 和质量回执。
- 明确展示修改、分析修改、过程修改的重算边界；场景确认不重复执行无关查询。

**验证**：

- 新增 `scripts/smoke-dashboard-scenario-entrypoint-consistency.ts`。
- 同一场景/范围从场景中心和 AI 助手生成，比较蓝图、标题语义、组件数量、QuerySpec、权限和质量结果。
- 运行 `smoke:dashboard-gjb5000b-chat`、`smoke:dashboard-gjb5000b-generation`、`smoke:dashboard-gjb5000b-quality-integration`。

### Phase 5：首批场景上线与人工反馈闭环（1 个迭代）

**范围**：先上线“项目综合态势”和“GJB5000B 过程符合度与证据审计”。

**任务**：

- 为两场景补齐可读的示例数据、指标缺口说明和角色化推荐行动。
- 将场景状态区分为“可预览”和“可正式保存”，不把受控样例误标为真实平台结论。
- 记录用户选择、readiness 阻断、完成向导、质量得分、保存和返回 AI 修改等事件。

**上线门禁**：

- 无伪造数据、权限越界、指标定义错误和非法裁剪基线。
- 两个场景在受控样例下均可完整走通；真实适配器缺口必须透明显示。
- 场景入口与 AI 入口一致性 smoke 全部通过。

### Phase 6：扩展剩余 6 个场景（2 个迭代）

按“需求/计划/质量/测试/配置/组织”顺序逐个启用，不允许一次性打开全部场景而跳过数据准备度。

每个场景必须完成：

- 指标和过程绑定审查。
- 角色适用性、项目范围和权限矩阵。
- 受控样例与真实适配器 readiness 夹具。
- 组件布局和下钻路径验收。
- 空数据、缺字段、高基数、时间字段和数值字符串回归。
- 场景专属 smoke 与统一入口一致性检查。

### Phase 7：质量、性能和灰度（1 个迭代）

**任务**：

- 建立场景生成 P50/P95 耗时和查询次数基线。
- 对 readiness、生成、诊断和保存增加审计日志关联 ID。
- 以 feature flag 或场景状态控制启用范围，支持单场景回退到 AI/自由搭建。
- 收集两周使用数据后评估是否需要更多高级配置，而不是预先扩展向导复杂度。

## 7. 测试与验收矩阵

### 7.1 契约与主流程

- 类型检查：`npm run typecheck`
- 场景目录与蓝图：`npm run smoke:dashboard-gjb5000b-blueprint`
- 生成：`npm run smoke:dashboard-gjb5000b-generation`
- 统一入口：新增场景中心/AI 一致性 smoke
- 保存门禁：`npm run smoke:dashboard-gjb5000b-save-gate`

### 7.2 安全与可信度

- 越权项目不会出现在 readiness、模型上下文、QuerySpec 或回执。
- 缺权限返回稳定 `insufficient-permission`；适配器范围越界返回 `adapter-scope-violation`。
- 缺关键字段或证据不会被模拟值补齐。
- 正式保存拒绝质量一票否决项；预览状态保留缺口说明。

### 7.3 UI 与可访问性

- 暗色/亮色主题均使用主题变量，不出现局部白色内容块。
- 画布优先：组件库和属性面板不挤压主画布；窄窗口内部滚动。
- 向导可全键盘操作，按钮、图标、状态和进度有可访问名称。
- 1200、1000、760、680px 下无裁切、遮挡和主页面无边界纵向撑高。

### 7.4 性能

- readiness 不得执行未授权查询；重复检查在同一 draft/数据快照下可缓存。
- 生成只重算受影响组件；展示修改查询执行次数为 0。
- 大屏预览打开时间、生成 P95 和内存增长不得超过现有基线 20%。

## 8. 验收标准（Definition of Done）

功能只有同时满足以下条件才可接受：

1. 用户可以从场景中心、AI 助手和自由搭建进入，且三者不会形成三套 DashboardSpec 生成逻辑。
2. 至少两个首批场景完整走通“选择 → readiness → 生成 → 质量检查 → 预览/保存”。
3. 主流程不要求逐个配置组件；高级配置不会破坏语义绑定和权限范围。
4. 标题、业务问题、指标、查询、组件和数据回执相互一致。
5. 缺字段、缺证据、无权限和裁剪基线不确定时，系统明确阻断或降级，不生成虚假正式结论。
6. 场景入口与自然语言入口对同一输入的生成结果满足契约一致性。
7. TypeScript、领域 smoke、UI smoke、质量门禁、Electron 视觉检查和 `git diff --check` 全部通过。
8. 记录并评估首版可用率、生成耗时、追问次数、质量分和用户修改比例，决定是否进入下一阶段。

## 9. 风险与回退策略

| 风险 | 早期信号 | 应对 | 回退 |
| --- | --- | --- | --- |
| 场景模板掩盖数据缺口 | readiness 多为 partial/blocked | 先补适配器和字段画像，不扩大 UI | 仅保留 AI/自由搭建入口 |
| 向导配置过重 | Step 3 放弃率高、修改比例高 | 减少必填项，把配置移入高级设置 | 只上线场景卡片 + 一键预览 |
| AI 与场景入口结果漂移 | 同输入蓝图/QuerySpec 不一致 | 强制共享 orchestration 和一致性 smoke | 关闭场景生成，保留 AI 入口 |
| 过程结论被误当正式合规 | 用户在受控样例上保存正式产物 | 强化 artifactStatus、回执和保存门禁 | 禁止该场景正式保存 |
| 组件/属性面板再次挤压画布 | 窄窗口出现裁切或撑高 | 延续画布优先和响应式内部滚动 | 隐藏高级面板，不影响生成 |

## 10. 实施顺序与责任边界

1. 先完成契约、readiness 和入口一致性，再做视觉向导；不能先堆 UI 再补安全校验。
2. 主进程负责目录、权限、数据准备度、生成和质量门禁；renderer 只负责交互状态和展示。
3. 场景目录是业务事实来源；前端展示元数据不得复制指标公式和过程结论。
4. 测试先覆盖两个代表场景，再扩展其余六个；每个阶段保留可回退的 feature flag。
5. 本计划完成前不新增与黄金场景无关的图表类型、跨域数据源或泛经营模板。

