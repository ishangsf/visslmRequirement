# 06 API 设计

> 最后分析时间：2026-08-01（Asia/Singapore）  
> 代码基线：Git `9bab57fc5166770784c1855857a6e1a8ebaa6200`；当前工作树存在未提交修改。  
> 关联文档：[00 项目扫描](./00-project-scan.md)、[01 代码映射](./01-code-mapping.md)、[02 需求](./02-requirements.md)、[04 模块设计](./04-module-design.md)、[05 数据库设计](./05-database-design.md)

## 1. 接口边界和统一约定

本项目没有面向浏览器或第三方调用者的 HTTP Controller。当前“API”是 renderer 通过 `contextBridge` 使用的本地 Electron IPC 方法：

```text
React 页面 -> window.visslm -> preload/index.ts -> ipcRenderer.invoke(channel)
  -> main/index.ts ipcMain.handle(channel) -> Service/AppDatabase -> SQLite/外部 HTTP
```

代码依据：`src/preload/index.ts:1-245`、`src/main/index.ts:122-846`。

| 项目 | 约定 |
| --- | --- |
| 请求方法/路径 | IPC 没有 HTTP method/path；使用 channel 名和 `invoke` 参数顺序。外部 HTTP 端点另列于第 4 节 |
| 请求头 | IPC 无请求头；外部模型/VISSLM 请求由主进程服务设置 `Content-Type`、Authorization 或查询认证参数 |
| 权限 | 没有用户登录、RBAC 或 IPC caller 身份校验；本机打开应用的用户可调用已暴露方法。功能开关只控制导航显示和进入页面 |
| 成功返回 | 由 `shared/types.ts`、`shared/project-types.ts`、`shared/dashboard.ts` 定义的对象；操作类接口通常返回 `{ok, message}` 或 `Promise` rejection |
| 失败返回 | 没有统一 machine-readable error envelope。部分流程返回 `ok:false`，参数、数据库、网络和模型错误直接抛出 `Error`，renderer 以 `catch`/Ant Design message 展示 |
| 脱敏 | VISSLM URL 查询中的 `ApiToken` 在 trace/log 中替换为 `******`；设置返回只返回 `hasToken/hasApiKey`，不返回秘密值 |
| 事件 | `window:maximized-changed`、`sync:progress`、`knowledge:progress`、`project:progress`、`agent:event` 使用 IPC event，不是 `invoke` 请求 |
| 请求规模 | 记录、日志、文档、项目需求和任务查询由各自 query 的 page/pageSize 控制；部分限制在 service/DB 内 clamp |

## 2. IPC API 总表

下表的“调用页面”是对 renderer 静态调用的归纳；公共 preload 定义位于 `src/preload/index.ts` 对应行。没有调用页面的接口会标记“可能未使用”。

### 2.1 窗口和系统配置

| 编号 | IPC channel / preload 方法 | 请求参数 | 响应与错误 | 调用页面；Handler / Service / 表 |
| --- | --- | --- | --- | --- |
| API-IPC-001 | `window:minimize` / `minimizeWindow` | 无 | `Promise<void>`；窗口未初始化时由 Electron 行为决定 | 全局 `WindowTitleBar`：`App.tsx:3813-3850`；`index.ts:123` / BrowserWindow；无表 |
| API-IPC-002 | `window:toggle-maximize` / `toggleMaximizeWindow` | 无 | `Promise<boolean>`，返回调用后最大化状态 | `WindowTitleBar`；`index.ts:124-128` / BrowserWindow；无表 |
| API-IPC-003 | `window:close` / `closeWindow` | 无 | `Promise<void>` | `WindowTitleBar`；`index.ts:129` / BrowserWindow；无表 |
| API-IPC-004 | `window:is-maximized` / `isWindowMaximized` | 无 | `Promise<boolean>` | `WindowTitleBar`；`index.ts:130` / BrowserWindow；无表 |
| API-IPC-005 | `settings:get` / `getSettings` | 无 | `AppSettings`；配置损坏时导航/同步配置回退默认值 | `AppShell`、`SettingsPage`：`App.tsx:3910,3371-3855`；`index.ts:132` / `SettingsService.getAll`；`settings` |
| API-IPC-006 | `settings:save-platform` / `savePlatformSettings` | `PlatformSettingsInput {baseUrl, username, token?}` | `AppSettings`；safeStorage 不可用时 rejection | `SettingsPage`；`index.ts:133-135` / `SettingsService.savePlatform`；`settings` |
| API-IPC-007 | `settings:save-model` / `saveModelSettings` | `ModelSettings`；online 时 apiKey 可选且仅非空时更新 | `AppSettings`；未保存 API Key 不会被清空是当前实现行为 | `SettingsPage`；`index.ts:136-138` / `SettingsService.saveModel`；`settings` |
| API-IPC-008 | `settings:save-features` / `saveFeatureSettings` | `FeatureModuleSettings` | `AppSettings`；键由固定 feature key 集合写入 | `SettingsPage`；`index.ts:139-141` / `SettingsService.saveFeatures`；`settings` |
| API-IPC-009 | `settings:save-navigation-order` / `saveNavigationOrder` | `FeatureNavigationOrder` | `AppSettings`；未知/重复键被归一化，版本不匹配回默认 | `SettingsPage`；`index.ts:142-144` / `SettingsService.saveNavigationOrder`；`settings` |
| API-IPC-010 | `connections:test-platform` / `testPlatform` | 可选 `PlatformSettingsInput`，允许测试未保存值 | `ConnectionResult {ok,message,details?}`；VISSLM HTTP/业务错误转为 `ok:false` | `SettingsPage`；`index.ts:146-150` / `VisslmClient.test`；外部 VISSLM |
| API-IPC-011 | `connections:test-model` / `testModel` | 可选 `ModelSettings`，允许测试未保存值 | `ConnectionResult`；缺 API Key、模型不存在、HTTP 错误为 `ok:false` | `SettingsPage`、`AppShell`；`index.ts:151-154` / `OllamaAgent.test -> ModelClient.test`；外部模型服务 |

