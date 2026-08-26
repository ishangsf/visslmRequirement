# AI 助手执行计划可编辑优化需求

> 状态：可实现需求合同（v1）
> 范围：仅覆盖执行前的只读计划确认；不改变任务路由和权限边界。
> 对照：`src/shared/expert-types.ts` 的 `AssistantExecutionSummary`、`src/shared/types.ts` 的 `ChatRequest/ChatResponse`、`src/main/assistant/plan-confirmation.ts`、`src/main/ollama.ts`。

## 1. 目标与范围

当前执行摘要只读，用户只能确认模型生成的计划。改造后，数据型任务在访问证据前先展示计划；用户可以修改允许的范围和查询参数，提交后主进程校验并用“实际确认后的计划”执行。

本期必须覆盖：

- 检索词、读取字段、项目范围、数据类型、筛选条件、结果上限的编辑；
- 在任务类型允许的范围内切换交付形式；
- 前端编辑态、确认态、校验错误态、取消态和过期态；
- 主进程对 renderer 提交的 patch 重新校验、归一化、截断（clamp）、去重和权限/目录校验；
- 执行、回答中的 `executionSummary`、`ChatMessage.dataScope` 均使用同一份最终有效计划/范围。

本期不做：

- 修改 `sourceMode`、`taskType`、`intent`、用户问题原文、执行 Agent、权限或工具集合；
- 任意 SQL、脚本、正则、函数、代码或未注册工具执行；
- 写入数据、推送、删除、修改 Dashboard/记录的操作；
- 编辑后即时预览命中数。确认前只允许读取字段/项目/类型等元数据，不得查询记录、检索文档或读取证据；
- 通过编辑计划替代重新提问、重新路由或澄清流程。

## 2. 不可破坏的控制原则

1. `runId` 是一次运行的唯一身份。计划事件、确认请求、取消请求和最终响应必须属于同一 `runId`；不可用请求不得触发任何证据工具。
2. `question` 在卡片中显示为只读的用户原文。实现须在自动意图将 `request.question` 替换为 `resolvedQuestion` 之前保存原文；`resolvedQuestion` 仍是内部规划上下文，不得变成可编辑问题。
3. `sourceMode`、`taskType`、`intent` 是主进程已确认的路由事实。客户端不得通过 patch 改写，也不得因交付形式变化而重新路由。
4. 编辑只在 renderer 本地形成草稿；输入变化、失焦、展开/收起和错误重试都不能提前执行证据工具。
5. 主进程确认成功时一次性冻结规范化后的有效计划；确认后再次提交同一 `runId` 不得改变计划或重复执行。
6. 取消、窗口关闭、超时、跨窗口确认、未知 `runId` 和运行已结束均释放等待且不访问证据；最终消息不得保存未完成证据。

## 3. 用户流程

1. 用户提交问题。现有分类、路由和计划生成照常执行；允许读取字段目录、项目列表、节点类型等元数据以生成和校验计划。
2. 主进程发送现有 `agent:event` 的 `type: 'plan'` 事件，携带 `runId`、`AssistantExecutionSummary` 和 `requiresConfirmation: true`。计划卡展示“等待确认”，固定事实和可编辑字段分区显示。
3. 用户可修改一个或多个可编辑字段。卡片应即时显示规范化前的草稿和待确认状态；“恢复模型计划”只恢复本地草稿，不发起新运行。
4. 用户按“确认并执行”。前端提交 `runId + patch`，确认按钮和编辑控件进入 loading/disabled；取消按钮仍可用。
5. 主进程验证 owner、`runId`、运行状态、patch 结构、字段目录、项目/类型权限及交付兼容性；验证失败返回逐字段错误，pending 保持等待，用户可修正后再次确认。
6. 验证成功后主进程返回 `approved` 和规范化后的 `effectiveSummary`，解除等待；执行器收到的必须是该有效计划，而不是确认前的旧计划。
7. 完成响应中的 `executionSummary` 等于有效计划的摘要；精确的 `dataScope`（含必要的 `recordUids`、项目、类型、范围过滤和快照）作为本轮实际范围持久化。无证据的取消/失败响应不得伪造成功范围。

