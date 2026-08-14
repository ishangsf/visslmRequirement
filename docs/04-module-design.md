# 04 模块详细设计

> 最后分析时间：2026-08-01  
> 代码基线：Git `9bab57fc5166770784c1855857a6e1a8ebaa6200`；分析对象为当前工作树。  
> 依赖文档：`docs/00-project-scan.md`、`docs/01-code-mapping.md`、`docs/02-requirements.md`、`docs/06-api-design.md`。

本文件按当前代码的模块边界描述。项目没有独立 HTTP Controller 和 DAO；下文的 Controller 指 `src/main/index.ts` 中 IPC handler，DAO 指 `AppDatabase` 方法。

## M-01 数据概览

1. **模块名称**：数据概览。
2. **模块编号**：M-01。
3. **模块目标**：显示本地同步数据规模、构成和推送状态。
4. **业务范围**：项目数、记录数、图片数、采集/推送数、按类型/项目/发布版本统计。
5. **对应前端目录**：`src/renderer/src/App.tsx` 内 `DashboardPage`（约 308 行起）。
6. **对应后端目录**：`src/main/database.ts`。
7. **页面入口**：侧栏“数据概览”。
8. **前端路由**：单页 `PageKey='dashboard'`，无 URL 路由。
9. **API 列表**：`data:stats` / `getStats`。
10. **Controller**：`src/main/index.ts:160`。
11. **Service**：无独立 service，直接调用 `AppDatabase.getStats`。
12. **DAO**：`AppDatabase.getStats`（约 `4592-4644`）。
13. **数据表**：`projects`、`records`、`images`；推送状态来自 `records.push_status`。
14. **核心流程**：页面挂载/refreshKey 变化 -> 读取统计 -> 计算指标卡和图表 -> 数据变化后由 AppShell 递增 refreshKey。
15. **状态变化**：没有独立状态；统计随同步、导入、删除、推送后的数据变化刷新。
16. **业务规则**：统计值由数据库聚合返回，前端不自行估算；数量/单位应保持同一行。
17. **权限点**：无权限点；`feature.dashboard` 只控制导航显示。
18. **异常处理**：IPC Promise reject 时页面需要显示加载/错误状态；当前实现未见标准错误码。
19. **依赖模块**：资产中心、采集、推送；`refreshKey` 由 AppShell 传入。
20. **外部依赖**：无直接外部调用；统计数据间接来自 VISSLM 同步。
21. **扩展点**：增加统计聚合、时间范围、缓存或 Dashboard 组件。
22. **已知问题**：统计口径和“采集数”的业务定义需确认；没有操作人/权限过滤。
23. **代码依据**：`App.tsx:308-468,3895-4118`、`src/shared/types.ts:299-308`、`database.ts:4592-4644`。

## M-02 数据采集

1. **模块名称**：数据采集与同步。
2. **模块编号**：M-02。
3. **模块目标**：按配置从 VISSLM 递归拉取数据、附件并保存本地。
4. **业务范围**：节点选择、字段过滤、范围预览、同步、进度、请求日志、同步结果。
5. **对应前端目录**：`src/renderer/src/App.tsx` 内 `SyncPage`。
6. **对应后端目录**：`src/main/visslm.ts`、`src/main/settings.ts`。
7. **页面入口**：侧栏“数据采集”。
8. **前端路由**：`PageKey='sync'`；内部 Tab `config/logs`。
9. **API 列表**：`sync:get-config/save-config/preview/start/request-logs`，`onSyncProgress`。
10. **Controller**：`src/main/index.ts:161-181`。
11. **Service**：`SyncService`、`VisslmClient`。
12. **DAO**：`beginSync/finishSync/listSyncRuns`、`begin/finish/listCollectionRequestLogs`、`upsertProject/upsertRecord/saveImage/retainRecords`。
13. **数据表**：`settings`、`sync_runs`、`collection_request_logs`、`projects`、`records`、`images`。
14. **核心流程**：配置范围 -> 预览请求/样例 -> 保存配置 -> `SyncService.run` -> 递归查询 -> 保存项目/记录 -> 下载附件 -> 保留本轮 UID -> 索引同步/匹配 stale。
15. **状态变化**：同步运行 `running/success/failed`；请求日志 `running/success/failed`；项目匹配同步后 `stale`。
16. **业务规则**：预览需要保存配置；过滤在客户端/请求构造中应用；附件按 SHA-256 去重；导入/同步后更新索引。
17. **权限点**：无；`feature.sync` 是菜单开关，平台权限由外部 Token 决定。
18. **异常处理**：缺凭据、平台 HTTP 失败、附件失败写请求日志/同步错误；部分失败策略需 smoke 和业务确认。
19. **依赖模块**：数据库、设置、知识库索引、项目管理匹配失效。
20. **外部依赖**：VISSLM/ALM API、附件 URL、Windows 文件系统。
21. **扩展点**：重试/限流/断点续传、更多节点规则、后台队列、同步取消。
22. **已知问题**：没有持久任务队列和统一重试策略；外部接口契约未独立固化。
23. **代码依据**：`src/main/visslm.ts:148-510,673-878`、`App.tsx:2056-2795`、`database.ts:4936-4981`。

