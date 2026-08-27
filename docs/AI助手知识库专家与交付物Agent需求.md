# VISSLM AI 助手：知识库专家与交付物 Agent 需求

> 文档状态：待开发 PRD
> 版本：v1.0
> 目标迭代：P3 技能与交付物
> 关联方案：[AI助手产品重构方案](./AI助手产品重构方案.md)

## 1. 背景与目标

当前系统已经有独立的知识库执行 Agent 和受控的 `AssistantArtifact` 预览/提交/撤销能力，但知识库能力尚未作为用户可直接选择的专家暴露；现有交付物主要是本地分析快照、筛选视图和报告草稿，尚未形成可以统一生成文件的交付物 Agent。

本需求补齐两个用户可发现、可审计、可恢复的能力：

1. 提供独立的 `@知识库专家` 用户入口。该入口只对已授权、已索引的文档分块进行检索和归纳，回答必须保留文档来源定位，不能把数据中心记录混入知识库事实。
2. 提供统一的 `@交付物专家`。它只消费上一轮或当前上下文中已经完成证据校验的 `EvidenceBlock`、`ChatDataView` 和 `ChatSource`，将证据转换为 DOCX 报告、XLSX 表格、PPTX 演示文稿或 ZIP 导出包；它不重新检索、不执行业务查询、不写入数据中心或知识库。

产品承诺保持为：

> 先取证，再回答；先验证，再生成。

### 1.1 成功定义

- 用户可以在 AI 助手中看见并选择知识库专家，或直接输入 `@知识库专家`。
- 用户可以通过 `@交付物专家` 和格式意图生成四类文件，且生成前能看到影响预览并明确确认。
- 每个成功文件都能追溯到具体会话、消息、证据块、来源、数据视图和内容哈希。
- 任何证据缺失、权限不满足、格式不支持、生成中断或写盘失败都 fail-closed：不返回确定性产物，不留下可见半成品。
- 不破坏现有通用数据助手、需求分析专家、数据可视化专家、Dashboard artifact 和旧版 `AssistantArtifact` 的兼容行为。

## 2. 范围

### 2.1 本期范围

#### A. 知识库专家

- 在技能注册表中新增用户技能：
  - 稳定 `skillId`：`knowledge-base`
  - 显示名称：知识库专家
  - mention：`@知识库专家`
  - 运行时主 Agent：`knowledge-base`
- 在专家选择器、快捷入口、自动补全和会话运行信息中展示该技能。
- 显式 mention 优先于默认路由；去除 mention 后再把剩余问题交给知识库 Agent。
- 仅允许调用 `search_document_chunks`，并在检索前后强制 `sourceType=document` 隔离。
- 支持单文档问答、跨文档归纳、制度/说明/规范对比和带定位引用的摘要。
- 复用现有执行摘要、计划确认、任务轨迹、证据账本、会话恢复、取消和失败恢复机制。

#### B. 交付物 Agent

- 在技能注册表中新增用户技能：
  - 稳定 `skillId`：`delivery`
  - 显示名称：交付物专家
  - mention：`@交付物专家`
  - 运行时主 Agent：`delivery`
- 支持四种输出格式：
  - `docx`：报告
  - `xlsx`：表格
  - `pptx`：演示文稿
  - `zip`：导出包
- 支持从当前回答的已验证证据生成，也支持从最近一次成功且仍在会话上下文中的证据引用生成。
- 生成前展示格式、内容范围、来源数量、预计文件信息、敏感内容/截断提示和写入影响；用户明确确认后才生成并保存。
- 生成结果具备预览、下载/打开入口、来源清单、哈希、格式、大小、生成时间、会话和消息关联，并能沿用现有交付物记录的撤销语义。
- 生成失败、取消、用户关闭预览或确认过期时清理临时文件和临时状态，不显示为有效交付物。

### 2.2 不在本期范围

- 不改变数据中心记录、项目、知识文档、索引、业务平台或外部服务中的原始数据。
- 不允许交付物 Agent 自主调用记录检索、聚合、知识检索、需求匹配、联网搜索或外部上传工具。
- 不新增任意 SQL、脚本执行、网络抓取或模型生成代码能力。
- 不实现在线协同编辑、电子签名、审批、邮件发送、云盘同步或第三方发布。
- 不把原始上传文档默认打包进 ZIP；本期 ZIP 只包含用户确认范围内的生成文件和来源清单。
- 不替换现有 Dashboard 生成/补丁流程；大屏仍由可视化 Agent 负责。
- 不删除或重解释现有 `analysis_snapshot`、`saved_filter`、`report_draft` 类型；新文件交付物与旧类型兼容共存。

## 3. 角色与职责

