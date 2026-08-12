# 02 项目需求文档（按当前实现整理）

> 最后分析时间：2026-08-01  
> 代码基线：Git `9bab57fc5166770784c1855857a6e1a8ebaa6200`；分析对象为当前工作树。  
> 需求来源：当前代码、共享类型、数据库迁移、README 和 smoke 脚本；不是尚未实现的产品愿景。  
> 相关文档：`docs/00-project-scan.md`、`docs/01-code-mapping.md`、`docs/03-system-architecture.md`、`docs/04-module-design.md`。

## 1. 项目背景与建设目标

### 1.1 背景

VISSLM Agent 将 VISSLM 平台数据复制到本地，提供本地检索、文档知识化、AI 问答和可视化分析，并在需要时把处理结果写回平台。项目同时把技术协议识别为项目需求，并将需求与本地采集记录做语义匹配。

直接证据：`README.md` 功能概览；`src/main/visslm.ts` 的查询/推送客户端；`src/main/knowledge.ts` 的文档和向量索引；`src/main/project-management.ts` 的协议解析、需求审核和匹配。

### 1.2 建设目标

| 目标 | 当前实现 |
|---|---|
| 本地化数据工作台 | SQLite 保存记录、原始 JSON、附件、日志和配置 |
| 可控的数据采集 | 节点类型、字段过滤、请求预览、同步结果和请求日志 |
| 可复用的知识资产 | 支持 DOCX/PDF/XLSX/XLS/TXT，分块、embedding、向量检索 |
| 基于证据的 AI 助手 | 通过工具读本地数据/知识库，不让模型直接执行 SQL |
| 可追溯数据大屏 | QuerySpec、字段画像、版本保存、质量诊断、导出和审计 |
| 项目需求闭环 | 技术协议 -> 需求草稿 -> 人工审核/发布 -> 数据匹配 -> 状态标记/资产关联 |
| 受控平台回写 | 字段映射、请求预览、逐条推送、日志和记录推送状态 |

### 1.3 当前实现边界

系统是 Windows Electron 本地应用，不是多租户 SaaS。没有发现登录、组织权限、HTTP 服务端、消息队列、Redis、云对象存储或服务器端定时任务。本项目已确认按单机单用户范围建设，不实现 RBAC、登录和组织级授权；集中审计、后台持续执行和跨设备协作仍属于范围外/后续议题。

## 2. 用户角色

代码实际没有用户、角色或权限实体。下表只是业务使用场景角色，不是登录角色、权限配置或 RBAC 实现。

| 角色编号 | 角色 | 依据/状态 |
|---|---|---|
| ROLE-001 | 本机工作台操作人 | 唯一可确认的运行主体：Electron 单用户进程，所有 IPC handler 无身份校验 |
| ROLE-002 | 数据采集/资产管理员 | 推测：使用 `SyncPage`、`AssetCenterPage` 和数据导入导出；代码未单独限制 |
| ROLE-003 | 项目经理/需求审核人 | 推测：使用项目、协议、需求审核、状态标记和成本计划；代码未单独限制 |
| ROLE-004 | 分析/AI 用户 | 推测：使用 AI 助手、字段画像和 Dashboard；代码未单独限制 |
| ROLE-005 | 平台集成管理员 | 推测：配置平台凭据和执行推送；代码未单独限制 |

权限边界已确认：当前本机操作人可以调用已注册 IPC；不做正式角色、权限点和数据范围隔离。日志是否需要补充本机操作者标识和保留期限，属于独立的审计问题。

## 3. 使用场景

| 场景编号 | 场景 | 主流程 |
|---|---|---|
| UC-001 | 首次配置并采集 | 配置平台与模型 -> 测试连接 -> 选择采集范围 -> 预览 -> 保存并同步 |
| UC-002 | 查询本地资产 | 资产中心筛选记录 -> 查看描述/图片/原始字段 -> 导入/导出/删除 |
| UC-003 | 建立知识库 | 上传文档 -> 解析/OCR -> 分块/向量 -> 检索或查看来源 |
| UC-004 | 数据问答 | 在 AI 助手提问 -> 规划/调用证据工具 -> 返回答案、来源和数据视图 |
| UC-005 | 生成可视化大屏 | 选数据范围或 @可视化专家 -> 字段画像 -> QuerySpec -> DashboardSpec -> 编辑/保存/导出 |
| UC-006 | 从技术协议建立项目 | 上传协议 -> 建立知识索引 -> AI 提取项目和需求 -> 需求审核 -> 发布 -> 匹配记录 |
| UC-007 | 管理项目交付 | 查看成本、参与人、计划和项目资产 -> 编辑/关联/解除关联 |
| UC-008 | 推送本地记录 | 选择记录 -> 设置目标节点和字段映射 -> 预览请求 -> 逐条推送 -> 查看日志/状态 |
| UC-009 | 恢复中断任务 | 应用重启时将 processing 项目标记为 failed -> 用户重试协议分析或匹配 |

## 4. 系统边界

### 4.1 系统内