## M-03 资产中心

1. **模块名称**：资产中心/数据记录。
2. **模块编号**：M-03。
3. **模块目标**：浏览、检索、查看和管理本地同步记录。
4. **业务范围**：分页筛选、全文搜索、详情、附件、删除、JSON/JSONL 导入导出、推送状态。
5. **对应前端目录**：`src/renderer/src/App.tsx` 的 `AssetCenterPage`、`RichDescription.tsx`、`ResizableTable.tsx`。
6. **对应后端目录**：`src/main/database.ts`。
7. **页面入口**：侧栏“资产中心”，内部数据/知识库 Tab。
8. **前端路由**：`PageKey='data'`；记录详情是 Drawer/Modal，不是独立路由。
9. **API 列表**：`data:projects/node-types/records/record/stats/import/export/delete`。
10. **Controller**：`src/main/index.ts:156-160,517-622`。
11. **Service**：无独立 asset service，直接由 `AppDatabase` 读写；导入/删除后调用 `KnowledgeService` 和 PM stale。
12. **DAO**：`listRecords/getRecord/getStats/exportRows/importRows/deleteData`。
13. **数据表**：`projects`、`records`、`images`、`records_fts`；关联项目资产在 PM 表。
14. **核心流程**：加载项目/类型 -> 分页查询 -> FTS/项目/类型筛选 -> 点击记录 -> 取原始 JSON/图片 -> 详情渲染；变更后刷新索引和项目匹配。
15. **状态变化**：记录 `push_status`；数据库记录新增/更新/删除维护 FTS 触发器。
16. **业务规则**：UID 唯一；图片 `(record_uid, sha256)` 唯一；导入最大 512 MB；富文本 HTML 经过清洗。
17. **权限点**：无；删除、导入、导出没有角色检查。
18. **异常处理**：JSON 行错误跳过并返回 errors；不存在记录返回 null；文件对话框取消返回 canceled。
19. **依赖模块**：数据采集写入、知识库记录索引、推送状态、项目资产关联。
20. **外部依赖**：间接依赖 VISSLM；无页面直接 HTTP。
21. **扩展点**：高级筛选、批量编辑、数据质量、脱敏、导出权限和备份。
22. **已知问题**：原始 JSON/响应可能含敏感字段；无统一数据保留和访问审计。
23. **代码依据**：`App.tsx:469-832,3856-3895`、`RichDescription.tsx:1-77`、`database.ts:493-531,4276-4324,4982-5180`。

## M-04 知识库