### 2.2 数据中心、采集、同步和数据传输

| 编号 | IPC channel / preload 方法 | 请求参数 | 响应与错误 | 调用页面；Handler / Service / 表 |
| --- | --- | --- | --- | --- |
| API-IPC-012 | `data:projects` / `listProjects` | 无 | `ProjectRow[]` | `DataPage`：`App.tsx:513`；`index.ts:156` / `AppDatabase.listProjects`；`projects`,`records` |
| API-IPC-013 | `data:node-types` / `listNodeTypes` | 无 | `string[]` | `DataPage`：`App.tsx:513`；`index.ts:157` / `AppDatabase.listNodeTypes`；`records` |
| API-IPC-014 | `data:records` / `listRecords` | `RecordQuery {page,pageSize,search?,projectId?,nodeType?}` | `RecordPage {rows,total}`；SQL/参数错误 rejection | `DataPage`、项目资产选择器：`App.tsx:513-650`、`ProjectManagementPage.tsx:2111,2949`；`index.ts:158` / DB；`records`,`images` |
| API-IPC-015 | `data:record` / `getRecord` | `uid: string` | `RecordDetail|null`；不存在返回 null | 数据详情、项目匹配/资产详情：`App.tsx:526`、`App.tsx:1361`、`ProjectManagementPage.tsx:2225`；`index.ts:159` / DB；`records`,`images` |
| API-IPC-016 | `data:stats` / `getStats` | 无 | `DashboardStats`；空库返回 0 和空分组 | `DashboardPage`、DashboardStudio；`index.ts:160` / DB；`projects`,`records`,`images` |
| API-IPC-017 | `sync:get-config` / `getSyncConfig` | 无 | `SyncScopeConfig|null`；版本/JSON 损坏返回 null | `SyncPage`：`App.tsx:2084`；`index.ts:161` / `SettingsService.getSyncConfig`；`settings` |
| API-IPC-018 | `sync:save-config` / `saveSyncConfig` | `SyncScopeConfig {selectedTypes,rules}` | `Promise<void>`；至少选择一种类型否则 rejection | `SyncPage`：`App.tsx:2256`；`index.ts:162-164` / `SettingsService.saveSyncConfig`；`settings` |
| API-IPC-019 | `sync:preview` / `previewSync` | 可选 `SyncScopeConfig` | `SyncPreviewResult`，含扫描数、匹配数、样例和脱敏请求；连接/字段非法 rejection | `SyncPage`：`App.tsx:2272`；`index.ts:165-169` / `VisslmClient.previewScope`；外部 VISSLM、`settings` |
| API-IPC-020 | `sync:start` / `startSync` | 可选 `SyncScopeConfig` | `SyncResult {ok,projectCount,recordCount,imageCount,message}`；运行中、连接失败或平台错误可能返回 `ok:false`，配置错误可 rejection | `AppShell`/`SyncPage`：`App.tsx:2290,3941`；`index.ts:170-177` / `SyncService.run`；`sync_runs`,`projects`,`records`,`images` |
| API-IPC-021 | `sync:request-logs` / `listCollectionRequestLogs` | `page?: number,pageSize?: number` | `CollectionRequestLogPage`；分页参数由 DB clamp | `SyncPage`：`App.tsx:2104`；`index.ts:179-181` / DB；`collection_request_logs` |
| API-IPC-022 | `data:import` / `importData` | 无；handler 弹出文件选择框，接受 `.jsonl/.json`，最大 512 MB | `DataImportResult`；文件解析、行错误最多积累 50 条；完成后重建记录索引并标记项目匹配 stale | `DataPage`：`App.tsx:532`；`index.ts:558-615` / DB + KnowledgeService + ProjectManagementService；`records`,`images`,`projects` |
| API-IPC-023 | `data:export` / `exportData` | 无；handler 弹出保存框 | `DataExportResult`；取消返回 `ok:false,canceled:true`；文件写入失败 rejection | `DataPage`：`App.tsx:561`；`index.ts:517-556` / DB；`records`,`images`,`dashboard_audit_logs` |
| API-IPC-024 | `data:delete` / `deleteData` | `uids?: string[]`；省略表示删除全部 | `DataDeleteResult`；删除后重建记录索引并标记匹配 stale | `DataPage`：`App.tsx:585`；`index.ts:617-621` / DB + 两个服务；`records`,`images`,`knowledge_chunks`,`pm_project_assets`,`pm_requirement_matches` |

### 2.3 AI 助手、会话和分析查询