## 4. 卡片展示与编辑规则

### 4.1 固定只读字段

以下字段始终显示，但没有输入控件，也不能出现在可编辑 patch 中：

- `question`：用户提交的原文；
- `sourceMode`：`conversation / records / knowledge / mixed`；
- `taskType`：`conversation / record_query / knowledge_qa / mixed_analysis / visualization / requirement_matching`；
- `intent`：当前已校验的计划意图；
- `groupEntities`、`groupByField`、`sort`、`metric`、`searchMode`：现有计划的执行语义；
- `scope.recordCount`、`scope.snapshotAt` 以及内部 `recordUids`：范围快照/指定记录的审计事实，不允许在本期编辑。

尝试提交上述字段或未知字段，返回 `PLAN_PATCH_FIELD_NOT_ALLOWED`，不得静默接受。

### 4.2 可编辑字段

| 卡片字段 | patch 路径 | 规则与边界 | 成功后的执行语义 |
| --- | --- | --- | --- |
| 检索词 | `searchTerms` | 数组最多 10 项；逐项 NFKC、trim，空项丢弃；按不区分大小写的规范值去重；每项最多 240 字符。用户输入的词不要求出现在原问题中，但不得包含控制字符。 | records/mixed 传给数据中心搜索；knowledge/mixed 传给知识检索适配器。保留不可编辑的 `searchMode`。 |
| 读取字段 | `fields` | 数组最多 20 项；按字段目录 canonical key 校正显示名/大小写；重复项去重；不存在、已禁用或与当前数据类型不兼容时返回 `FIELD_NOT_FOUND`/`FIELD_NOT_ALLOWED`。空数组表示按任务默认字段，不等于读取全部原始字段。 | 查询工具只能读取最终字段集合；不得因为模型旧计划而把删除的字段带回结果。纯 knowledge、需求匹配和 Dashboard 计划若无字段编辑能力，应隐藏为不可编辑并拒绝该 patch。 |
| 项目范围 | `scope.projectIds` | 多选现有项目 ID；最多 100 项；trim 后按 canonical ID 去重；空数组表示当前权限内全部项目。未知或无权项目返回 `PROJECT_NOT_FOUND`/`PROJECT_NOT_ALLOWED`。 | 最终查询只扫描该项目集合；多项目执行须按同一计划合并并按 UID 去重，不能退回只使用原 `request.projectId`。 |
| 数据类型 | `scope.nodeTypes` | 多选 `listNodeTypes()` 返回的类型；最多 100 项；trim/按目录 canonical 化并去重；空数组表示全部可用类型；未知类型返回 `NODE_TYPE_NOT_FOUND`。 | 最终查询只扫描这些节点类型；多类型结果必须保持同一过滤、字段和上限。 |
| 筛选条件 | `filters`、`scope.baseFilters` | 两组条件均可在卡片中增删改；每组最多 10 条，合并后的有效条件最多 10 条，超出返回 `FILTER_LIMIT_EXCEEDED`，不得静默丢弃。执行时两组按 AND 合并。字段必须来自目录。操作符仅允许 `equals`、`not_equals`、`contains`、`not_contains`、`is_empty`、`not_empty`、`gt`、`gte`、`lt`、`lte`；值 trim 后最多 240 字符；`is_empty/not_empty` 禁止 value，其他操作符必须有非空 value。按 `field + operator + normalized value` 去重。 | 过滤条件必须真实传入最终执行计划；不能仅更新摘要显示。继承范围条件与本轮计划条件均须生效并在最终摘要中保留来源。 |
| 结果上限 | `limit` | 必须为有限数；取整后 clamp 到 1–50。小于 1 归一为 1，大于 50 归一为 50；NaN、Infinity、无法解析的值返回 `LIMIT_INVALID`。前端显示实际归一值及必要的提示。 | 最终查询/可用交付适配器使用该上限；不得继续使用旧 `plan.limit`。它不替代知识证据预算、模型上下文预算或分页总数。 |
| 交付形式 | `resultMode` | 只能在下表兼容集合内选择；`grouped_list` 只有原计划已有合法 `groupEntities` 时可选，否则返回 `RESULT_MODE_REQUIRES_GROUP_ENTITIES`。 | 只改变已确定任务的呈现方式，不改变来源、任务或意图。 |