- 本地窗口、导航和功能开关；
- VISSLM 数据同步、记录搜索、附件缓存和本地导入导出；
- 文档解析、OCR、embedding、知识库检索；
- 本地字段画像、QuerySpec 查询、Dashboard 版本、诊断、导出、审计；
- AI 问答和可视化专家编排；
- 项目、需求、匹配、成本、人员、计划和项目资产；
- 平台推送和操作日志。

### 4.2 系统外

- VISSLM/ALM 外部 API；
- Ollama 或在线大模型服务；
- Hugging Face/OCR 资源下载（资源准备阶段）；
- Windows 文件系统和用户安全存储；
- Electron CDP 仅用于测试，不是业务能力。

## 5. 功能清单

| 模块 | 功能编号范围 | 实现入口 |
|---|---|---|
| 窗口与工作台 | FR-WIN-001 ~ FR-WIN-004 | `main/index.ts`、`App.tsx` |
| 平台配置/系统设置 | FR-CONFIG-001 ~ FR-CONFIG-006 | `settings.ts`、`App.tsx:3371` |
| 数据采集 | FR-SYNC-001 ~ FR-SYNC-009 | `visslm.ts`、`App.tsx:2056` |
| 资产中心 | FR-DATA-001 ~ FR-DATA-009 | `database.ts`、`App.tsx:469,3856` |
| 知识库 | FR-KB-001 ~ FR-KB-010 | `knowledge.ts`、`App.tsx:846` |
| AI 助手 | FR-AI-001 ~ FR-AI-009 | `ollama.ts`、`experts/requirement-analysis-agent.ts`、`App.tsx:1138` |
| 本地分析查询 | FR-ANALYTICS-001 ~ FR-ANALYTICS-006 | `query-engine.ts`、`query-spec.ts` |
| 可视化大屏 | FR-VIZ-001 ~ FR-VIZ-011 | `DashboardStudio.tsx`、`index.ts` |
| 项目管理 | FR-PM-001 ~ FR-PM-023 | `project-management.ts`、`project-export.ts`、`ProjectManagementPage.tsx` |
| 数据推送 | FR-PUSH-001 ~ FR-PUSH-006 | `visslm.ts`、`App.tsx:2800` |

## 6. 详细功能需求

### 6.1 窗口与工作台

#### FR-WIN-001 窗口生命周期

- 前置条件：Electron 主进程启动。
- 输入：窗口控制动作。
- 主流程：创建无边框窗口，最小尺寸 1120x700；启动后在 `ready-to-show` 显示；关闭时关闭数据库。
- 输出：窗口状态和最大化事件。
- 异常：未创建窗口时最大化返回 false；单实例锁失败时退出。
- 代码依据：`src/main/index.ts:68-105,123-130,848-902`。

#### FR-WIN-002 功能导航

- 顶部导航显示数据概览、可视化大屏、项目管理、资产中心、AI 助手、数据采集、数据推送和系统配置。
- 导航顺序可由 `navigation.order` 调整，禁用功能不出现在主菜单；系统配置始终显示。
- 依据：`App.tsx:110-230,3924-3960`、`SettingsService.getNavigationOrder`。

#### FR-WIN-003 主题与响应式工作区

- 当前主题由 Ant Design darkAlgorithm 和 `main.tsx` token 组成；表格多数配置响应式 `scroll.y` 和列宽保存。
- 后续 UI 必须遵守根目录 `agents.md` 的 VISSLM 工作台 v1 约束，尤其是主题变量、表格内部纵向滚动、列宽持久化和详情弹层上下文。

#### FR-WIN-004 模型在线状态

- AppShell 加载 settings 后调用 `testModel`，侧栏展示检测中/可用/不可用。
- 依据：`App.tsx:3900-3960`。

### 6.2 系统配置

#### FR-CONFIG-001 平台连接配置

- 输入：平台地址、用户名、可选 Token。
- 规则：地址去除尾部 `/`；没有新 Token 时保留原密文；UI 返回 `hasToken`，不返回 Token。
- 输出：更新后的 `AppSettings` 或连接结果。
- 异常：缺少必要凭据时 `VisslmClient` 返回失败。
- 依据：`settings.ts:45-95`、`visslm.ts:148-154`。

#### FR-CONFIG-002 模型配置

- 支持本地 `ollama` 和在线 `openai/anthropic/deepseek/qwen/zhipu/moonshot/minimax/openai-compatible`。
- 输入：来源、服务商、地址、模型、thinking、在线 API Key。
- 规则：本地不发送 API Key；在线 Key 按提供商保存；UI 只返回 `hasApiKey`。
- 依据：`shared/types.ts:66-89`、`settings.ts:96-158`、`model-client.ts`。

#### FR-CONFIG-003 连接测试

- 平台测试调用 VISSLM API；本地模型检查 `/api/tags`；在线模型检查 `/models`。
- 结果：`ConnectionResult { ok, message, details? }`。
- 依据：`main/index.ts:146-154`、`model-client.ts:23-76`。

#### FR-CONFIG-004 功能开关

- 支持 `dashboard/visualization/projects/data/chat/sync/push` 七项开关；默认推送关闭。
- 规则：开关只改变导航可见性，不提供安全授权。
- 依据：`shared/types.ts:89-120`、`settings.ts:66-75`、`App.tsx:3924-3940`。