| 角色/组件 | 责任 | 明确禁止 |
| --- | --- | --- |
| 普通用户 | 选择专家、提出问题、选择格式、查看预览、确认生成、下载/查看产物、撤销本地记录 | 通过自然语言绕过确认、扩大数据范围或导出无证据内容 |
| Assistant Orchestrator | 解析目标、消解上下文、确定来源和范围、选择 Agent、冻结证据引用、维护运行状态和汇总结果 | 直接访问数据库/索引；把模型猜测当作来源；代替专业 Agent 执行查询 |
| 知识库专家（UI skill） | 为用户提供清晰的文档问答入口，声明文档来源边界 | 承担数据中心记录查询或交付物文件生成 |
| Knowledge Base Agent | 仅检索已授权、已索引的 document chunks，生成带文档定位的证据和回答 | 调用记录工具；读取未授权文档；以未命中的 Top-K 推断文档不存在 |
| Delivery Agent | 校验并转换已验证证据，渲染 DOCX/XLSX/PPTX/ZIP，生成清单和哈希 | 重新检索/聚合/补全事实；写业务数据；绕过预览确认 |
| 数据中心/需求分析/可视化 Agent | 生成可供后续交付的验证结果、`ChatDataView` 或 `EvidenceBlock` | 将未验证模型结果标记为已验证证据 |
| 本地文件与持久化服务 | 临时目录隔离、原子提交、元数据持久化、哈希校验、清理失败中间物 | 将未完成文件登记为有效产物；把路径暴露为可执行输入 |
| 管理员/部署者 | 配置最大文件大小、存储目录、保留周期、模板和脱敏策略 | 默认扩大用户数据权限或关闭来源审计 |

## 4. 术语和产品契约

### 4.1 证据来源

- `EvidenceBlock`：上一轮回答经过程序校验后的固定、来源感知证据块，`kind` 可以是 `record`、`document`、`aggregate` 或 `query_detail`。
- `ChatSource`：具体记录或文档来源，包含可打开的稳定标识；知识库来源必须能定位到文档和 chunk，数据中心来源必须能定位到记录 UID。
- `ChatDataView`：可分页查看的结构化结果；它表达当前查询快照和总数，不等价于模型上下文中的一小段样例。
- `sourceManifest`：交付物实际使用的来源清单，记录证据块、来源、数据视图和范围快照之间的关系。
- `validated evidence`：同时通过范围/权限、引用关系、字段/计数、分页和来源覆盖校验，并来自成功完成任务的证据；失败、取消、澄清中的内容不是有效证据。

### 4.2 建议的新增路由标识

为避免 UI 专家与执行 Agent 混淆，新增契约如下：

| 层级 | 知识库专家 | 交付物专家 |
| --- | --- | --- |
| UI `skillId` / `ExpertId` | `knowledge-base` | `delivery` |
| mention | `@知识库专家` | `@交付物专家` |
| `taskType` | `knowledge_qa` | `artifact` |
| `sourceMode` | `knowledge` | `evidence` |
| `resultMode` | `answer` / `table` | `artifact` |
| 运行时 `executionAgentId` | `knowledge-base` | `delivery` |

`artifact`、`evidence` 和 `delivery` 是本需求新增的扩展值。若实现需要沿用现有内部 `artifact-service` 命名，可以在内部做兼容映射，但对 IPC、任务轨迹、审计和前端展示只能暴露一套稳定 ID，禁止同一能力出现两个可路由的公开技能。

## 5. 主流程

### 5.1 使用 `@知识库专家` 的流程

1. 用户在技能选择器选择“知识库专家”，或输入 `@知识库专家 请说明……`。
2. 路由器识别完整 mention，记录 `reason=explicit-mention`，移除 mention 后保留原问题、会话和范围上下文。
3. Orchestrator 生成 `knowledge_qa/knowledge` 计划，确认指定项目/文档范围、证据预算和结果形式；缺少必要范围时只提出一个具体澄清问题。
4. 用户确认计划后，Knowledge Base Agent 调用唯一允许的 `search_document_chunks`，检索前强制 source filter 为 `document`。
5. Agent 对检索结果做文档/chunk 身份校验、权限校验、证据预算裁剪和引用定位校验。
6. Orchestrator 汇总回答，回答中的制度事实、定义、日期和结论必须绑定 `ChatSource`/`EvidenceBlock`；跨文档结论必须标明每一部分来源。
7. UI 显示文档来源卡片，支持打开文档详情和定位 chunk；空结果、索引不可用和权限不足时显示恢复建议，不输出确定性事实。
8. 会话保存 `assistantIntent`、`taskTrace`、`executionSummary`、`evidenceBlocks` 和来源；后续“整理成报告/表格”可引用该成功消息。

### 5.2 使用 `@交付物专家` 的流程