1. **模块名称**：本地知识库。
2. **模块编号**：M-04。
3. **模块目标**：将文档和采集记录转成可检索的分块/向量知识。
4. **业务范围**：上传、解析、OCR、分块、embedding、去重、重试、标签、删除、索引重建、来源预览。
5. **对应前端目录**：`src/renderer/src/App.tsx` 的 `KnowledgeBasePage`；项目详情协议 Tab。
6. **对应后端目录**：`src/main/knowledge.ts`、`src/main/index.ts`。
7. **页面入口**：资产中心内部知识库 Tab，项目详情技术协议 Tab。
8. **前端路由**：复用 `PageKey='data'`；协议预览为上下文 Modal。
9. **API 列表**：`knowledge:documents/document/document-preview/upload/retry/tags/delete/rebuild/stats`，`onKnowledgeProgress`。
10. **Controller**：`src/main/index.ts:623-672`。
11. **Service**：`KnowledgeService`、内部 `DocumentParser`、`EmbeddingService`。
12. **DAO**：文档/分块/向量/索引任务相关 `AppDatabase` 方法（`1212-1550` 左右）。
13. **数据表**：`knowledge_documents`、`knowledge_chunks`、`knowledge_vectors`、`knowledge_index_tasks`；记录索引复用 `records`。
14. **核心流程**：选择文件 -> hash 去重 -> managed documents 保存 -> parse/OCR -> chunk -> embedding -> 事务替换 chunks/vectors -> ready；记录变化走增量索引。
15. **状态变化**：`queued -> processing -> ready/failed`；progress phase `parsing/embedding/records/done/error`。
16. **业务规则**：五种扩展名、100 MB 上限、chunk size 1000/overlap 20、默认 embedding 384 维、查询阈值 0.18。
17. **权限点**：无；上传/删除/重建未按角色限制。
18. **异常处理**：签名无效、空文件、解析无正文、embedding 不可用写 failed；PDF preview 返回明确错误。
19. **依赖模块**：资产中心记录、项目协议分析、AI 检索、模型配置/本地资源。
20. **外部依赖**：mammoth、pdfjs-dist、xlsx、tesseract.js、Transformers；资源准备阶段依赖下载源。
21. **扩展点**：更多解析器、向量数据库、分块策略、租户过滤、文档版本和后台任务。
22. **已知问题**：向量检索应用层全扫描；源文件路径管理和跨设备迁移依赖用户维护。
23. **代码依据**：`knowledge.ts:19-28,200-330,470-984`、`database.ts:675-746,1191-1550`、`App.tsx:846-1137`。

## M-05 AI 助手

1. **模块名称**：AI 助手。
2. **模块编号**：M-05。
3. **模块目标**：使用自然语言检索、统计、解释本地记录和知识库。
4. **业务范围**：会话、工具调用、记录/字段查询、聚合、知识检索、需求编号分析、来源引用、数据视图、模型切换。
5. **对应前端目录**：`src/renderer/src/App.tsx` 的 `ChatPage`。
6. **对应后端目录**：`src/main/ollama.ts`、`src/main/model-client.ts`、`src/main/experts/router.ts`、`src/main/experts/requirement-analysis-agent.ts`。
7. **页面入口**：侧栏“AI 助手”；资产中心“可视化”动作可带范围跳转聊天。
8. **前端路由**：`PageKey='chat'`。
9. **API 列表**：`agent:ask`、`chat:sessions/session/save-session/delete-session`、`onAgentEvent`；前端点击来源再调用 `getRecord/getKnowledgeDocument`。
10. **Controller**：`src/main/index.ts:182-264`。
11. **Service**：`ExpertRouter`、`OllamaAgent`、`ModelClient`、`KnowledgeService`、`QueryEngine`。
12. **DAO**：`AppDatabase` chat CRUD、`searchForAgent/inspectFields/queryRecordsByFields/aggregate/aggregateByField/getRecord`。
13. **数据表**：`chat_sessions`、`records`、`knowledge_*`、`field_profiles`、`query_cache`；可视化请求写 `visualization_runs`。
14. **核心流程**：路由专家 -> 通用助手计划/工具调用、需求分析专家编号定位与有效语义资产读取 -> 全量原文 Dense/FTS5/BM25 + ready 卡片结构化 RRF 召回 -> 本地 Cross-Encoder 重排 -> 确定性多维评分 -> Top10 一次批量 AI 解释 -> UID/证据/schema 程序校验 -> 返回 answer/sources/dataViews；未就绪资产使用 source-only 原文视图，不在查询阶段生成语义卡片；会话由前端保存。
15. **状态变化**：前端 loading；工具循环直到无 tool_calls；可视化路径发送 status/artifact/error 事件。
16. **业务规则**：指定记录属性必须用字段查询证据；字段不确定先画像；总量和字段聚合不能混用；模型不能直接 SQL。
17. **权限点**：无；在线模型和本地模型由设置决定。
18. **异常处理**：模型超时/HTTP 错误 reject；无数据返回可恢复 `NO_ANALYTICS_DATA`；工具错误作为模型上下文或回答处理。
19. **依赖模块**：知识库、资产中心、分析查询、Dashboard 专家、模型设置。
20. **外部依赖**：Ollama 或在线模型服务；在线模型可接收检索上下文。
21. **扩展点**：增加专家、工具、对话记忆策略、流式文本、权限和敏感字段过滤。
22. **已知问题**：需求分析的批量 AI 解释依赖配置中的模型服务；本地 Cross-Encoder 和 embedding 资源必须完整，任一不可用会失败关闭；综合匹配度未做概率校准；对话/工具结果无统一可观测 trace；在线数据外发没有统一审批。
23. **代码依据**：`ollama.ts:62-210,299-1280`、`experts/requirement-analysis-agent.ts`、`model-client.ts`、`experts/router.ts`、`App.tsx:1138-2055`。