#### FR-CONFIG-005 导航排序

- 输入 FeatureNavigationOrder。
- 规则：去重、过滤未知键、补齐缺失项；版本不是 1 或 JSON 损坏时回退默认。
- 依据：`settings.ts:20-43,116-138`。

#### FR-CONFIG-006 采集范围配置

- 输入选择的节点类型和每类节点的字段过滤规则。
- 规则：保存 JSON 时带版本 2；未保存配置不能预览。
- 依据：`settings.ts:160-201`、`shared/types.ts:336-383`。

### 6.3 数据采集

#### FR-SYNC-001 配置采集类型

- 用户选择节点类型，按 `SyncTypeRule` 配置返回字段和 `SyncFieldFilter`。
- 支持 equals/notEquals/contains/notContains/empty/notEmpty/大小比较。
- 依据：`shared/types.ts:336-365`、`App.tsx:2056-2520`。

#### FR-SYNC-002 预览采集范围

- 前置条件：存在保存或传入的配置及有效平台凭据。
- 主流程：调用平台查询，返回扫描数、匹配数、按类型统计、样例和请求 trace；不写入同步运行日志。
- 依据：`main/index.ts:165-169`、`VisslmClient.previewScope`。

#### FR-SYNC-003 执行递归同步

- `SyncService.run` 按配置查询项目/节点，保存项目和记录，下载附件，保留本次 UID，其余记录按同步策略清理。
- 进度：通过 `sync:progress` 回传阶段、消息、当前数、总数。
- 输出：项目数、记录数、图片数和消息。
- 依据：`visslm.ts:673-878`、`main/index.ts:170-178`。

#### FR-SYNC-004 请求日志

- 每次节点 HTTP 请求写 `collection_request_logs`，记录方法、endpoint、参数、HTTP 状态、记录数、响应片段、错误和完成时间。
- 页面支持分页查看。
- 依据：`visslm.ts:713-742`、`database.ts:4445-4493`。

#### FR-SYNC-005 附件缓存

- 通过外部附件接口下载图片；按 SHA-256 去重保存 Base64 文件；`images` 保存元数据。
- 依据：`visslm.ts:260-337,452-509,852-878`、`database.ts:516-531,4152-4213`。

#### FR-SYNC-006 同步后索引和匹配失效

- 同步成功后同步记录知识索引并将项目匹配标记为 stale。
- 依据：`main/index.ts:170-178`。

#### FR-SYNC-007 同步运行状态

- `sync_runs` 保存开始、结束、状态、项目数、记录数、图片数和错误消息。
- 依据：`database.ts:533-542,4936-4981`。

#### FR-SYNC-008 同步前置与异常

- 缺少配置、平台凭据、外部 HTTP 失败或附件失败时返回/记录错误；单个请求日志应保留失败原因。
- 具体恢复策略依赖 `SyncService.run` 当前实现，需用 smoke 继续验证部分失败行为。

#### FR-SYNC-009 数据导入导出

- 导入支持 JSON 数组和 JSONL，文件上限 512 MB；单行 JSON 错误会被跳过并报告最多 50 条错误。
- 导出生成 JSONL，由用户选择路径。
- 依据：`main/index.ts:517-615`。

### 6.4 资产中心

#### FR-DATA-001 资产列表

- 支持分页、关键词、项目和节点类型筛选，显示名称、类型、编号、更新时间、图片数和推送状态。
- 依据：`App.tsx:469-832`、`database.ts:4276-4300`。

#### FR-DATA-002 全文检索

- `records_fts` 使用 FTS5；优先 trigram tokenizer，失败时回退默认 tokenizer；触发器维护增删改索引。
- 依据：`database.ts:996-1036`。

#### FR-DATA-003 记录详情

- 返回原始 JSON、规范化描述和附件图片 data URI；描述经 `RichDescription` 清洗后渲染。
- 依据：`App.tsx:526-529,RichDescription.tsx:1-77`、`database.ts:4301-4324`。

#### FR-DATA-004 统计

- 提供项目数、记录数、采集数、已推送数、图片数以及按类型/项目/发布版本构成数据。
- 依据：`shared/types.ts:299-308`、`database.ts:4592-4644`。

#### FR-DATA-005 本地删除

- 支持按 UID 或全量删除；返回删除记录数和图片数；随后同步知识索引并使项目匹配 stale。
- 依据：`main/index.ts:617-621`、`database.ts:5140-5179`。

#### FR-DATA-006 数据交换

- 支持 JSON/JSONL 导入和 JSONL 导出，具体见 FR-SYNC-009。

#### FR-DATA-007 列宽和滚动

- 资产中心使用 `ResizableTable`，列宽在 localStorage 按 `v1` 缓存，支持拖拽和左右键调整，表格有响应式 `scroll.y`。
- 依据：`ResizableTable.tsx:1-301`、`App.tsx:703-831`。

#### FR-DATA-008 原始数据安全展示

- 低频原始 JSON 在详情区域展示；敏感数据脱敏和导出访问控制未实现，需确认。

#### FR-DATA-009 业务规则

- 记录 UID 是本地唯一主键；记录图片按 `(record_uid, sha256)` 唯一；数据删除通过外键级联清理图片和匹配关联。
- 依据：`database.ts:493-531,930-945`。