| 编号 | IPC channel / preload 方法 | 请求参数 | 响应与错误 | 调用页面；Handler / Service / 表 |
| --- | --- | --- | --- | --- |
| API-IPC-025 | `agent:ask` / `askAgent` | `ChatRequest {question,projectId?,conversationId?,expertId?,entrypoint?,dataScope?,activeArtifact?,history?}` | `ChatResponse {answer,sources,dataViews,expertId?,dashboard?,events?}`；可视化无数据时返回 event code `NO_ANALYTICS_DATA`，模型/查询校验失败 rejection | `ChatPage`：`App.tsx:1407`；`index.ts:190-265` / `ExpertRouter`、`VisualizationAgent` 或 `OllamaAgent`；`records`,`knowledge_*`,`visualization_runs` |
| API-IPC-026 | `chat:sessions` / `listChatSessions` | `limit?: number` | `ChatSessionSummary[]` | `ChatPage`：`App.tsx` 会话历史；`index.ts:182` / DB；`chat_sessions` |
| API-IPC-027 | `chat:session` / `getChatSession` | `id: string` | `ChatSession|null` | `ChatPage` 加载历史；`index.ts:183` / DB；`chat_sessions` |
| API-IPC-028 | `chat:save-session` / `saveChatSession` | `ChatSessionSaveInput {id,title?,messages}` | `ChatSession`；消息结构会被清洗/截断 | `ChatPage`；`index.ts:184-186` / DB；`chat_sessions` |
| API-IPC-029 | `chat:delete-session` / `deleteChatSession` | `id: string` | `ChatSessionDeleteResult` | `ChatPage`；`index.ts:187-189` / DB；`chat_sessions` |
| API-IPC-030 | `analytics:field-profiles` / `listFieldProfiles` | `DataScope?` | `FieldProfile[]`；无记录返回空数组 | `DashboardStudio`：`DashboardStudio.tsx:345,907`；`index.ts:266-268` / `QueryEngine.profile`；`records`,`field_profiles` |
| API-IPC-031 | `analytics:field-profile-semantics` / `saveFieldProfileSemantics` | `scope,field,patch {displayName?,role?,synonyms?,sensitivity?}` | `FieldProfile|null`；非法 role/sensitivity 或字段不存在时 rejection/null | **renderer 当前未找到调用，可能未使用**；preload `index.ts:104-107`，handler `index.ts:269-273` / DB；`field_profiles` |
| API-IPC-032 | `analytics:execute-query` / `executeQuery` | `QuerySpec`：最多 8 指标、2 维度、12 filters、limit 1-500 | `QueryDataset {columns,rows,scannedRows,matchedRows,truncated,elapsedMs}`；validator rejection | `DashboardStudio`：`DashboardStudio.tsx:373,413`；`index.ts:274-275` / `QueryEngine.execute`；`records`,`field_profiles`,`query_cache` |

### 2.4 Dashboard 与可视化专家工作台

| 编号 | IPC channel / preload 方法 | 请求参数 | 响应与错误 | 调用页面；Handler / Service / 表 |
| --- | --- | --- | --- | --- |
| API-IPC-033 | `dashboards:list` / `listDashboards` | 无 | `DashboardSummary[]` | `DashboardStudio`：`DashboardStudio.tsx:279,283`；`index.ts:277` / DB；`dashboards` |
| API-IPC-034 | `dashboards:get` / `getDashboard` | `id:string,version?:number` | `DashboardVersion|null`；省略 version 取 current | `DashboardStudio`：`DashboardStudio.tsx:756`；`index.ts:278-280` / DB；`dashboards`,`dashboard_versions` |
| API-IPC-035 | `dashboards:versions` / `listDashboardVersions` | `id:string` | 按版本倒序的 `DashboardVersion[]` | `DashboardStudio`：`DashboardStudio.tsx:775`；`index.ts:281-283` / DB；`dashboard_versions` |
| API-IPC-036 | `dashboards:save` / `saveDashboard` | `DashboardSaveInput {spec,changeSummary}` | `DashboardVersion`；validator 不通过 rejection并写失败审计 | `DashboardStudio`：`DashboardStudio.tsx:738`；`index.ts:284-309` / validator + DB + audit；`dashboards`,`dashboard_versions`,`dashboard_audit_logs` |
| API-IPC-037 | `dashboards:restore` / `restoreDashboard` | `id:string,version:number` | 新生成的 `DashboardVersion`；源版本不存在 rejection并写失败审计 | `DashboardStudio`：`DashboardStudio.tsx:810`；`index.ts:310-330` / DB + audit；`dashboard_versions`,`dashboard_audit_logs` |
| API-IPC-038 | `dashboards:diagnose` / `diagnoseDashboard` | `DashboardSpec` | `DashboardQualityReport`；每个组件 QuerySpec 执行异常会形成问题或 rejection并审计 | `DashboardStudio`：`DashboardStudio.tsx:795`；`index.ts:332-354` / `diagnoseDashboard` + QueryEngine；`records`,`query_cache`,`dashboard_audit_logs` |
| API-IPC-039 | `dashboards:runs` / `listVisualizationRuns` | `limit?:number`，DB 最大 100 | `VisualizationRun[]` | `DashboardStudio`：`DashboardStudio.tsx:796`；`index.ts:356-358` / DB；`visualization_runs` |
| API-IPC-040 | `dashboards:audit-logs` / `listDashboardAuditLogs` | `dashboardId?:string,limit?:number`，DB 最大 200 | `DashboardAuditLog[]`；metadata 可含稳定 `specHash`，组件修复可同时含 `sourceSpecHash` | `DashboardStudio`：`DashboardStudio.tsx:783`；`index.ts:359-361` / DB；`dashboard_audit_logs` |
| API-IPC-041 | `dashboards:export-json` / `exportDashboardJson` | `spec:DashboardSpec,version?:number` | `DashboardExportResult`；取消为 `ok:false`，校验/写文件失败 rejection | `DashboardStudio`：`DashboardStudio.tsx:846`；`index.ts:362-404` / validator + dialog + fs + audit；`dashboard_audit_logs` |
| API-IPC-042 | `dashboards:export-pdf` / `exportDashboardPdf` | `spec,version?` | `DashboardExportResult`；使用当前主窗口 `printToPDF`，取消/失败同上 | `DashboardStudio`：`DashboardStudio.tsx:847`；`index.ts:405-454` / BrowserWindow + audit；`dashboard_audit_logs` |
| API-IPC-043 | `dashboards:export-png` / `exportDashboardPng` | `spec,dataUrl,version?`；只接受 PNG data URL，最大 50 MB | `DashboardExportResult`；PNG signature 无效 rejection | `DashboardStudio`：`DashboardStudio.tsx:843`；`index.ts:455-515` / fs + audit；`dashboard_audit_logs` |

### 2.5 推送