## M-06 本地分析查询

1. **模块名称**：分析查询引擎。
2. **模块编号**：M-06。
3. **模块目标**：为 AI 和 Dashboard 提供受约束、可缓存、可复现的本地数据查询。
4. **业务范围**：字段画像、语义元数据、过滤、聚合、时间粒度、同比/环比/占比/累计、受限公式。
5. **对应前端目录**：`DashboardStudio.tsx`，AI 结果间接使用。
6. **对应后端目录**：`src/main/analytics/query-engine.ts`、`src/shared/query-spec.ts`。
7. **页面入口**：可视化大屏字段/查询编辑；无独立导航页。
8. **前端路由**：`visualization` 内部状态。
9. **API 列表**：`analytics:field-profiles`、`analytics:field-profile-semantics`、`analytics:execute-query`。
10. **Controller**：`src/main/index.ts:266-276`。
11. **Service**：`QueryEngine`。
12. **DAO**：`scanAnalyticsRecords/getFieldProfiles/saveFieldProfiles/updateFieldProfileSemantics/getQueryCache/saveQueryCache`。
13. **数据表**：`records`、`field_profiles`、`query_cache`。
14. **核心流程**：范围 -> revision/cache -> 扫描记录 -> profile/validate -> filter/group/aggregate -> calculations/formulas -> sort/limit -> cache/result。
15. **状态变化**：`analytics_revision` 在数据变更时 bump；cache 按 revision 无效。
16. **业务规则**：指标最多 8、维度最多 2、过滤最多 12、结果最多 500、公式仅 ASCII 算术和已有指标引用。
17. **权限点**：无；查询范围由请求的 `DataScope` 决定，没有用户范围校验。
18. **异常处理**：字段不存在、类型不匹配、公式循环/非法、时间计算缺少时间粒度时抛出校验错误。
19. **依赖模块**：资产中心 records、Dashboard、AI 工具调用。
20. **外部依赖**：无直接外部服务。
21. **扩展点**：更多聚合、SQL 引擎、物化视图、列级敏感权限、数据快照。
22. **已知问题**：扫描和聚合在主进程内存中运行；字段敏感度仅画像元数据，不会阻断查询。
23. **代码依据**：`query-engine.ts:1-753`、`query-spec.ts:1-207`、`database.ts:3540-3720,3985-4032`。

## M-07 可视化大屏

1. **模块名称**：可视化大屏与可视化专家。
2. **模块编号**：M-07。
3. **模块目标**：用可追溯 QuerySpec 生成和编辑运营/分析大屏。
4. **业务范围**：组件、布局、主题、全局筛选、查询、AI 生成/补丁、版本、诊断、PNG/PDF/JSON 导出、审计。
5. **对应前端目录**：`src/renderer/src/dashboard`。
6. **对应后端目录**：`src/main/experts`、`src/main/dashboards`、`src/main/analytics`。
7. **页面入口**：侧栏“可视化大屏”；AI 结果可打开大屏。
8. **前端路由**：`PageKey='visualization'`。
9. **API 列表**：`dashboards:*` 全集、`analytics:*`、`agent:ask`（专家生成）、大屏导出三个通道。
10. **Controller**：`src/main/index.ts:190-516,266-361`。
11. **Service**：`VisualizationAgent`、`QueryEngine`、`validateDashboardSpec`、`diagnoseDashboard`。
12. **DAO**：`list/get/save/restoreDashboard`、版本/运行/审计 CRUD。
13. **数据表**：`dashboards`、`dashboard_versions`、`visualization_runs`、`dashboard_audit_logs`、`field_profiles`、`query_cache`。
14. **核心流程**：字段画像 -> 生成 QuerySpec/数据集 -> 组件渲染 -> 用户编辑/AI patch -> validate -> 保存版本 -> 诊断/导出。
15. **状态变化**：当前版本递增；恢复前需要用户确认，恢复产生新版本且恢复期间禁止重复提交；运行/审计 success/canceled/failed。
16. **业务规则**：Dashboard schemaVersion=1.0；组件类型和主题白名单；保存/导出必须查询校验；PNG 50 MB 上限。
17. **权限点**：无；可视化功能开关只控制页面。
18. **异常处理**：校验失败、空数据、模型生成 JSON 无效、导出取消/文件错误均有错误/审计路径；单组件修复失败保持原 Spec，并记录源指纹。
19. **依赖模块**：分析查询、资产中心、AI 助手、文件系统。
20. **外部依赖**：模型服务仅在 AI 生成/patch 时使用；PDF 由 Electron printToPDF 生成。
21. **扩展点**：组件 registry、主题、QuerySpec、版本 diff、质量规则、发布审批。
22. **已知问题**：大屏数据范围和权限未分离；长查询在主进程执行；质量分数规则需要业务验收；团队权限/审批和集中审计仍不在单机单用户范围。
23. **代码依据**：`shared/dashboard.ts`、`DashboardStudio.tsx`、`DashboardComponentRenderer.tsx`、`experts/visualization-agent.ts`、`dashboards/validator.ts`、`dashboards/diagnostics.ts`。