1. 用户必须主动输入或从专家选择器选择 `@交付物专家`，例如 `@交付物专家 将上一轮结果导出为 xlsx`。普通问答不得自动准备交付物或展示交付物快捷操作。
2. Orchestrator 只从当前消息或最近一次成功消息解析证据引用；失败、取消、澄清消息不能作为来源。
3. 如果没有明确格式，系统不猜测，追问“请选择报告、表格、PPT 或导出包”；如果没有有效证据，提示先完成一轮可验证查询/知识问答。
4. Delivery Agent 在不访问业务数据的前提下校验：证据块存在、来源索引有效、数据视图引用存在、来源类型与格式匹配、会话/消息关系真实、权限未失效、证据快照未过期。
5. Delivery Agent 生成结构化 `DeliveryPlan` 和内容预览，列出标题、文件名、格式、纳入/排除的证据、记录/文档数量、数据行数、页面/幻灯片估算、敏感内容提示和预计大小。
6. UI 展示“导出前影响预览”。预览阶段不写业务数据、不提交有效文件；用户可以取消、返回修改格式或确认。
7. 用户点击“确认导出”后，系统在受控临时目录生成文件，边写边校验大小/类型；全部内容成功生成后计算 SHA-256，执行原子移动，再登记交付物元数据。
8. 生成成功后返回文件预览/下载入口、来源清单和生成摘要；交付物历史可查看、打开或撤销本地记录。
9. 任何步骤失败或被取消时删除临时目录和未提交文件，记录可恢复错误，但不生成 active 产物，也不把失败内容放进有效会话上下文。

### 5.3 多轮和跨 Agent 规则

- “上一轮”“刚才结果”“这些文档”只能解析到会话中明确保存的 `contextRefs` 和成功 `messageId`，不能靠模型猜测。
- 数据中心和知识库混合任务要在 `sourceManifest` 中保留 `record` 与 `document` 两类来源；不能因为输出为一个文件而合并来源身份。
- `grouped_list`、筛选条件、分页总数、范围快照和用户要求的分组必须在文件中保持；不能把“分别列出”压扁为一张无分组表。
- 交付物 Agent 不为缺失字段、缺失记录或未召回文档补发查询；需要补充事实时返回“证据不足”并建议用户回到对应专家。
- 每个交付运行都有独立 `runId`，支持取消；取消后不提交文件、不登记 active 元数据。

## 6. 知识库专家需求

### KB-FR-001 独立入口

技能选择器、快捷卡片、mention 自动补全、专家路由和历史任务展示必须出现“知识库专家”。显示名称固定为“知识库专家”，mention 固定为 `@知识库专家`，不得只显示内部名称“Knowledge Base Agent”。

### KB-FR-002 路由优先级

显式 `@知识库专家` 优先于页面入口、自动任务类型和默认通用数据助手。路由应支持中文标点、空格和末尾 mention；只移除合法完整 token，不误删正文中的相似字符串。显式指定后 `expertId/skillId`、`taskType`、`sourceMode` 和运行轨迹必须一致。

### KB-FR-003 文档来源隔离

Knowledge Base Agent 只允许 `search_document_chunks`。检索请求、召回结果和回答证据都必须满足 `sourceType=document`；记录向量、记录 UID、数据中心字段和 `record` 来源不得混入知识库结果。source filter 失效或来源类型不明时，任务失败关闭。

### KB-FR-004 文档定位引用

每个可核验结论至少引用一个有效文档来源；来源至少包括稳定 `documentId`、`chunkId`、文档名称，并在可用时包含页码、章节、工作表或段落定位。面向用户的引用标签必须显示“文档名 + 页码/工作表/有效位置/正文摘要”，不得显示内部 UID、chunk ID 或“分块 N”。点击引用必须打开原始文件的在线只读预览并定位目标：PDF/转换后的 DOCX 优先跳页、无页码时按引用文字查页；XLSX/XLS 打开对应工作表并高亮目标行；原始 DOCX/TXT 查找并高亮目标文字。源文件不可用、超限或渲染失败时必须给出可读原因并回退到索引正文。引用数量受 UI 展示预算限制，但不能用展示截断掩盖证据覆盖缺口。

### KB-FR-005 证据预算和结果边界

简单问答默认使用 8 条文档证据，跨文档汇总/对比由来源规划器在 4–20 条范围内选择；该预算只限制送入回答模型的证据，不限制候选扫描。超过预算必须明确标记“依据已按预算裁剪”，不得宣称已覆盖全部文档。

### KB-FR-006 索引与空结果

知识库未配置、文档未完成可用索引、权限过滤后无文档、召回不足和检索服务异常分别显示结构化状态及恢复动作。任何一种状态都不得降级为无来源的普通回答。

### KB-FR-007 会话上下文

知识库专家的来源范围、任务轨迹和文档引用随消息持久化；刷新会话后仍能打开同一文档定位。用户追问时只能继承已验证上下文，并在范围发生变化时重新计划和确认。

## 7. 交付物 Agent 需求

### DEL-FR-001 独立入口与格式选择

技能选择器和 mention 自动补全显示“交付物专家”，mention 固定为 `@交付物专家`。格式必须显式指定或由 UI 选择；支持 `docx`、`xlsx`、`pptx`、`zip`。用户同时要求多个独立格式时，系统应询问“分别生成还是打包为 ZIP”，不得无提示地只生成一种。