| 编号 | IPC channel / preload 方法 | 请求参数 | 响应与错误 | 调用页面；Handler / Service / 表 |
| --- | --- | --- | --- | --- |
| API-IPC-044 | `push:preview` / `previewPush` | `PushConfig {recordUids,nodeType,projectId,componentId?,parentId?,insertAfterId?,insertBeforeId?,fieldMappings?}` | `PushResult`，`preview:true`，每条 request 显示脱敏参数和“未发送 POST”响应 | `PushPage`：`App.tsx:2920`；`index.ts:841` / `PushService.preview`；`records` |
| API-IPC-045 | `push:start` / `startPush` | 同 `PushConfig`；目标 field key、重复映射和保留字段会校验 | `PushResult`，逐条统计成功/失败；单条失败继续处理其他记录 | `PushPage`：`App.tsx:2955`；`index.ts:842` / `PushService.push -> VisslmClient.createItem`；`records`,`push_logs` |
| API-IPC-046 | `push:logs` / `listPushLogs` | `page?:number,pageSize?:number` | `PushLogPage`；日志 body/response 可能含业务敏感数据 | `PushPage`：`App.tsx:2843`；`index.ts:843-845` / DB；`push_logs` |

### 2.6 知识库

| 编号 | IPC channel / preload 方法 | 请求参数 | 响应与错误 | 调用页面；Handler / Service / 表 |
| --- | --- | --- | --- | --- |
| API-IPC-047 | `knowledge:documents` / `listKnowledgeDocuments` | `KnowledgeDocumentQuery {page,pageSize,search?,status?,extension?,tag?}` | `KnowledgeDocumentPage` | `KnowledgeBasePage`：`App.tsx:869`；`index.ts:623-625` / DB；`knowledge_documents` |
| API-IPC-048 | `knowledge:document` / `getKnowledgeDocument` | `id:string` | `KnowledgeDocumentDetail|null`，含 chunks | `KnowledgeBasePage`、聊天引用：`App.tsx:912,1369`；`index.ts:626` / DB；`knowledge_documents`,`knowledge_chunks` |
| API-IPC-049 | `knowledge:document-preview` / `getKnowledgeDocumentPreview` | `id:string` | `KnowledgeDocumentPreview|null`；只对 PDF 读取 Base64，文件不存在/空/超过 50 MB 返回 errorMessage | 项目协议详情：`ProjectManagementPage.tsx:2239`；`index.ts:627-641` / fs + DB；`knowledge_documents` |
| API-IPC-050 | `knowledge:upload` / `uploadKnowledgeDocuments` | 无；handler 弹出多选文件框，支持 docx/pdf/xlsx/xls/txt | `KnowledgeUploadResult`；单文件最大 100 MB、hash 重复复用、解析/签名/embedding 失败记录 failed | `KnowledgeBasePage`：`App.tsx:892`；`index.ts:643-665` / `KnowledgeService.processFiles`；`knowledge_documents`,`knowledge_chunks`,`knowledge_vectors`,`knowledge_index_tasks` |
| API-IPC-051 | `knowledge:retry` / `retryKnowledgeDocument` | `id:string` | `KnowledgeDocument|null`；不存在返回 null，处理失败返回 failed 文档 | `KnowledgeBasePage`：`App.tsx:922`；`index.ts:666` / `KnowledgeService.retryDocument`；知识库四表 |
| API-IPC-052 | `knowledge:tags` / `updateKnowledgeDocumentTags` | `id:string,tags:string[]` | `KnowledgeDocument|null`；标签 trim、去重、最多 20 个 | `KnowledgeBasePage`：`App.tsx:961`；`index.ts:667-669` / Service + DB；`knowledge_documents` |
| API-IPC-053 | `knowledge:delete` / `deleteKnowledgeDocument` | `id:string` | `{ok:boolean,message:string}`；不存在返回 `ok:false` | `KnowledgeBasePage`：`App.tsx:938`；`index.ts:670` / Service + DB/fs；文档、分块、向量、项目文档关联 |
| API-IPC-054 | `knowledge:rebuild` / `rebuildKnowledgeIndex` | 无 | `KnowledgeRebuildResult`；embedding 资源不可用 rejection | `KnowledgeBasePage`：`App.tsx:949`；`index.ts:671` / `KnowledgeService.rebuildIndex`；`knowledge_chunks`,`knowledge_vectors` |
| API-IPC-055 | `knowledge:stats` / `getKnowledgeStats` | 无 | `KnowledgeStats` | `KnowledgeBasePage`：`App.tsx:870`；`index.ts:672` / DB；`knowledge_documents`,`knowledge_chunks`,`knowledge_vectors` |

### 2.7 项目管理、需求、匹配、成本和资产