## M-08 项目管理

1. **模块名称**：项目管理与需求匹配。
2. **模块编号**：M-08。
3. **模块目标**：将技术协议、项目交付管理和数据中心能力匹配串成闭环。
4. **业务范围**：项目、协议版本、需求提取/审核/发布、需求状态、匹配明细、资产、成本、组织人员、参与人、计划，以及 JSON/Excel 项目数据导出。
5. **对应前端目录**：`src/renderer/src/project-management/ProjectManagementPage.tsx`。
6. **对应后端目录**：`src/main/project-management.ts`、`src/main/database.ts`。
7. **页面入口**：侧栏“项目管理”；项目列表进入详情。
8. **前端路由**：`PageKey='projects'`；详情内部 Tabs `overview/requirements/participants/plan/costs/assets/knowledge`，匹配为 Drawer。
9. **API 列表**：`projects:*` 全集（包含 `projects:export-data`、`projects:export-excel`、`projects:import-data`）、`organization:*`、`onProjectProgress`；匹配名称详情再使用 `data:record`。
10. **Controller**：`src/main/index.ts:673-840`。
11. **Service**：`ProjectManagementService`、`KnowledgeService`、`ModelClient`。
12. **DAO**：`pm_*` 和 `org_people` 全套 CRUD/快照/状态/匹配方法。
13. **数据表**：`pm_projects`、`pm_cost_entries`、`pm_project_documents`、`pm_requirement_sets`、`pm_project_assets`、`pm_project_participants`、`pm_project_tasks`、`pm_requirements`、`pm_requirement_matches`、`pm_analysis_runs`、`org_people`，关联 `knowledge_*`/`records`。
14. **核心流程**：手工/协议创建 draft -> 知识索引 -> 模型提取需求 -> reviewing -> 人工编辑/审核 -> publish -> confirm/active -> vector/AI matching -> 状态标记/资产关联 -> JSON/Excel 导出；并行维护成本/人员/计划。
15. **状态变化**：项目 lifecycle draft/active；analysis idle/processing/ready/failed；match idle/processing/ready/stale/failed；需求审核和业务状态分别管理。
16. **业务规则**：名称/标题/内容非空；在线协议外发确认；同项目任务互斥；未发布审核集禁止匹配；已发布需求不能直接删除；计划树不允许环；成本责任人必须是项目参与人。
17. **权限点**：无；项目数据、协议、发布、删除和匹配没有角色/项目成员授权。
18. **异常处理**：任务失败写状态/消息；应用重启将 processing 标 failed；证据无法回溯降低 confidence；删除进行中项目返回失败。
19. **依赖模块**：知识库、模型客户端、资产中心、数据同步、分析 revision。
20. **外部依赖**：协议解析使用本地资源；需求提取/AI 复核使用配置模型；匹配使用本地记录向量。
21. **扩展点**：权限/审批、需求版本 diff、更多匹配策略、项目成员角色、项目预算/工时系统集成、任务队列。
22. **已知问题**：需求提取模型结果依赖 prompt/JSON；匹配阈值与状态口径未由业务配置；项目页面和数据库高度耦合。
23. **代码依据**：`project-management.ts:1-1198`、`project-export.ts`、`ProjectManagementPage.tsx:711-3159`、`shared/project-types.ts`、`database.ts:765-962,1622-3539`。

## M-09 数据推送