### DEL-FR-002 只消费已验证证据

Delivery Agent 的唯一业务输入是成功消息上保存的 `EvidenceBlock`、`ChatDataView`、`ChatSource`、`executionSummary` 和来源范围快照。它不得调用 `search_records`、`query_records_by_fields`、`aggregate_records`、`search_document_chunks`、需求匹配、联网或外部数据工具。任何未绑定 EvidenceBlock 的回答文本都不能成为确定性内容依据。

### DEL-FR-003 来源和引用完整性

生成前必须校验：

- `evidenceBlocks` 非空且来自成功任务；
- `sourceIndexes` 不越界，来源 UID/document/chunk 真实存在于同一消息；
- `dataViewId` 能解析到同一消息的 `ChatDataView`；
- `matchedCount`、`returnedCount`、`truncated` 与数据视图一致；
- 记录和文档来源类型不被重写；
- 来源范围、权限、快照时间和会话/消息 ID 可追溯；
- 文件正文、表格、图表、演示文稿中的事实只来自上述已验证输入。

校验失败即停止，不以 `answer` 自由文本补洞。

### DEL-FR-004 计划与预览确认

`DeliveryPlan` 至少包括：

- 目标格式、标题、建议文件名和 MIME type；
- 纳入的证据块 ID、来源 ID、数据视图 ID 和来源类型计数；
- 记录数、文档数、数据行数、字段数、分组/分页/截断提示；
- DOCX 页数估算、XLSX 工作表/行数估算、PPTX 幻灯片估算或 ZIP 成员清单；
- 预计大小、敏感内容/脱敏提示、文件保存位置或下载方式；
- 不会修改业务数据的回滚说明；
- 输入快照哈希和预览有效期。

用户未明确确认前，不创建 active 文件、不写入交付物历史、不把预览文本当作正式交付物。预览数据发生任何变化，原确认失效，必须重新预览。

### DEL-FR-005 生成和原子提交

- 仅在确认后创建隔离临时目录，目录名不可由用户输入直接决定。
- 生成过程中限制单文件/总包大小，检查扩展名与实际 MIME/ZIP 内容一致。
- 单个成员或任一步骤失败时，清理整个临时目录和所有成员，不保留部分 ZIP 或半生成 Office 文件。
- 计算最终文件 SHA-256 后再原子移动并登记元数据；哈希失败或移动失败不得登记成功产物。
- 写入仅作用于本地受控交付物存储，不修改数据中心、知识库、项目或业务平台。

### DEL-FR-006 交付物历史和撤销

历史记录必须区分 `preview`、`active`、`failed`、`cancelled`、`reverted` 状态；失败/取消记录可以用于诊断但不能出现在“可下载”列表。沿用现有 `AssistantArtifact` 的版本和撤销语义时，旧类型继续可读，新文件类型需补充文件元数据和来源清单。

### DEL-FR-007 任务状态与取消

UI 至少展示 `route → validate-evidence → preview → waiting-confirmation → generate → hash → commit → completed`；取消和错误必须标识发生阶段。取消发生在生成、哈希或提交期间时，清理临时物，且不进入下一轮有效上下文。

## 8. 四种文件格式行为

### 8.1 DOCX 报告（`docx`）

默认结构：标题页/标题、执行摘要、口径与范围、主要结论、证据/来源引用、明细表或分组结果、限制与附录。报告中的数字、日期、名称和制度结论必须能回链到来源清单；无证据的模型建议只能作为明确标注的“待核实建议”，不得伪装为事实。

默认行为：

- 记录类来源以表格和分页/截断提示呈现；文档类来源以引用卡和定位信息呈现。
- HTML/Markdown/文档文本作为不可信内容处理，清洗危险标签、脚本、外链图片和不可执行内容后再写入。
- 不自动嵌入远程图片、不执行宏、不写入外部链接；图片缺失时显示可读的占位说明。
- 在文末附“来源清单”和生成时间、会话/消息 ID、内容哈希。

### 8.2 XLSX 表格（`xlsx`）

默认工作簿包含：`说明`、`汇总`、`数据`（或按用户要求的分组数据页）、`来源清单`。保留字段标签、筛选条件、分组、排序、总数与截断状态；分页数据不能被误称为全量数据。

默认行为：

- 单元格写入值而非未经验证的公式；文本以 `=`, `+`, `-`, `@` 开头时按文本转义，防止公式注入。
- 不生成宏、外部连接、可执行链接或隐藏工作表；工作表名、文件名和单元格文本清洗控制字符。
- 首行冻结、启用筛选、列宽适中；超出行数限制时在说明页显示限制和来源快照。
- 文档来源不凭空转换为结构化记录；可在“来源清单”以文档/chunk 维度列出。

### 8.3 PPTX 演示文稿（`pptx`）

默认结构：封面、执行摘要、关键指标/结论、分组或趋势图表、证据与限制、来源清单。图表只能使用 `ChatDataView` 或聚合 EvidenceBlock 的已验证字段；模型不得发明轴值、比例、趋势或比较基准。