| 编号 | IPC channel / preload 方法 | 请求参数 | 响应与错误 | 调用页面；Handler / Service / 表 |
| --- | --- | --- | --- | --- |
| API-IPC-056 | `projects:list` / `listManagedProjects` | `ManagedProjectListQuery {page,pageSize,search?}` | `ManagedProjectPage`；查询参数由 DB 处理 | `ProjectManagementPage`：`ProjectManagementPage.tsx:2981`；`index.ts:673-675` / ProjectManagementService + DB；`pm_projects` 及派生子表 |
| API-IPC-057 | `projects:get` / `getManagedProject` | `id:string` | `ManagedProject|null`，含派生需求/成本/资产/任务统计 | `ProjectDetail`：`ProjectManagementPage.tsx:1780`；`index.ts:676` / Service + DB；`pm_projects` |
| API-IPC-058 | `projects:documents` / `listManagedProjectDocuments` | `projectId:string` | `ProjectDocumentSnapshot[]` | `ProjectDetail`；`index.ts:677` / DB；`pm_project_documents`,`knowledge_documents` |
| API-IPC-059 | `projects:create` / `createManagedProject` | `ManagedProjectInput`；项目名必填 | `ManagedProject`；非法输入 rejection | 项目列表创建；`index.ts:678-680` / Service + DB；`pm_projects` |
| API-IPC-060 | `projects:update` / `updateManagedProject` | `id:string,ManagedProjectInput` | `ManagedProject|null` | 项目编辑；`index.ts:681-683` / Service + DB；`pm_projects` |
| API-IPC-061 | `projects:delete` / `deleteManagedProject` | `id:string` | `{ok,message}`；processing 项目禁止删除 | 列表/详情；`index.ts:684` / Service + DB；项目级级联表 |
| API-IPC-062 | `projects:export-data` / `exportManagedProjectData` | `id:string`；弹出 JSON 保存框 | `ProjectDataTransferResult`；不存在/取消/文件失败返回失败对象 | 项目详情；`index.ts:753-775` / Service + fs；项目关联的全部 `pm_*` 及文档快照 |
| API-IPC-102 | `projects:export-excel` / `exportManagedProjectExcel` | `id:string`；弹出 `.xlsx` 保存框 | `ProjectDataTransferResult`；生成 9 个工作表，取消/项目不存在/文件失败返回失败对象 | 项目详情“导出 Excel”；`index.ts:777-805` / `createProjectWorkbook` + `xlsx`；项目快照中的项目、协议、人员、参与人、成本、资产、计划、需求、匹配 |
| API-IPC-063 | `projects:import-data` / `importManagedProjectData` | 无；弹出 JSON 文件，最大 512 MB | `ProjectDataTransferResult`；格式必须 `format:'visslm-project',version:1`，部分关联可通过 warnings 跳过 | 项目列表；`index.ts:807-828` / Service + DB；项目管理全部表 |
| API-IPC-064 | `projects:discard-draft` / `discardManagedProjectDraft` | `id:string` | `{ok,message}` | **renderer 当前未找到调用，可能未使用**；`index.ts:731-733` / Service + DB；`pm_projects`、review 需求 |
| API-IPC-065 | `projects:upload-agreement` / `startProjectTechnicalAgreementUpload` | `projectId?:string,options?:{allowExternalProcessing?:boolean}`；handler 选择 docx/pdf/xlsx/xls/txt | `ProjectAnalysisStartResult`；在线模型未确认外发、格式不支持、项目任务运行中返回失败对象 | 项目列表/详情；`index.ts:735-745` / `ProjectManagementService.startTechnicalAgreement`；知识库、`pm_projects`,`pm_project_documents`,`pm_requirement_sets`,`pm_requirements`,`pm_analysis_runs` |
| API-IPC-066 | `projects:confirm` / `confirmManagedProject` | `id:string` | `ManagedProject|null`；有需求时可能异步启动匹配 | 项目详情；`index.ts:734` / Service + DB；`pm_projects`,`pm_requirements` |
| API-IPC-067 | `projects:retry-analysis` / `retryProjectAnalysis` | `id:string` | `ProjectAnalysisStartResult`；只允许 failed 且有 current document；online 模型要求重新上传确认 | 项目详情；`index.ts:746` / Service；知识库和项目分析表 |
| API-IPC-068 | `projects:start-matching` / `startProjectMatching` | `id:string` | `ProjectAnalysisStartResult`；没有已发布需求或有审核版本时失败 | 项目详情；`index.ts:747` / Service 异步匹配；`pm_projects`,`pm_requirement_matches`,`pm_analysis_runs` |
| API-IPC-069 | `projects:requirements` / `listProjectRequirements` | `ProjectRequirementQuery {projectId,page,pageSize,scope?:active|published}` | `ProjectRequirementPage` | `ProjectDetail`；`index.ts:748-750` / DB；`pm_requirements` |
| API-IPC-070 | `projects:requirement-set` / `getProjectRequirementSet` | `projectId:string` | `ProjectRequirementSetSummary|null` | `ProjectDetail`：`ProjectManagementPage.tsx:1782`；`index.ts:751-753` / DB；`pm_requirement_sets`,`pm_requirements` |
| API-IPC-071 | `projects:requirement-create` / `createProjectRequirement` | `projectId:string,ProjectRequirementInput` | `ProjectRequirement`；只能创建审核版本内需求 | `ProjectDetail`；`index.ts:754-756` / Service + DB；`pm_requirements` |
| API-IPC-072 | `projects:requirement-update` / `updateProjectRequirement` | `id:string,ProjectRequirementInput` | `ProjectRequirement|null` | `ProjectDetail`；`index.ts:757-759` / Service + DB；`pm_requirements` |
| API-IPC-073 | `projects:requirement-split` / `splitProjectRequirement` | `id:string,{parts:ProjectRequirementInput[]}`；至少两部分 | `ProjectRequirement[]`；非法或已发布需求 rejection | `ProjectDetail`；`index.ts:760-762` / Service + DB；`pm_requirements` |
| API-IPC-074 | `projects:requirement-merge` / `mergeProjectRequirements` | `{requirementIds:string[]} + ProjectRequirementInput` | `ProjectRequirement|null`；合并目标需属于同一审核版本 | `ProjectDetail`；`index.ts:763-765` / Service + DB；`pm_requirements` |
| API-IPC-075 | `projects:requirement-review` / `reviewProjectRequirements` | `ids:string[],status:'pending'|'approved'|'rejected'` | `{ok,message}`；状态非法或无可更新项返回失败对象 | `ProjectDetail`；`index.ts:766-768` / Service + DB；`pm_requirements` |
| API-IPC-076 | `projects:requirements-publish` / `publishProjectRequirements` | `projectId:string` | `ProjectAnalysisStartResult`；active 项目发布后可能自动启动匹配 | `ProjectDetail`；`index.ts:769-771` / Service + DB；`pm_requirement_sets`,`pm_requirements`,`pm_projects` |
| API-IPC-077 | `projects:requirement-delete` / `deleteProjectRequirement` | `id:string` | `{ok,message}`；已发布需求不能直接删除 | `ProjectDetail`；`index.ts:772-774` / Service + DB；`pm_requirements`,`pm_requirement_matches` |
| API-IPC-078 | `projects:requirement-status` / `updateProjectRequirementStatus` | `id:string,status:'unmarked'|'satisfied'|'to_develop'|'to_negotiate'` | `ProjectRequirement|null`；更新为人工来源 | `ProjectDetail`；`index.ts:775-777` / Service + DB；`pm_requirements` |
| API-IPC-079 | `projects:requirement-key-info-terms` / `updateProjectRequirementKeyInfoTerms` | `id:string,terms:string[]` | `ProjectRequirement|null`；trim/去重/最多 12 个 | `ProjectDetail`；`index.ts:778-780` / Service + DB；`pm_requirements` |
| API-IPC-080 | `projects:start-requirement-matching` / `startProjectRequirementMatching` | `requirementId:string` | `ProjectAnalysisStartResult`；待审核版本或项目有任务运行时失败 | `ProjectDetail`；`index.ts:781-783` / Service 异步；`pm_requirements`,`pm_requirement_matches` |
| API-IPC-081 | `projects:matches` / `listProjectRequirementMatches` | `ProjectRequirementMatchQuery {requirementId,page,pageSize}` | `ProjectRequirementMatchPage`；按 final score 倒序 | 匹配明细抽屉：`ProjectManagementPage.tsx:741`；`index.ts:784-786` / DB；`pm_requirement_matches`,`records`,`pm_project_assets` |
| API-IPC-082 | `projects:costs` / `listProjectCostEntries` | `projectId:string` | `ProjectCostEntry[]` | 项目详情；`index.ts:787` / DB；`pm_cost_entries` |
| API-IPC-083 | `projects:cost-add` / `addProjectCostEntry` | `projectId:string,ProjectCostEntryInput` | `ProjectCostEntry`；金额/日期/责任人校验 | 项目详情；`index.ts:788-790` / Service + DB；`pm_cost_entries`,`pm_project_participants` |
| API-IPC-084 | `projects:cost-update` / `updateProjectCostEntry` | `id:string,ProjectCostEntryInput` | `ProjectCostEntry|null` | 项目详情；`index.ts:791-793` / Service + DB；`pm_cost_entries` |
| API-IPC-085 | `projects:cost-delete` / `deleteProjectCostEntry` | `id:string` | `{ok,message}` | 项目详情；`index.ts:794` / Service + DB；`pm_cost_entries` |
| API-IPC-086 | `projects:assets` / `listProjectAssets` | `projectId:string` | `ProjectAsset[]` | 项目详情；`index.ts:795` / Service + DB；`pm_project_assets`,`records` |
| API-IPC-087 | `projects:asset-link` / `linkProjectAsset` | `projectId:string,recordUid:string` | `ProjectAsset|null`；记录不存在/重复时由 DB/Service 返回 | 项目详情；`index.ts:796-798` / Service + DB；`pm_project_assets`,`records` |
| API-IPC-088 | `projects:asset-unlink` / `unlinkProjectAsset` | `projectId:string,recordUid:string` | `{ok,message}` | 项目详情；`index.ts:799-800` / Service + DB；`pm_project_assets` |
| API-IPC-089 | `projects:participants` / `listProjectParticipants` | `projectId:string` | `ProjectParticipant[]` | 项目详情；`index.ts:814-816` / Service + DB；`pm_project_participants`,`org_people` |
| API-IPC-090 | `projects:participant-add` / `addProjectParticipant` | `projectId:string,ProjectParticipantInput` | `ProjectParticipant`；人员必须存在，同项目同人唯一 | 项目详情；`index.ts:817-819` / Service + DB；`pm_project_participants`,`org_people` |
| API-IPC-091 | `projects:participant-update` / `updateProjectParticipant` | `id:string,ProjectParticipantInput` | `ProjectParticipant|null` | 项目详情；`index.ts:820-822` / Service + DB；`pm_project_participants` |
| API-IPC-092 | `projects:participant-delete` / `deleteProjectParticipant` | `id:string` | `{ok,message}` | 项目详情；`index.ts:823-825` / Service + DB；`pm_project_participants` |
| API-IPC-093 | `projects:tasks` / `listProjectTasks` | `projectId:string` | `ProjectPlanTask[]`，含 depth/hasChildren | 项目详情；`index.ts:826-828` / Service + DB；`pm_project_tasks`,`org_people` |
| API-IPC-094 | `projects:task-add` / `addProjectTask` | `projectId:string,ProjectPlanTaskInput` | `ProjectPlanTask`；父任务和负责人必须属于项目/组织 | 项目详情；`index.ts:829-831` / Service + DB；`pm_project_tasks` |
| API-IPC-095 | `projects:task-update` / `updateProjectTask` | `id:string,ProjectPlanTaskInput` | `ProjectPlanTask|null`；禁止自引用/跨项目父任务 | 项目详情；`index.ts:832-834` / Service + DB；`pm_project_tasks` |
| API-IPC-096 | `projects:task-move` / `moveProjectTask` | `id:string,{parentTaskId?,sortOrder?}` | `ProjectPlanTask|null`；更新层级/顺序 | 项目计划拖拽：`ProjectManagementPage.tsx:2198`；`index.ts:835-837` / Service + DB；`pm_project_tasks` |
| API-IPC-097 | `projects:task-delete` / `deleteProjectTask` | `id:string` | `{ok,message}`；子任务由自引用 FK `SET NULL` 处理 | 项目详情；`index.ts:838-840` / Service + DB；`pm_project_tasks` |