1. **模块名称**：数据推送。
2. **模块编号**：M-09。
3. **模块目标**：将本地记录按字段映射安全回写到 VISSLM。
4. **业务范围**：记录选择、目标层级/插入位置、字段映射、请求预览、真实推送、日志和状态。
5. **对应前端目录**：`src/renderer/src/App.tsx` 的 `PushPage`。
6. **对应后端目录**：`src/main/visslm.ts`。
7. **页面入口**：侧栏“数据推送”，默认功能开关关闭。
8. **前端路由**：`PageKey='push'`；内部 Tab `config/logs`。
9. **API 列表**：`data:records`、`push:preview/start/logs`。
10. **Controller**：`src/main/index.ts:841-845`。
11. **Service**：`PushService`、`VisslmClient`。
12. **DAO**：`beginPushLog/finishPushLog/listPushLogs/markPushResult/getRecord`。
13. **数据表**：`records`、`push_logs`。
14. **核心流程**：选择记录 -> 填目标参数/映射 -> PushService.preview -> 用户确认 -> PushService.push 逐条 POST -> 写日志/更新记录状态。
15. **状态变化**：记录 pending/success/failed；日志 sending/success/failed。
16. **业务规则**：只允许 POST；本地 `_valm_Uid/_valm_NodeType/_valm_ItemID` 不进入新记录 body；预览不写日志/不发请求。
17. **权限点**：无；平台凭据权限由外部 API 决定。
18. **异常处理**：单条失败不应阻断其他条目（实现需以 `PushService.push` smoke 为准）；失败记录 error message 和 response。
19. **依赖模块**：资产中心、设置、数据概览。
20. **外部依赖**：VISSLM `/alm/rest/items` POST。
21. **扩展点**：幂等键、批量 API、重试/撤销、推送模板、审批和脱敏。
22. **已知问题**：没有统一推送权限/审批和可配置重试；日志可能含业务 payload。
23. **代码依据**：`visslm.ts:222-240,511-672`、`App.tsx:2800-3365`、`shared/types.ts:216-275`、`database.ts:4325-4444`。

## M-10 系统配置与基础设施

1. **模块名称**：系统配置和应用基础设施。
2. **模块编号**：M-10。
3. **模块目标**：统一保存平台、模型、模块、导航和采集配置，并提供安全的窗口/运行时初始化。
4. **业务范围**：设置页面、默认值、safeStorage、单实例、应用目录、服务装配。
5. **对应前端目录**：`src/renderer/src/App.tsx` 的 `SettingsPage`、`WindowTitleBar`。
6. **对应后端目录**：`src/main/settings.ts`、`src/main/index.ts`、`src/main/database.ts`。
7. **页面入口**：侧栏“系统配置”；窗口控制在标题栏。
8. **前端路由**：`PageKey='settings'`，内部 Tab `platform/model/features`。
9. **API 列表**：`settings:get/save-platform/save-model/save-features/save-navigation-order`、连接测试、窗口通道。
10. **Controller**：`src/main/index.ts:123-154`。
11. **Service**：`SettingsService`；Electron `safeStorage`。
12. **DAO**：`AppDatabase.getSetting/setSetting`；迁移在 `AppDatabase.migrate`。
13. **数据表**：`settings`；应用数据目录和 `assets` 文件系统。
14. **核心流程**：应用 ready -> 初始化 DB/settings/services -> 前端 getSettings -> 测试模型 -> 用户编辑/保存 -> 返回脱敏 settings。
15. **状态变化**：配置 key/value 更新；navigation version=1；窗口最大化事件。
16. **业务规则**：秘密只在用户输入时更新；密钥密文不返回；未知导航/损坏配置回退默认。
17. **权限点**：无应用管理员身份；当前本机用户可修改全部配置。
18. **异常处理**：safeStorage 不可用时当前实现返回空 secret/写入空字符串策略需验证；数据库关闭时服务不可用。
19. **依赖模块**：所有业务模块依赖设置返回的 credentials/model/features。
20. **外部依赖**：Electron safeStorage、Windows userData。
21. **扩展点**：环境配置、迁移版本、导入导出/加密策略、企业策略。
22. **已知问题**：数据库 migration 无版本表，采用多条 `ALTER TABLE` try/catch；不同历史 schema 可能难以诊断。
23. **代码依据**：`settings.ts:1-221`、`index.ts:848-902`、`database.ts:452-1040`、`App.tsx:3371-3855`。

## 代码依据索引

模块共用证据：`docs/01-code-mapping.md` 的 IPC/服务/表映射；`docs/05-database-design.md` 的表结构；`docs/06-api-design.md` 的调用契约；具体实现见上述模块条目列出的文件和行区间。