默认行为：

- 每页保留来源脚注或来源编号，末页给出完整来源清单。
- 依据不足时生成“证据不足”说明页或停止生成，不绘制看似确定的图表。
- 不嵌入远程资源，不包含宏或外部可执行链接；文本超长时使用截断提示并将完整内容放入附录/备注或改为报告格式。
- 维持应用既有深色/亮色主题的可读性，但模板颜色不能改变事实状态含义。

### 8.4 ZIP 导出包（`zip`）

默认包含：用户确认的一个或多个已生成文件、`manifest.json`（来源/哈希/大小/时间/关联关系）和 `README.txt`（导出说明及截断/权限提示）。默认不包含原始文档、原始数据库或应用凭据。

默认行为：

- ZIP 成员路径只能是受控的相对路径，禁止 `..`、绝对路径、符号链接和路径穿越。
- 先完成所有成员生成与校验，再一次性生成 ZIP；任一成员失败则整个导出包失败并清理。
- 清单中记录每个成员的 SHA-256、MIME、大小、生成时间和证据关联；ZIP 自身另计 SHA-256。
- 若用户要求导出原始文档/原始记录，必须转回来源专家并经过单独权限和影响确认，本期不自动满足。

## 9. 数据契约

以下为实现必须遵循的逻辑契约；字段命名可以按现有 TypeScript 风格映射，但含义、必填性和校验不可弱化。

### 9.1 `KnowledgeExpertRoute`

```ts
interface KnowledgeExpertRoute {
  skillId: 'knowledge-base'
  mention: '@知识库专家'
  taskType: 'knowledge_qa'
  sourceMode: 'knowledge'
  executionAgentId: 'knowledge-base'
  question: string
}
```

### 9.2 交付物输入 `DeliveryRequest`

```ts
type DeliveryFormat = 'docx' | 'xlsx' | 'pptx' | 'zip'

interface DeliveryRequest {
  runId: string
  conversationId: string
  messageId: string
  format: DeliveryFormat
  title: string
  question: string
  evidenceBlockIds: string[]
  dataViewIds: string[]
  sourceIds: string[]
  options?: {
    templateId?: string
    includeAppendix?: boolean
    includeSourceManifest?: boolean
    groupBy?: string
    packageMembers?: DeliveryFormat[]
  }
  inputSnapshotHash: string
}
```

约束：`conversationId`、`messageId`、`runId`、`format`、标题和至少一个 `evidenceBlockId` 必填；`evidenceBlockIds/dataViewIds/sourceIds` 必须来自同一成功消息或被明确解析的成功上下文。`packageMembers` 仅在 `format=zip` 时允许，成员格式不能再次包含 `zip`。

### 9.3 来源清单 `DeliverySourceManifest`

```ts
interface DeliverySourceManifest {
  evidenceBlocks: Array<{
    id: string
    kind: 'record' | 'document' | 'aggregate' | 'query_detail'
    count: number
    matchedCount?: number
    returnedCount?: number
    truncated?: boolean
  }>
  sources: Array<{
    id: string
    sourceType: 'record' | 'document'
    uid?: string
    documentId?: string
    chunkId?: string
    title: string
    locator?: string
  }>
  dataViews: Array<{
    id: string
    title: string
    total: number
    loadedRows?: number
    snapshotAt?: string
  }>
  scope?: {
    projectIds: string[]
    nodeTypes: string[]
    snapshotAt?: string
  }
}
```

### 9.4 预览 `DeliveryPreview`

```ts
interface DeliveryPreview {
  previewId: string
  runId: string
  format: DeliveryFormat
  title: string
  fileName: string
  mimeType: string
  estimatedSizeBytes?: number
  contentPreview: string
  impact: {
    recordCount: number
    documentCount: number
    matchedCount: number
    returnedCount: number
    truncated: boolean
    packageMemberCount?: number
    sourceWriteCount: 0
    businessDataWriteCount: 0
  }
  sourceManifest: DeliverySourceManifest
  inputSnapshotHash: string
  payloadHash: string
  expiresAt: string
  rollbackPoint: string
}
```

`payloadHash` 对规范化后的请求、证据块、数据视图和来源清单计算；预览确认时必须重新核对该哈希。预览过期、输入哈希变化或来源引用变化时拒绝提交。

### 9.5 成功产物 `DeliveryArtifact`

```ts
interface DeliveryArtifact {
  id: string
  version: number
  status: 'active' | 'reverted'
  format: DeliveryFormat
  title: string
  fileName: string
  mimeType: string
  storageKey: string
  sizeBytes: number
  sha256: string
  sourceManifest: DeliverySourceManifest
  conversationId: string
  messageId: string
  runId: string
  createdAt: string
  generatedAt: string
  updatedAt: string
}
```

必须持久化：来源清单、文件哈希、格式、MIME、大小、生成时间、关联会话/消息、运行 ID、版本和状态。文件内容与元数据提交必须可验证地关联；只有两者都成功才显示 `active`。