### 2.8 组织人员

| 编号 | IPC channel / preload 方法 | 请求参数 | 响应与错误 | 调用页面；Handler / Service / 表 |
| --- | --- | --- | --- | --- |
| API-IPC-098 | `organization:people` / `listOrganizationPeople` | `OrganizationPersonListQuery {page,pageSize,search?,status?}` | `OrganizationPersonPage` | 项目管理人员面板；`index.ts:802-804` / Service + DB；`org_people` |
| API-IPC-099 | `organization:person-create` / `createOrganizationPerson` | `OrganizationPersonInput`；姓名必填 | `OrganizationPerson` | 人员面板；`index.ts:805-807` / Service + DB；`org_people` |
| API-IPC-100 | `organization:person-update` / `updateOrganizationPerson` | `id:string,input` | `OrganizationPerson|null` | 人员面板；`index.ts:808-810` / Service + DB；`org_people` |
| API-IPC-101 | `organization:person-delete` / `deleteOrganizationPerson` | `id:string` | `{ok,message}`；已有项目参与关系时因 `ON DELETE RESTRICT` 不能删除 | 人员面板；`index.ts:811-813` / Service + DB；`org_people`,`pm_project_participants` |

## 3. 事件接口

| 编号 | Event channel / preload 订阅 | payload | 发送位置和用途 |
| --- | --- | --- | --- |
| API-EVT-001 | `window:maximized-changed` / `onWindowMaximized` | `boolean` | `BrowserWindow` maximize/unmaximize：`index.ts:101-106`；标题栏更新状态 |
| API-EVT-002 | `sync:progress` / `onSyncProgress` | `SyncProgress {phase,message,current,total}` | `SyncService` 回调：`index.ts:875-879`；采集页进度和错误 |
| API-EVT-003 | `knowledge:progress` / `onKnowledgeProgress` | `KnowledgeIndexProgress` | `KnowledgeService` 回调：`index.ts:865-868`；文档解析/向量进度 |
| API-EVT-004 | `project:progress` / `onProjectProgress` | `ProjectAnalysisProgress` | `ProjectManagementService` 回调：`index.ts:869-874`；协议解析/匹配进度 |
| API-EVT-005 | `agent:event` / `onAgentEvent` | `{conversationId,event:AgentEvent}` | `agent:ask` 中由 `VisualizationAgent` 推送：`index.ts:201-209`；可视化专家阶段状态 |