### 6.5 知识库

#### FR-KB-001 支持文件

- 支持 `.docx/.pdf/.xlsx/.xls/.txt`，单文件最大 100 MB；重复文件按 SHA-256 复用索引。
- 依据：`knowledge.ts:19-28,531-617`、`main/index.ts:643-665`。

#### FR-KB-002 文档解析

- DOCX 使用 mammoth；PDF 使用 pdfjs，扫描型页面使用 Tesseract `chi_sim`/`eng`；Excel 保留 sheet 名；TXT 直接读取。
- 依据：`knowledge.ts:200-330`。

#### FR-KB-003 分块

- 默认分块大小 1000、重叠 20；保留页码、工作表、位置、字符区间。
- 依据：`knowledge.ts:23-25,330-370`、`shared/types.ts:464-477`。

#### FR-KB-004 本地 embedding

- 默认模型 `Xenova/bge-small-zh-v1.5`，384 维；运行时从本地资源加载，资源不可用会报错/产生失败进度；测试 fallback 只由环境变量启用。
- 依据：`knowledge.ts:19-28,370-470`、`README.md:128-143`。

#### FR-KB-005 文档生命周期

- `queued -> processing -> ready/failed`；失败可重试；重建索引重新生成全部向量。
- 依据：`shared/types.ts:443-462`、`knowledge.ts:788-909`。

#### FR-KB-006 记录增量索引

- 同步/导入/删除后按记录 content hash 和模型版本增量更新或删除记录向量。
- 依据：`knowledge.ts:904-979`、`database.ts:1397-1483`。

#### FR-KB-007 语义检索

- 查询向量与候选向量做 cosine，结合关键词命中：`0.75*cosine + 0.25*lexical`；得分低于 0.18 的文档命中过滤，最多 20 条。
- 记录匹配按每条记录取最佳分数，分数乘 100，默认最多 100000 候选。
- 依据：`knowledge.ts:693-775`。

#### FR-KB-008 文档详情和预览

- 文档详情返回分块；PDF 在线预览只允许小于等于 50 MB，返回 base64；源文件不存在/为空/过大时返回明确错误。
- 依据：`main/index.ts:627-641`、`ProjectManagementPage.tsx` 协议预览逻辑。

#### FR-KB-009 标签和删除

- 标签去重、去空、最多 20 个；删除文档应清理相关 chunks/vectors，并返回结果。
- 依据：`knowledge.ts:624-642`、`database.ts:1307-1334`。

#### FR-KB-010 进度和统计

- 通过 `knowledge:progress` 发送 parsing/embedding/records/done/error；统计文档、ready/processing/failed、分块、已索引分块、记录数和模型版本。
- 依据：`shared/types.ts:515-544`、`database.ts:1504-1549`。

### 6.6 AI 助手

#### FR-AI-001 会话管理

- 会话保存消息 JSON、标题、预览、消息数、创建/更新时间；支持列表、详情、保存、删除。
- 依据：`App.tsx:1188-1344`、`database.ts:1074-1189`。

#### FR-AI-002 通用数据问答

- 通过 `agent:ask` 路由到通用或可视化专家；通用助手使用 `OllamaAgent` 和 `ModelClient`。
- 依据：`main/index.ts:190-264`、`experts/router.ts`、`ollama.ts:299-310`。

#### FR-AI-003 证据工具

- 支持 `search_records`、`inspect_fields`、`query_records_by_fields`、`get_record_detail`、`aggregate_records`、`aggregate_by_field` 等工具；模型不能直接执行任意 SQL。
- 工具调用结果包含来源/数据视图，回答可引用记录或文档。
- 依据：`ollama.ts:62-210,907-1149`。

#### FR-AI-004 字段语义确认

- 对字段不确定的提问先检查字段画像；具体记录属性必须继续使用字段查询，避免把画像样例当事实。
- 这是系统提示和工具描述中的业务规则，代码依据 `ollama.ts:944-956`。

#### FR-AI-005 知识检索

- AI 可搜索文档和采集记录向量，回答中返回 `ChatSource`，可打开对应记录/文档详情。
- 依据：`ollama.ts:353-401`、`knowledge.ts:693-775`、`App.tsx:1361-1370`。

#### FR-AI-006 数据视图

- 回答可携带分组、总数、字段和值，前端以抽屉表格呈现，并可查看记录详情。
- 依据：`shared/types.ts:546-591`、`App.tsx:1884-2068`。

#### FR-AI-007 数据范围

- 请求可带 `projectId`、`dataScope`、对话历史和当前大屏 artifact；大屏入口可以把资产中心范围传给可视化专家。
- 依据：`shared/types.ts:569-591`、`App.tsx:1405-1418,3856-3895`。

#### FR-AI-008 外发与异常

- 在线模型会发送对话上下文、检索结果和生成任务数据；代码提供模型来源配置和项目协议外发确认，但未提供字段级脱敏或企业数据策略。
- 这是明确安全边界，业务合规要求待确认。

#### FR-AI-009 需求分析专家