### 9.6 运行轨迹扩展

知识库任务沿用 `AssistantTaskTrace`，且 `primaryAgent=knowledge-base`、`taskType=knowledge_qa`、`sourceMode=knowledge`。交付任务需支持 `primaryAgent=delivery`，`taskType=artifact`、`sourceMode=evidence`、`resultMode=artifact`，并记录实际参与 Agent 只能为 `delivery`；上游证据任务的 Agent 不应被虚报为本轮重新调用。

## 10. 权限、安全与审计

### 10.1 权限边界

- 知识库检索沿用现有用户/项目/文档授权过滤，权限过滤必须先于召回、统计和模型调用。
- 交付物只能使用已经对当前用户可见并在消息中成功落账的证据；生成时不得通过文件服务重新读取更宽范围的数据。
- 文件输出权限是“本地交付物写入”而非“业务数据写入”；任何数据中心、知识库、索引或外部平台写入均为禁止行为。
- 用户可查看的历史产物应再次校验会话/用户归属；不能通过猜测 `id` 读取其他会话的文件或来源清单。

### 10.2 文件和内容安全

- 所有用户标题、文件名、来源文本和文档 HTML 都是不可信输入；进行控制字符、路径、危险标签和外链清洗。
- DOCX/PPTX 不执行宏或远程资源；XLSX 禁止公式注入、宏和外部连接。
- ZIP 防止路径穿越、符号链接、重复危险成员、压缩炸弹和未受控总大小。
- 临时目录权限仅限当前应用用户；文件名不包含访问令牌、数据库路径或原始敏感参数。
- 日志不记录完整文档正文、完整记录 JSON、密钥或文件内容；只记录运行 ID、错误码、计数、哈希和必要诊断。
- 默认保留来源清单和哈希，不默认复制或永久保存原始来源副本。

### 10.3 审计

每次知识库查询和交付生成至少审计：用户/会话、`runId`、技能、任务类型、来源模式、实际 Agent、范围快照、证据数量、输出格式、确认时间、生成时间、状态、错误码、文件大小和 SHA-256。审计应能回答“谁在什么范围、基于哪些证据、何时生成了什么文件”。

## 11. 边界条件与错误恢复

| 错误码/状态 | 触发条件 | 用户可见行为 | 恢复动作 |
| --- | --- | --- | --- |
| `KB_NOT_READY` | 知识库服务未配置或索引未完成 | 明确显示知识库未就绪，不输出答案 | 配置服务、上传/索引文档、刷新状态 |
| `KB_NO_EVIDENCE` | 权限过滤后无命中或证据不足 | 显示“没有足够文档依据” | 调整关键词、扩大授权范围或指定文档 |
| `KB_SOURCE_MIXED` | 召回或来源出现记录类型 | 任务 fail-closed | 重建索引/修复适配器，不降级回答 |
| `EVIDENCE_MISSING` | 交付请求无有效 EvidenceBlock | 不展示导出确认 | 回到上一轮成功回答或重新取证 |
| `EVIDENCE_STALE` | 预览哈希、范围快照或来源引用发生变化 | 预览失效 | 重新生成预览；必要时回原专家重新取证 |
| `FORMAT_UNSUPPORTED` | 格式缺失或不在四类范围 | 不生成文件 | 选择 DOCX/XLSX/PPTX/ZIP |
| `FORMAT_INPUT_INSUFFICIENT` | 数据无法支撑所选格式，如 PPTX 无可视化字段 | 不生成确定性文件 | 改选报告/表格或补充有证据的结构化结果 |
| `EXPORT_LIMIT_EXCEEDED` | 行数、页数、文件大小或时间超限 | 显示实际限制和已处理范围 | 缩小范围、分页、改格式或分包 |
| `EXPORT_TEMPLATE_INVALID` | 模板缺失、损坏或不兼容 | 不留下半成品 | 使用默认模板或重新配置模板 |
| `EXPORT_WRITE_FAILED` | 磁盘满、权限不足、原子移动失败 | 清理临时物并显示失败阶段 | 选择可写目录、释放空间后重试 |
| `EXPORT_CANCELLED` | 用户停止任务或窗口取消 | 标记 cancelled，不显示为 active | 重新确认后重试 |
| `EXPORT_HASH_FAILED` | 最终文件哈希无法计算或不一致 | 不登记产物 | 重试；持续失败转诊断 |
| `PERMISSION_REVOKED` | 生成/查看时用户已失去来源或产物权限 | 拒绝继续并不泄露内容 | 重新取得授权后从专家任务开始 |

通用要求：错误响应必须包含稳定错误码、简短原因、发生阶段和可执行恢复动作；不能把错误拼成普通模型回答，也不能把失败内容带入下一轮有效上下文。

## 12. 默认值与产品假设