## 4. 外部 HTTP 接口

这些不是 renderer 可直接调用的接口，而是主进程服务向配置的外部服务发起的请求。

### 4.1 VISSLM 平台

| 编号 | 方法/路径 | 用途 | 查询/请求体/响应 | 代码依据 |
| --- | --- | --- | --- | --- |
| API-EXT-001 | `GET {baseUrl}/rest/application/Version` | 平台连接测试 | 查询含 `user`、`ApiToken`；返回版本值或 `AlmResponse` | `src/main/visslm.ts:241-258` |
| API-EXT-002 | `GET {baseUrl}/rest/application/DBVersion` | 平台数据库版本测试 | 同上 | `src/main/visslm.ts:241-250` |
| API-EXT-003 | `GET {baseUrl}/rest/items` | 采集和预览数据 | 无 filters 时使用 `q._valm_NodeType`；有 filters 时构造 `VSearch`；`ReturnProperty` 强制包含基础字段；响应使用 `propList` | `src/main/visslm.ts:271-349` |
| API-EXT-004 | `GET {baseUrl}/rest/items/id/{id}/attachment` | 获取记录附件 | `id` URL encode；响应 `propList`，失败时按空附件处理 | `src/main/visslm.ts:260-269` |
| API-EXT-005 | `GET {sourceUrl}` | 下载远程图片 | 30 秒 timeout；响应转 Buffer 和 MIME；失败不阻断整次同步 | `src/main/visslm.ts:452-499,827-877` |
| API-EXT-006 | `POST {baseUrl}/rest/items` | 将本地记录推送回平台 | `Content-Type: application/json; charset=utf-8`；查询含 nodeType/projectId 等位置参数；body 删除 `_valm_Uid/_valm_ItemID/_valm_NodeType`；响应解析 remote UID | `src/main/visslm.ts:188-239,511-670` |

VISSLM 请求统一使用 `AbortSignal.timeout(30_000)`。GET/POST 业务错误既可能是非 2xx，也可能是 JSON 中 `ErrorCode != 0`；POST 使用 `VisslmRequestError(httpStatus,response)` 保留状态和响应供日志写入。Token 只在真实请求 URL 中使用，在 trace 和日志参数中替换为 `******`，见 `src/main/visslm.ts:161-219,226-231`。

### 4.2 模型服务

| 编号 | 方法/路径 | 用途 | 请求头/请求体 | 代码依据 |
| --- | --- | --- | --- | --- |
| API-EXT-007 | local `GET {baseUrl}/api/tags` | Ollama 模型连接测试 | 无认证；响应 `models[].name` 必须包含配置模型 | `src/main/model-client.ts:81-96` |
| API-EXT-008 | local `POST {baseUrl}/api/chat` | Ollama 工具调用/对话 | JSON：model、messages、tools、think、stream=false、format、options；180 秒 timeout | `src/main/model-client.ts:98-119` |
| API-EXT-009 | online `GET {baseUrl}/models` | OpenAI 兼容在线服务连接测试 | `Authorization: Bearer <API Key>`；响应支持 `data[].id` 或 `models[].id` | `src/main/model-client.ts:34-63,355-367` |
| API-EXT-010 | online `POST {baseUrl}/chat/completions` | OpenAI、DeepSeek、Qwen、智谱、Moonshot、MiniMax、兼容服务 | Bearer；JSON messages/tools/model，根据 provider 写 thinking/reasoning 参数 | `src/main/model-client.ts:121-211` |
| API-EXT-011 | Anthropic `POST {baseUrl}/messages` | Anthropic 对话和工具调用 | `x-api-key`、`anthropic-version: 2023-06-01`；system/messages/tools/thinking | `src/main/model-client.ts:213-306,355-361` |

线上模型上下文可能包含用户问题、检索证据、结构化查询结果、协议内容和大屏生成数据；是否允许技术协议外发由 `projects:upload-agreement` 的 `allowExternalProcessing` 显式确认控制，但普通 AI 问答的外发范围仍取决于用户选择的在线模型配置，见 `src/main/project-management.ts:191-194`、`src/main/model-client.ts`。

## 5. 请求和响应示例

### 5.1 查询本地记录

```ts
const page = await window.visslm.listRecords({
  page: 1,
  pageSize: 50,
  projectId: 'project-uid',
  nodeType: 'TSIssue',
  search: '登录'
})
// { rows: RecordRow[], total: number }
```

契约：`src/shared/types.ts:143-188`；handler：`src/main/index.ts:158`。

### 5.2 生成并保存 Dashboard