- AI 助手支持通过 `@需求分析专家` 和一个或多个需求编号精确定位数据中心记录；每条编号先清洗 HTML 实体/标签并构建结构化语义卡片，再在全部已建立索引记录中执行 Dense、SQLite FTS5/BM25 和结构化字段三路召回。
- 三路各取前 100 条，通过 RRF 合并为最多 50 条候选；本地 `Xenova/bge-reranker-base` INT8 Cross-Encoder 重排后取前 20 条，分别执行 AI 业务关系初审和不读取初审答案的独立复核。
- 关系只能是 `duplicate`、`highly_similar`、`partial_overlap`、`same_pattern`、`topic_only` 或 `unrelated`。正式匹配展示前两类，后两类参考关联展示中间两类，`topic_only`/`unrelated` 过滤；结果包含双方原文证据、共同点、差异、召回分、重排分和复核状态。
- 文案修改、权限配置、功能新增、缺陷修复、同模块和同对象不同动作按硬规则降级，不能仅凭关键词或主题判为高度相似。复核、证据、UID 或模型/索引任一失败时失败关闭，不回退到向量分。
- 没有正式匹配时返回“未发现业务目标一致的高度相似或重复需求。检索到的记录仅存在主题、模块或操作模式上的关联。”分数统一称为“综合匹配度”，未做概率解释。
- `scripts/smoke-agent-requirement-analysis.ts` 包含多编号、HTML/IssueType、双复核、UID 严格校验、模型失败关闭和 `VISSLM-TSIS-779` 固定回归。`test-data/requirement-matching` 提供双人标注协议和空金标脚手架；未填充真实人工金标前，不得宣称 Recall/Precision 门禁通过。
- 依据：`experts/router.ts`、`experts/requirement-analysis-agent.ts`、`requirements/semantic-card.ts`、`requirements/hybrid-retrieval.ts`、`requirements/cross-encoder-reranker.ts`、`knowledge.ts`、`database.ts`、`scripts/smoke-agent-requirement-analysis.ts`。

### 6.7 本地分析查询

#### FR-ANALYTICS-001 字段画像

- 根据范围扫描记录，收集字段路径、类型、非空率、去重数、样例、角色和敏感度；结果按 scope 和 analytics revision 缓存。
- 依据：`query-engine.ts:56-249`、`database.ts:3552-3660`。

#### FR-ANALYTICS-002 语义编辑

- 支持修改字段显示名、角色、同义词、敏感度，并持久化到 `field_profiles`。

#### FR-ANALYTICS-003 QuerySpec 校验

- source 只能是 records；1-8 个指标；最多 2 个维度、12 个过滤条件、500 行；字段和类型需匹配；公式只能使用受限算术字符。
- 依据：`query-spec.ts:141-206`、`query-engine.ts:591-645`。

#### FR-ANALYTICS-004 查询执行

- 支持 count/countDistinct/sum/avg/min/max，过滤、排序、分组、日/周/月/季度、同比/环比/占比/累计和公式；结果返回 columns/rows/scannedRows/matchedRows/truncated/elapsedMs。
- 依据：`query-engine.ts:647-753`。

#### FR-ANALYTICS-005 查询缓存

- 以 QuerySpec 哈希和 `analytics_revision` 缓存结果；数据变化时 revision 增加使旧缓存失效。
- 依据：`database.ts:3540-3549,3683-3720`。

#### FR-ANALYTICS-006 分析限制

- 当前实现最大扫描记录数由 `scanAnalyticsRecords` 的默认 100000 约束，查询输出最多 500 行；超过限制标记 truncated。

### 6.8 可视化大屏

#### FR-VIZ-001 DashboardSpec

- 大屏包含 schemaVersion=1.0、标题、说明、主题、业务上下文、全局筛选、视口和组件；组件支持 kpi/bar/line/pie/ranking/table/progress/insight/gauge/funnel/radar/scatter。
- 依据：`shared/dashboard.ts:3-93`。

#### FR-VIZ-002 组件数据

- 组件可绑定 QuerySpec，渲染前由前端执行查询并转成数据点；支持组件布局、单位、配色、样式和洞察文本。
- 依据：`DashboardStudio.tsx:206-221`、`DashboardComponentRenderer.tsx`。

#### FR-VIZ-003 大屏编辑

- Dashboard Studio 支持拖拽网格、组件增删/编辑、数据范围、全局筛选器和草稿 localStorage；组件列表来源 `componentRegistry`。

#### FR-VIZ-004 AI 生成和修改

- 通过 @可视化专家或大屏入口生成 DashboardSpec；已有 artifact 时执行受限 patch；服务端校验 schema、查询和组件类型。
- 依据：`main/index.ts:190-264`、`visualization-agent.ts:23-923`。

#### FR-VIZ-005 保存版本

- `dashboards:save` 校验通过后写入 dashboard 摘要和新版本；`restore` 从指定版本恢复并产生新版本/审计，工作台恢复前提示覆盖风险并在恢复期间禁止重复提交。
- 依据：`database.ts:3721-3840`。

#### FR-VIZ-006 质量诊断

- 对每个组件执行查询，返回 score、问题、耗时、扫描/匹配/结果行数和空/错误状态；敏感字段和大数据量诊断规则在 `diagnostics.ts`。