以下默认值用于保证开发不被未决细节阻塞；管理员配置或后续产品决策可以调整，但必须进入版本化配置并在预览中显示实际值。

| 项目 | 默认值/假设 |
| --- | --- |
| 简单知识问答证据预算 | 8 个 document chunks |
| 跨文档问答证据预算 | 4–20 个 chunks，由来源规划器选择 |
| 单个 DOCX/XLSX/PPTX 最大大小 | 50 MiB |
| ZIP 最大大小 | 200 MiB |
| 单个 XLSX 工作表最大数据行 | 100,000 行（含表头前的业务行按实现约定计数，并在预览标明） |
| PPTX 最大幻灯片数 | 100 页；超过则建议报告或分包 |
| DOCX 最大建议页数 | 200 页；超过则在预览提示分拆 |
| 单次生成最长时间 | 120 秒；超时按 `EXPORT_LIMIT_EXCEEDED` 清理并可重试 |
| 预览有效期 | 10 分钟；过期必须重新预览 |
| ZIP 默认内容 | 生成文件 + `manifest.json` + `README.txt`，不包含原始来源 |
| 文件保存位置 | 应用管理的本地交付物目录；不允许用户输入路径直接作为写入目标 |
| 产物保留 | 默认保留 30 天或直到用户撤销；具体清理策略须保留审计元数据 |
| 多格式请求 | 默认询问分别生成还是打包为 ZIP，不静默选择 |
| 脱敏策略 | 复用上游授权/脱敏策略；本期不新增敏感字段分类模型 |

## 13. 验收标准

### 13.1 知识库专家验收

- **KB-AC-01**：专家选择器和 mention 补全出现“知识库专家”，`@知识库专家` 能正确路由并从问题中移除 mention。
- **KB-AC-02**：显式知识库 mention 不会路由到通用数据助手、需求分析专家或数据中心 Agent；任务轨迹中的技能、任务类型、来源模式和主 Agent 一致。
- **KB-AC-03**：知识库 Agent 的工具白名单只有 `search_document_chunks`；调用记录查询工具、混合来源或未注册工具会在访问数据前失败。
- **KB-AC-04**：检索结果全部是 `sourceType=document`；记录 UID、文档 UID 和 chunk 编号不会作为知识库来源显示。点击引用可打开 PDF、DOCX、XLSX/XLS、TXT 原始文件的在线预览，并按页、工作表/行或引用文字定位；失败时显示原因并回退索引正文。
- **KB-AC-05**：未配置、索引中、索引失败、无命中、证据不足和权限拒绝均显示不同的可恢复状态，不生成无依据结论。
- **KB-AC-06**：跨文档回答保留文档来源身份和证据预算提示；刷新/恢复会话后来源仍可打开。
- **KB-AC-07**：知识库问答执行前遵循现有计划确认，取消/失败后不写入有效回答上下文。

### 13.2 交付物 Agent 验收

- **DEL-AC-01**：专家选择器和 mention 补全出现“交付物专家”，`@交付物专家` 能选择四种格式或提出格式澄清。
- **DEL-AC-02**：只给已有成功消息的 `EvidenceBlock/dataViews/sources` 时可生成预览；无证据、失败消息、越权引用、过期哈希均被拒绝。
- **DEL-AC-03**：生成前预览显示格式、影响范围、来源统计、截断/敏感提示、预计大小、清单和回滚说明；未确认不写 active 产物。
- **DEL-AC-04**：确认后分别成功生成可打开的 DOCX、XLSX、PPTX 和 ZIP；文件扩展名、MIME、结构和内容与预览一致。
- **DEL-AC-05**：DOCX 报告包含摘要、口径、证据引用和来源清单；XLSX 包含说明/汇总/数据/来源清单且无公式注入；PPTX 包含结论、证据脚注、限制和来源清单；ZIP 包含确认成员及 `manifest.json`/`README.txt`，无路径穿越。
- **DEL-AC-06**：生成过程完全不调用记录检索、聚合、知识检索、需求匹配或外部写工具；交付物不能改变业务数据和知识库。
- **DEL-AC-07**：成功记录包含来源清单、SHA-256、格式、MIME、大小、生成时间、会话 ID、消息 ID、运行 ID和版本；历史可查看且撤销后不可下载为 active。
- **DEL-AC-08**：任一成员/模板/写盘/哈希/取消/超时失败都会清理临时目录，不留下可见半成品或 active 元数据。
- **DEL-AC-09**：大数据量、分页、分组和截断信息在预览及文件中保持真实口径；不会把当前页说成全量。
- **DEL-AC-10**：多格式请求会明确询问“分别生成还是打包为 ZIP”；ZIP 内成员与用户确认一致。

### 13.3 回归和非功能验收