`scope` 是局部 patch：未提交的子字段保持原值，提交 `[]` 才表示“清空为全部”。`scope.recordCount/snapshotAt` 和隐藏的 `recordUids` 不属于 patch。若存在显式 `recordUids`，它们是不可扩大的硬边界；项目、类型和过滤条件只能进一步取交集，交集为空返回 `SCOPE_EMPTY`，不得访问证据。两组过滤条件合并后必须再次去重并限制为最多 10 条。

### 4.3 交付形式兼容矩阵

| `taskType + sourceMode` | 允许的 `resultMode` | 备注 |
| --- | --- | --- |
| `record_query + records` | `answer`、`list`、`grouped_list`、`table` | `grouped_list` 需已有 `groupEntities`；不允许 `dashboard`。 |
| `knowledge_qa + knowledge` | `answer` | 文档证据上限仍由独立 `evidenceLimit` 控制；`limit` 可作为文档结果上限传给适配器，适配器上限为 20 并在发生 clamp 时返回 warning；不得假装生成记录表格。 |
| `mixed_analysis + mixed` | `answer`、`list`、`grouped_list`、`table` | 记录和文档来源仍须分开标识；分组只作用于已有记录实体。 |
| `visualization + records` | `dashboard` | 交付形式固定；可编辑范围必须由可视化执行器真正消费。 |
| `requirement_matching + records` | `answer` | 需求匹配专用语义固定；检索词只有在执行器支持时才显示可编辑。 |

`conversation + conversation` 不产生确认卡。任何不在矩阵中的组合都返回 `RESULT_MODE_NOT_COMPATIBLE`，不降级为普通对话或另一种 Agent。

## 5. 前后端合同

### 5.1 共享输入/输出形状

在现有类型旁增加等价的共享合同（名称可按项目命名规范调整，但字段语义不可改变）：

```ts
type AssistantPlanPatch = {
  searchTerms?: string[]
  fields?: string[]
  scope?: {
    projectIds?: string[]
    nodeTypes?: string[]
    baseFilters?: Array<{
      field: string
      operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' |
        'is_empty' | 'not_empty' | 'gt' | 'gte' | 'lt' | 'lte'
      value?: string
    }>
  }
  filters?: Array<{
    field: string
    operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' |
      'is_empty' | 'not_empty' | 'gt' | 'gte' | 'lt' | 'lte'
    value?: string
  }>
  limit?: number
  resultMode?: 'answer' | 'list' | 'grouped_list' | 'table' | 'dashboard'
}

type ConfirmAgentPlanResult = {
  status: 'approved' | 'invalid' | 'not_found'
  runId: string
  effectiveSummary?: AssistantExecutionSummary
  errors?: Array<{ field: string; code: string; message: string }>
  warnings?: Array<{ field: string; code: string; message: string }>
}
```

### 5.2 IPC