#### FR-VIZ-007 导出

- 支持 JSON、PDF、PNG；导出前校验；PNG 需验证 data URL、PNG signature 和 50 MB 上限；均可取消并记录审计。
- 依据：`main/index.ts:362-516`。

#### FR-VIZ-008 审计

- 保存、恢复、诊断、三种导出和数据导出均可写 `dashboard_audit_logs`；AI 运行写 `visualization_runs`。版本保存保留完整可恢复 `DashboardSpec`，非保存操作在审计 metadata 中记录属性排序后的稳定 SHA-256 `specHash`；组件修复同时记录 `sourceSpecHash` 和结果 `specHash`，不重复写入完整 Spec。

#### FR-VIZ-009 版本比较

- `compareDashboardSpecs` 比较顶层字段、视口、组件增删改和 QuerySpec 变化。

#### FR-VIZ-010 运行边界

- 查询仅访问本地 records；模型生成受 JSON Schema 和 QuerySpec 校验限制；没有任意代码执行路径。

#### FR-VIZ-011 待确认

- 大屏是否需要多人协作、发布审批和远程分享，代码未实现。

### 6.9 项目管理

#### FR-PM-001 项目创建/列表/详情

- 支持手动创建项目、上传技术协议自动创建草稿、搜索分页、查看/编辑/删除、完整项目 JSON 导入导出。
- 依据：`ProjectManagementService:111-169`、`ProjectManagementPage.tsx:2955-3159`。

#### FR-PM-002 项目基本字段

- 项目名称、客户、合同金额、风险系数、交付提醒天数、交付日期、销售/技术/开发负责人、预计成本、预计工期。
- 非负金额/风险/工期和名称非空规则在服务层归一化。

#### FR-PM-003 技术协议上传

- 支持与知识库相同的五种扩展名；可为现有项目上传或从协议创建 draft。
- 在线模型必须显式 `allowExternalProcessing=true`；同一项目不允许并发协议任务。
- 依据：`ProjectManagementService.startTechnicalAgreement:178-223`。

#### FR-PM-004 协议解析与需求提取

- 文件进入知识库索引；分块按批次发送给模型，提取项目字段、需求分类/标题/内容/信息词/来源位置/证据/置信度；无法回溯证据会降置信度并记录 warning。
- 依据：`project-management.ts:628-850`。

#### FR-PM-005 需求审核集

- 解析生成 `reviewing` 版本；需求状态为 `pending/approved/rejected`；人工可补录、编辑、拆分、合并、审核、删除；发布后审核集变 `published`，旧集 `superseded`。
- 依据：`project-management.ts:268-336`、`database.ts:2433-2950`。

#### FR-PM-006 需求原子化和规范化

- 标题/内容不能为空；类别不在允许集合时回退 functional；关键信息词最多 12 个；证据最多 1000 字；审核备注最多 500 字；置信度 clamp 到 0-1；编号化内容可拆成原子需求并去重。
- 依据：`project-management.ts:480-505,750-850`。

#### FR-PM-007 项目确认和匹配前置

- 草稿项目确认后变 active；有已发布需求且没有未发布审核集时才能匹配；确认会在有需求时尝试启动匹配。
- 依据：`project-management.ts:169-176,252-266`。

#### FR-PM-008 需求状态

- AI/人工状态：`unmarked/satisfied/to_develop/to_negotiate`；状态来源区分 ai/manual；记录最高匹配度、匹配数和原因。
- 依据：`shared/project-types.ts:4-6,270-298`。

#### FR-PM-009 批量/单项匹配

- 基于本地记录向量排名，结合模型复核时返回 AI 分数/原因；保存 vectorScore、aiScore、finalScore、scoreSource、bestChunkId。
- 支持项目全量匹配和单需求重新匹配；任务期间禁止相同项目并发任务。
- 依据：`project-management.ts:336-353,990-1085`、`knowledge.ts:730-775`。

#### FR-PM-010 关键功能信息词

- 匹配抽屉显示 AI 提取/人工修改的信息词；人工保存后重新匹配；匹配结果按信息词影响。
- 依据：`ProjectManagementPage.tsx:711-924`、`project-management.ts:329-335`。

#### FR-PM-011 匹配明细与资产关联

- 抽屉分页展示数据中心记录、分数、说明、是否项目资产；数据名称可打开上下文详情；可直接关联项目资产。
- 详情弹窗使用 `mask={false}`，描述/图片按安全样式展示，原始 JSON 折叠；该行为受 `agents.md` 强约束。

#### FR-PM-012 匹配失效

- 同步、导入、删除记录或手工变更关键数据后，项目匹配状态被标 stale，需要重新匹配。

#### FR-PM-013 成本台账

- 成本类型为 estimated/actual，分类非空、金额非负、日期可选；可关联当前项目参与人作为责任人；支持 CRUD。
- 依据：`project-management.ts:356-377,594-609`。

#### FR-PM-014 组织人员

- 姓名非空，员工号/部门/角色/工时报价/状态/备注；工时报价非负；支持 active/inactive 和 CRUD。

#### FR-PM-015 项目参与人