- **NFR-AC-01**：现有三个用户专家、数据中心/知识库/混合路由、需求匹配和可视化 Dashboard 流程回归通过。
- **NFR-AC-02**：旧版 `analysis_snapshot`、`saved_filter`、`report_draft` 交付物仍可读取、预览和撤销；历史数据库迁移不丢失记录。
- **NFR-AC-03**：任务取消、计划确认、失败恢复、会话刷新和 `runId` 隔离回归通过；旧运行事件不会污染当前生成任务。
- **NFR-AC-04**：暗色/亮色主题下，知识库入口、预览弹窗、历史抽屉和错误状态遵循现有主题变量、内部滚动和可访问焦点规范。
- **NFR-AC-05**：运行 TypeScript 检查、聊天会话/Agent/RAG/项目管理 smoke test，并增加知识库路由、来源隔离、交付预览、四格式生成、清理和元数据哈希测试。

## 14. 依赖与实施顺序

### 14.1 依赖

1. `ExpertRouter`/专家注册表及 `ExpertId`、`AssistantIntentDecision` 的扩展。
2. `assistantExecutionAgentRegistry`、任务/来源组合校验和 `AssistantTaskTrace` 的扩展。
3. 已存在的 `KnowledgeBaseAgent`、`search_document_chunks` 和文档来源过滤边界。
4. 已存在的 `EvidenceBlock`、`ChatSource`、`ChatDataView`、`contextRefs` 和会话持久化。
5. 已存在的 `AssistantArtifact` 预览、提交、列表和撤销 IPC；需要向后兼容地补充文件型元数据，或增加独立 `DeliveryArtifact` 表/服务。
6. Electron preload/IPC、受控本地存储、临时目录和清理服务。
7. 能安全渲染 DOCX/XLSX/PPTX/ZIP 的本地库与字体/模板资源；具体库选型由实现方案决定，但必须满足本 PRD 的文件安全和验证要求。
8. 现有取消、事件流、模型能力诊断和工作区就绪状态，作为 UI 状态和错误恢复基础。

### 14.2 建议实施顺序

1. 扩展共享类型、注册表、路由、任务轨迹和白名单；先完成知识库专家入口及来源隔离。
2. 完成知识库 UI、计划确认、文档引用和失败状态，补回归测试。
3. 设计 `DeliveryRequest/Preview/Artifact/SourceManifest` 和数据库迁移，先实现证据引用校验与预览，不接文件写入。
4. 接入受控临时目录、原子提交、哈希和历史记录，再按 DOCX、XLSX、PPTX、ZIP 顺序接入格式渲染器。
5. 完成导出取消/失败清理、安全测试、跨主题 UI 验收和全量回归。

## 15. 开放问题（不阻塞开发的默认决策）

| 问题 | 默认决策 | 需要确认的时点 |
| --- | --- | --- |
| 交付物是否存入现有 `assistant_artifacts` 表 | 优先复用表并做向后兼容迁移；若文件元数据过多，新增子表并以 artifact ID 关联 | 数据库设计评审 |
| 用户如何取得文件 | 本地交付物目录 + UI 下载/打开入口；不自动上传外部服务 | UI/发布评审 |
| 是否允许自定义模板 | MVP 使用内置安全模板，模板 ID 可预留；管理员配置模板需版本化 | 模板资源评审 |
| 是否导出原始来源 | 默认不导出；若未来开放，新增权限和二次影响确认 | 安全评审 |
| 产物是否自动清理 | 默认 30 天后清理文件但保留最小审计元数据；撤销只改变可用状态 | 数据保留评审 |
| 是否支持一个请求同时生成多个独立文件 | MVP 通过 ZIP 统一打包；多个独立文件需用户再次选择/确认 | 交付体验评审 |
| 是否需要在线预览 Office 文件 | 已实现知识库原始文件在线只读预览；支持 PDF、DOCX、XLSX/XLS、TXT 及引用位置跳转，源文件不可用时回退索引正文 | 已确认 |
| 生成任务是否允许后台继续 | MVP 仅当前窗口可恢复，关闭窗口按取消处理；后台任务另立需求 | 任务中心规划 |

## 16. 与现有产品重构方案的对齐说明

本 PRD 是对 `docs/AI助手产品重构方案.md` 中“知识库 Agent”“交付物 Agent”和 P3“技能与交付物”路线的落地细化，不改变其核心约束：

- 继续使用“分类 → 来源与范围确认 → 受约束计划 → 工具执行 → 证据账本 → 程序校验 → 回答或交付物”的执行链。
- 知识库问答只使用已索引文档分块；混合任务仍由数据中心 Agent 与知识库 Agent 分别执行并保留来源身份。
- 交付物 Agent 只消费上游证据账本，不能成为万能查询 Agent；生成属于本地受控写入，必须先预览和明确确认。
- 继续使用任务轨迹、失败关闭、取消、来源引用、分页/截断和会话上下文边界。
- 现有三个 UI 专家和现有旧版交付物类型保持兼容；新增两个入口是能力扩展，不是删除或重命名旧入口。

若实现与本 PRD冲突，应优先保留来源隔离、只读业务数据、预览确认、哈希审计和失败清理等安全不变量，并在变更记录中说明兼容映射。