- 保留 channel `agent:confirm-plan` 和方法名 `confirmAgentPlan`；签名扩展为 `confirmAgentPlan(runId: string, patch?: AssistantPlanPatch)`。省略 patch 是兼容的“确认原计划”调用。
- preload 只转发受类型约束的 `runId` 和 patch，不把完整 `AssistantExecutionSummary` 当作可信计划；renderer 不能提交 `question/sourceMode/taskType/intent`。
- `agent:event` 的 `type: 'plan'` 仍是计划展示入口，`runId` 来自外层 `AgentProgressUpdate`。如一次 run 只产生一个确认计划，则不另设版本号；若将来允许重规划，必须增加单调 `planRevision` 并同时校验 `runId + planRevision`。
- `approved` 必须携带 `effectiveSummary`，其所有可编辑字段是归一化后的最终值；`invalid` 携带逐字段错误且 pending 仍存在；`not_found` 用于不存在、非 owner、已确认、已取消、已过期或窗口已关闭，不泄漏其他 run 信息。

### 5.3 主进程确认与执行

`AssistantPlanConfirmationController` 的 pending 项必须保存 owner、runId、原始计划、原始精确 `dataScope` 和 AbortSignal；确认结果解析为规范化有效计划，不能继续只 `resolve<void>`。

确认处理顺序固定为：

1. 校验 runId 非空、owner 与 pending 一致、signal 未取消、pending 未过期；
2. 拒绝未知/不可编辑字段，基于原计划合并 patch；
3. 只读取元数据做 canonical 化和校验：字段目录、项目列表、节点类型、任务/来源/交付兼容性；
4. 对数组、字符串、过滤器和 limit 执行 trim、clamp、canonical 化、去重；检查必需条件（例如记录查询编辑后不能同时没有检索词和过滤条件，除非是允许全范围的统计/显式记录范围）；
5. 形成 `effectivePlan + effectiveDataScope`，冻结并返回 `approved`；
6. 将该对象传入真正的执行器。

数据中心执行器不得再调用 `executePlan(request.projectId, originalPlan)`。它必须接收有效项目集合、节点类型、显式记录 ID 交集、两组过滤条件、最终检索词、字段、排序/分组等不可编辑语义和最终 limit。知识库、可视化和需求匹配适配器同样不得忽略其适用的已编辑值；若某字段无法被执行器消费，必须在卡片禁用或确认前返回不支持错误。

## 6. 错误与状态

| 场景 | 返回/展示 | 是否保持 pending | 是否访问证据 |
| --- | --- | --- | --- |
| 字段、项目、类型不存在/无权 | 对应字段错误，提示重新选择 | 是 | 否 |
| 过滤器结构、操作符或 value 不合法 | `FILTER_INVALID` | 是 | 否 |
| 结果上限不可解析/交付形式不兼容 | `LIMIT_INVALID` / `RESULT_MODE_NOT_COMPATIBLE` | 是 | 否 |
| 编辑后缺少任务必需范围 | `QUERY_SCOPE_REQUIRED` | 是 | 否 |
| 显式记录范围与新范围无交集 | `SCOPE_EMPTY` | 是 | 否 |
| patch 包含固定字段或未知键 | `PLAN_PATCH_FIELD_NOT_ALLOWED` | 是 | 否 |
| runId 不存在、跨窗口、已确认、已取消或超时 | `not_found`；提示“执行计划已失效，请重新提交问题” | 否 | 否 |
| 用户点击取消/停止、AbortSignal 中止、窗口关闭 | 取消响应，标记 `cancelled/undone` | 否 | 否 |
| 通过验证后执行器失败 | 结构化可恢复失败；保留已确认的实际范围，不伪造结果 | 否 | 已按有效计划开始，失败后停止后续调用 |

pending 超时采用 10 分钟安全上限；同一 owner 可并发多个不同 runId，但每个确认只影响自己的 run。前端忽略不匹配当前 run/session 的事件；重复点击由 UI 禁用和主进程 one-shot 共同防护。

## 7. 持久化与兼容性