- 绑定组织人员、开始/结束日期、备注；结束不得早于开始；同一项目同一人员唯一；保存绑定时快照工时报价。

#### FR-PM-016 项目计划

- 任务类型 milestone/phase/task，状态 not_started/in_progress/completed/blocked，进度 0-100，日期合法；支持负责人、父子层级、排序、拖拽移动、内联编辑和删除。
- 服务层禁止自环和挂到自身后代，数据库父任务删除时 SET NULL。
- 依据：`project-management.ts:421-453,540-585`、`database.ts:874-894`。

#### FR-PM-017 项目资产

- 从本地 records 选择并关联/解除关联；项目删除级联关联；记录删除会级联关联。

#### FR-PM-018 项目文档版本

- 项目可关联多个知识文档，保存版本和当前标志；详情展示当前协议及历史版本，可在线预览 PDF。

#### FR-PM-019 进度和恢复

- 协议阶段 queued/embedding/extracting/done/error；匹配阶段 matching；进度写 `pm_analysis_runs` 并发到 `project:progress`。
- 应用启动时将遗留 processing 状态改 failed 并提示重试。

#### FR-PM-020 项目完整数据转移

- JSON 导出 `format=visslm-project, version=1` 的项目快照，包含文档、人员、参与人、成本、资产、计划、需求和匹配；导入会对不能关联的数据给 warning。

#### FR-PM-021 项目删除

- 分析/匹配 processing 时禁止删除；否则 `pm_projects` 删除并由外键级联项目域数据。

#### FR-PM-022 项目管理访问边界

- 现有实现没有角色校验；按已确认的单机单用户范围，当前本机操作人可以执行项目导入、删除、发布和推送。该行为不构成 RBAC。

#### FR-PM-023 项目 Excel 报表导出

- 项目详情页支持导出 `.xlsx` 报表，复用同一项目快照但不改变 JSON 导入/导出格式。
- 工作簿包含“项目概览”“技术协议”“项目人员”“项目参与人”“成本明细”“项目资产”“项目计划”“功能需求”“需求匹配”九个工作表；数组字段转为可读文本，布尔字段显示为“是/否”，数值字段保持数值类型。
- 导出前弹出系统保存对话框；用户取消、项目不存在或文件写入失败时返回失败结果，不修改数据库。
- 依据：`src/main/project-export.ts`、`src/main/index.ts:777-805`、`ProjectManagementPage.tsx:1842-1853,2308`、`scripts/smoke-project-export.ts`。

### 6.10 数据推送

#### FR-PUSH-001 选择推送记录

- 从本地 records 选择 UID，配置目标 nodeType、projectId、componentId、parentId、前后插入位置和字段映射。
- 依据：`shared/types.ts:216-231`、`App.tsx:2800-3365`。

#### FR-PUSH-002 请求构造

- 目标 endpoint 为 VISSLM `/alm/rest/items`；推送消息体按源字段映射；本地 `_valm_Uid/_valm_NodeType/_valm_ItemID` 强制移除。
- 依据：`visslm.ts:222-240,511-672`、`README.md:35-49`。

#### FR-PUSH-003 预览

- 生成每条请求的 endpoint、参数、body，不发请求、不写真实推送日志；页面可查看预览后再发送。

#### FR-PUSH-004 执行

- 逐条 POST，成功/失败独立记录；更新记录 push_status/message/pushed_at/pushed_uid；返回成功数、失败数、requests。

#### FR-PUSH-005 日志

- `push_logs` 保存请求/响应/HTTP 状态/错误/远端 UID，页面可分页查看。

#### FR-PUSH-006 安全边界

- Token 由凭据服务取得，不应显示在 UI；日志/预览应脱敏，但业务字段/响应可能包含敏感信息，导出分享前需检查。

## 7. 业务规则编号