```ts
const response = await window.visslm.askAgent({
  question: '按月份统计缺陷数量并生成大屏',
  expertId: 'visualization',
  entrypoint: 'dashboard',
  dataScope: { projectIds: ['project-uid'] }
})

if (response.dashboard) {
  await window.visslm.saveDashboard({
    spec: response.dashboard,
    changeSummary: '根据月份缺陷数量生成'
  })
}
```

生成接口不自动持久化 Dashboard；保存由 `dashboards:save` 完成，保存前执行 `validateDashboardSpec`，见 `src/main/index.ts:190-265,284-309`。

### 5.3 推送预览

```ts
const preview = await window.visslm.previewPush({
  recordUids: ['record-uid'],
  nodeType: 'TSIssue',
  projectId: 'target-project-uid',
  fieldMappings: [
    { id: 'mapping-1', sourceField: 'Source', targetField: 'Source' }
  ]
})
```

预览只构造 body，不发送 POST，也不写 `push_logs`；真实调用 `startPush` 按记录串行执行并逐条写日志，见 `src/main/visslm.ts:517-670`。

## 6. 错误码和异常语义

当前没有集中式错误码枚举。可观测到的稳定标识只有以下几类：

| 标识/形式 | 触发位置 | 含义 |
| --- | --- | --- |
| `NO_ANALYTICS_DATA` | `src/main/index.ts:241-255` | 可视化专家当前数据范围没有可用字段，属于可恢复业务事件 |
| `ConnectionResult.ok=false` | `VisslmClient.test`、`ModelClient.test` | 外部连接失败、模型不存在、凭据缺失等；错误文本在 `message` |
| `ProjectAnalysisStartResult.ok=false` | 项目解析/匹配启动方法 | 前置条件、在线模型外发确认、任务冲突等业务拒绝 |
| `Data*Result/PushResult/Knowledge*Result.ok=false` | 数据传输、推送、知识库和删除 | 可预期的局部业务结果；未必代表 IPC 异常 |
| `VisslmRequestError.httpStatus` | `src/main/visslm.ts:37-45,206-217` | VISSLM POST HTTP/业务错误，写入 push log |
| `Error` rejection | 所有 handler | 参数非法、SQLite 错误、模型调用失败、文件读写失败等；目前没有统一 code |

新增跨模块接口时，必须先决定是返回稳定 `ok` 结果还是抛出异常，并在 renderer 中保持一致；不能只依赖中文错误文本做程序分支。

## 7. 前后端一致性检查

### 7.1 已发现的后端存在但前端未调用

| 编号 | 接口/方法 | 证据 | 结论 |
| --- | --- | --- | --- |
| API-GAP-001 | `projects:discard-draft` / `discardManagedProjectDraft` | preload `src/preload/index.ts:176`、handler `src/main/index.ts:731-733`；`src/renderer/src` 静态扫描未找到调用 | 可能未使用；当前 UI 没有明确“放弃草稿”调用路径 |
| API-GAP-002 | `analytics:field-profile-semantics` / `saveFieldProfileSemantics` | preload `src/preload/index.ts:104-107`、handler `src/main/index.ts:269-273`；DashboardStudio 只读取画像和执行查询，未发现保存语义调用 | 可能未使用；字段显示名/角色/敏感级别目前没有已确认的 renderer 编辑入口 |
| API-GAP-003 | `AppDatabase.listSyncRuns()` | `src/main/database.ts:4966-4979` 存在，但没有 IPC/preload 暴露 | DB 内部方法；同步历史表已写入，但当前无公开 UI/API 查看入口 |

### 7.2 前端调用但未发现后端实现

基于 `window.visslm.<method>` 与 `src/preload/index.ts`、`src/main/index.ts` 的静态交叉检查，当前没有确认到“renderer 调用但 preload/handler 缺失”的方法。动态字符串调用和构建后代码未单独分析，仍需在 CI 中做自动化契约检查。

### 7.3 请求/响应契约风险

| 编号 | 问题 | 影响 |
| --- | --- | --- |
| API-GAP-004 | IPC 参数没有运行时 schema 校验，TypeScript 类型在 renderer 外不构成安全边界 | 手工调用或未来新增 renderer 可能把错误对象传入主进程 |
| API-GAP-005 | 错误没有统一 `{code,message,details}` | 跨页面无法稳定区分参数错误、权限拒绝、网络失败和数据库失败 |
| API-GAP-006 | `PushResult.requests[].body` 和日志可携带完整业务 payload | 调试、截图、导出日志时可能泄露业务数据；不应把接口示例中的真实 payload 提交到仓库 |
| API-GAP-007 | `KnowledgeDocumentPreview` 返回 `contentBase64`，只在 PDF 场景使用 | 大文件会放大 IPC 内存；当前 50 MB 限制只在 handler 读取前检查 |
| API-GAP-008 | Dashboard 导出 PDF 使用当前主窗口 `printToPDF` | 当前选中的页面/渲染状态可能影响导出，导出契约没有独立渲染上下文 |

## 8. 代码依据索引

- `src/main/index.ts:122-846`：所有 IPC handler 和外部 orchestration。
- `src/preload/index.ts:54-245`：全部 renderer API 和事件订阅。
- `src/shared/types.ts:54-704`：AppApi、数据、同步、聊天、知识库、推送和 Dashboard 契约。
- `src/shared/project-types.ts:1-404`：项目管理、需求、匹配、任务和进度契约。
- `src/shared/query-spec.ts:1-207`：分析查询输入约束。
- `src/shared/dashboard.ts:1-266`：Dashboard、质量报告、审计和运行契约。
- `src/main/visslm.ts:148-877`：VISSLM GET/POST、同步、图片和推送。
- `src/main/model-client.ts:31-387`：Ollama、OpenAI 兼容和 Anthropic 外部模型协议。
- `src/main/knowledge.ts:480-984`：知识库上传、解析、embedding、索引和搜索。
- `src/main/project-management.ts:99-1198`：项目管理服务、协议分析、审核、发布和匹配。