- 现有 `ChatMessage.executionSummary?: AssistantExecutionSummary` 保持兼容；旧历史没有该字段时照常展示，不补造计划。
- 成功响应保存 `effectiveSummary`，不能保存卡片打开时的原摘要。`ChatMessage.dataScope` 保存有效范围；若有 `recordUids`，保存完整实际集合或现有受控快照引用，不能只保存 `recordCount` 代替精确范围。
- 会话级范围恢复使用最近一次成功消息的有效 `dataScope`；取消、失败和 `undone` 消息不得覆盖会话范围。开始新会话仍清除范围。
- 旧 renderer/调用方只传 `confirmAgentPlan(runId)` 时，主进程按“无编辑确认原计划”处理，仍执行同一套校验和归一化；不接受旧调用方传入完整摘要绕过校验。
- 兼容旧 `scope.baseFilters` 的 `FilterSpec` 操作符时，在主进程映射到本合同的标准操作符后再执行；无法无损映射的条件拒绝，不静默丢弃。

## 8. 可用性与主题验收

- 卡片在全屏、1200px、1000px、760px、680px 附近均可操作；窄窗口下字段、项目、类型、过滤器和按钮纵向堆叠，内容超出只在卡片内部滚动，不撑高消息区或主页面。
- 完整键盘路径为：进入卡片 → 每个输入/选择器 → 增删过滤器/标签 → 恢复草稿 → 确认 → 取消；所有图标按钮有可访问名称，删除标签支持键盘，确认/取消具有 `focus-visible` 状态，loading 不跳动。
- 编辑中的错误与成功状态有文本/ARIA 语义，不只用颜色表达；暗色和亮色均使用现有 `--surface-*`、`--stroke`、`--text-*`、`--accent`、`--state-*` 变量，不出现白色或浅蓝色局部块。

## 9. 验收标准

### 功能与安全

- 计划事件出现后，在任意编辑操作期间，记录查询、知识检索、聚合、匹配和可视化 QuerySpec 均未执行；元数据校验不被误报为证据读取。
- 用户修改每个可编辑字段后，主进程返回的 `effectiveSummary` 与实际工具参数逐项一致；删除的旧检索词/字段/过滤条件不会在执行中复活，新增范围会真正生效。
- 主进程能证明 trim、clamp、canonical 化和去重：检索词 ≤10、字段 ≤20、过滤器每组 ≤10 且合并后 ≤10、项目/类型 ≤100、limit ∈[1,50]（纯知识文档适配器另受 20 上限约束）；未知字段/项目/类型、非法操作符、不可兼容交付均 fail-closed。
- `sourceMode`、`taskType`、`intent`、问题原文、Agent/权限和工具集合无法由 patch 修改；跨窗口、错误 runId、重复确认和过期确认不执行。
- 取消发生在计划等待阶段时，工具调用数为 0，回答不含 sources/dataViews/产物，且不会覆盖上一轮有效会话范围。
- 完成消息的 `executionSummary`、`dataScope` 和工具参数代表同一实际确认范围；刷新/恢复会话后仍显示该范围。

### 兼容性与质量

- `confirmAgentPlan(runId)` 旧调用继续工作；旧历史消息继续可读；普通 conversation 不出现确认卡。
- `record_query/records`、`knowledge_qa/knowledge`、`mixed_analysis/mixed`、`visualization/records`、`requirement_matching/records` 均遵守交付矩阵；不支持的字段不显示可编辑控件，不能静默忽略。
- 键盘、窄窗口、暗色/亮色主题检查通过；错误、disabled、loading、取消和过期状态可识别。
- 运行 `npm run typecheck`、执行计划确认回归测试（新增或更新）及 `npm run smoke:chat-sessions`；项目管理相关 smoke test 不回归。

## 10. 非目标与后续候选

本期不把“编辑计划”做成自然语言重写器、通用查询编辑器或数据变更确认器。若后续需要编辑分组字段、排序、指标、证据预算、指定记录集合或 Dashboard 组件，应为每类执行器另立 schema、权限和验收，不得复用本期 patch 的隐式扩展。