| 编号 | 规则 | 代码依据 |
|---|---|---|
| BR-CORE-001 | 本应用单实例运行；第二实例只恢复并聚焦已有窗口 | `main/index.ts:848-858` |
| BR-CORE-002 | 本地数据以 SQLite 为主存储，采用 WAL、外键和 busy_timeout | `database.ts:456-461` |
| BR-CONFIG-001 | 秘密只通过 `safeStorage` 加密保存，返回值只给 hasToken/hasApiKey | `settings.ts:204-221`、共享类型 |
| BR-CONFIG-002 | 功能开关不是安全权限 | `App.tsx` 与 IPC handler 对比 |
| BR-SYNC-001 | 未保存采集范围不能执行预览 | `main/index.ts:165-169` |
| BR-SYNC-002 | 同步后记录知识索引同步，项目匹配变 stale | `main/index.ts:170-178` |
| BR-SYNC-003 | 导入文件上限 512 MB，知识文档单文件上限 100 MB | `main/index.ts:579-580`、`knowledge.ts` |
| BR-DATA-001 | 记录 UID 主键；附件按记录和 SHA-256 去重 | `database.ts:493-531` |
| BR-KB-001 | 知识文档按 SHA-256 去重并复用索引 | `knowledge.ts:549-561` |
| BR-KB-002 | 向量模型版本变更时需要重建索引 | `knowledge.ts:508-514`、`database.ts:1456-1483` |
| BR-AI-001 | 记录属性问题必须有 `query_records_by_fields` 证据，字段画像不能作为属性事实 | `ollama.ts:944-956,991-1001` |
| BR-ANALYTICS-001 | 单次 QuerySpec 最多 8 个指标、2 个维度、12 个过滤条件、500 行 | `query-spec.ts:141-206`、`query-engine.ts` |
| BR-VIZ-001 | Dashboard 保存/导出前必须通过结构和查询校验 | `main/index.ts:284-309,362-516` |
| BR-VIZ-002 | PNG 导出必须是合法 PNG 且不超过 50 MB | `main/index.ts:455-516` |
| BR-PM-001 | 项目名称、需求标题、需求内容、人员姓名、任务名称、成本分类分别不能为空 | `project-management.ts:126-141,386-453,480-506,594-609` |
| BR-PM-002 | 在线模型解析协议必须有本次外发确认 | `project-management.ts:190-194` |
| BR-PM-003 | 同一项目不能并发协议分析/匹配任务 | `project-management.ts:204-208,226-252,258-264` |
| BR-PM-004 | 存在未发布需求审核集时不能匹配 | `project-management.ts:253-266` |
| BR-PM-005 | 已发布需求不能直接删除，只能通过新协议版本变更 | `project-management.ts:319-327` |
| BR-PM-006 | 需求审核集需人工审核/发布后才作为活动项目匹配范围 | `project-management.ts:308-317`、`database.ts:1593-1621` |
| BR-PM-007 | 计划任务不能自环或成为自己的后代 | `project-management.ts:518-538` |
| BR-PM-008 | 参与人和成本责任人必须属于当前项目/组织人员 | `project-management.ts:401-418,594-609` |
| BR-PM-009 | 进行中的项目任务不能直接删除 | `project-management.ts:140-146` |
| BR-PM-010 | 应用退出中断的 processing 任务启动时标记 failed | `database.ts:1850-1874` |
| BR-PUSH-001 | 推送预览不发请求；正式推送逐条写日志和记录状态 | `visslm.ts:517-672` |
| BR-PUSH-002 | 本地 UID/类型/编号不作为新推送记录标识写入 body | `visslm.ts`、`README.md:43-49` |

## 8. 非功能需求（当前实现/约束）

| 编号 | 非功能要求 | 当前证据/差距 |
|---|---|---|
| NFR-001 | Windows x64 可安装 | electron-builder NSIS x64 配置；未见签名证书 |
| NFR-002 | 主进程和渲染进程隔离 | `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false` |
| NFR-003 | 本地敏感凭据保护 | `safeStorage`；HTTP 平台地址仍可能明文传输 |
| NFR-004 | 长任务有进度和失败状态 | sync/knowledge/project/agent 有事件；无跨进程持久队列 |
| NFR-005 | 数据可恢复/可迁移 | JSON/JSONL/项目快照有导入导出；未提供数据库一致性备份工具 |
| NFR-006 | 查询受限 | QuerySpec 校验、500 行、100000 扫描默认上限、缓存 |
| NFR-007 | 界面稳定 | 表格内部 scroll.y 和列宽持久化；自定义表格统一性仍有差距 |
| NFR-008 | 可审计 | Dashboard 操作、采集/推送请求、任务状态有日志；缺少操作人身份 |
| NFR-009 | 可测试 | typecheck/build/smoke/CDP UI 脚本；未见标准 unit runner/CI |
| NFR-010 | 隐私 | 在线模型外发由配置/项目协议确认控制；无全局脱敏、租户隔离或 DLP |

## 9. 待确认事项

1. VISSLM API 的正式接口契约、分页/限流/重试/幂等规则和 HTTPS 是否强制。
2. 技术协议、原始记录、图片、API 响应和模型上下文的保留期限、敏感等级和删除合规规则。
3. 项目需求“满足/开发/协商/未标记”的业务定义、审核职责和发布审批规则。
4. 匹配分数阈值、AI 复核失败策略、重复需求合并规则是否满足业务验收。
5. 项目成本、工时报价、责任人和交付风险的计算口径是否需要财务/项目系统对接。
6. 在线模型是否允许处理协议、数据中心记录和字段样例；是否必须仅使用本地模型。
7. 知识库源文件路径失效后的迁移/重建流程及跨设备备份方案。
8. 长任务在关闭应用、系统休眠、网络中断时的恢复要求。
9. 大屏是否需要发布、分享、协作、定时刷新和远程访问。

## 10. 代码依据索引

参见 `docs/00-project-scan.md` 和 `docs/01-code-mapping.md` 的索引；需求细节主要依据：`src/main/index.ts`、`src/main/database.ts`、`src/main/settings.ts`、`src/main/visslm.ts`、`src/main/knowledge.ts`、`src/main/ollama.ts`、`src/main/model-client.ts`、`src/main/analytics/query-engine.ts`、`src/main/project-management.ts`、`src/shared/types.ts`、`src/shared/project-types.ts`、`src/shared/query-spec.ts`、`src/shared/dashboard.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/dashboard/DashboardStudio.tsx`、`src/renderer/src/project-management/ProjectManagementPage.tsx`、`README.md`。
