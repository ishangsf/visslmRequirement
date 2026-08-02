# AI_CONTEXT

> 任何编程 AI 在修改本项目代码前，必须先阅读本文件以及本文件指定的相关文档。不得仅根据单个文件直接修改跨模块业务。
>
> 最后分析时间：2026-08-01（Asia/Singapore）  
> 代码基线：Git `9bab57fc5166770784c1855857a6e1a8ebaa6200`；当前工作树包含未提交改动。

## 一句话介绍

VISSLM Agent 是 Windows x64 Electron 本地数据智能工作台：同步 VISSLM 数据到 SQLite，建立知识库和向量索引，提供本地/在线模型问答、可追溯可视化大屏、项目协议分析与需求匹配，并支持按字段映射推送回 VISSLM。

## 技术栈与目录

- Electron `43.2.0`、React `19.2.0`、TypeScript `5.9.3`、Ant Design `6.1.0`、Vite/electron-vite。
- SQLite：Node `node:sqlite` `DatabaseSync`；启用 WAL、外键、busy timeout 和 FTS5。
- AI：Ollama、本地 embedding `Xenova/bge-small-zh-v1.5`、Tesseract OCR，也支持 OpenAI-compatible/Anthropic 等在线服务。
- `src/main/`：主进程、数据库、VISSLM 客户端、知识库、模型、项目管理、查询和可视化专家。
- `src/preload/`：唯一的 renderer IPC 白名单。
- `src/renderer/src/`：React 工作台、Dashboard、项目管理页面。
- `src/shared/`：跨进程类型、状态枚举、QuerySpec、Dashboard 和项目管理协议。
- `scripts/`：资源准备、领域 smoke、Dashboard 回归和 CDP UI smoke。
- `buildResources/`：打包时注入的模型/OCR资源；`out/`、`release/`、`tmp/` 等是产物或运行数据，不是业务源代码。

## 系统入口和调用边界

```text
React renderer
  -> window.visslm (src/preload/index.ts)
  -> ipcRenderer.invoke / ipcMain.handle
  -> main service (src/main/*.ts)
  -> AppDatabase / fetch / local model
```

- 主进程入口：`src/main/index.ts`。
- preload：`src/preload/index.ts`，`contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`。
- renderer 根入口：`src/renderer/src/main.tsx`，导航和页面编排：`src/renderer/src/App.tsx`。
- 数据库启动：`app.whenReady()` 创建 `<userData>\visslm-agent.db` 和 `assets\base64`，`AppDatabase` 自动执行迁移。
- 没有独立 HTTP Controller/DAO 层；IPC handler 是应用边界，`AppDatabase` 同时包含迁移、查询和持久化。

## 核心模块

1. 数据概览：记录统计和基础数据入口。
2. 数据采集：VISSLM 连接、范围预览、递归同步、附件、请求日志。
3. 资产中心：记录列表、全文检索、详情、导入导出和删除。
4. 知识库：DOCX/PDF/XLSX/XLS/TXT 解析、OCR、分块、embedding、检索。
5. AI 助手：本地记录/知识库工具调用、会话、来源引用。
6. 分析查询和可视化：字段画像、QuerySpec、Dashboard 生成/保存/版本/诊断/导出。
7. 项目管理：技术协议、需求审核/发布、向量匹配、成本、人员、计划和资产关联。
8. 数据推送：字段映射预览、VISSLM POST、逐条日志。
9. 系统配置：平台、模型、功能开关和导航顺序。

详细需求、模块和接口映射依次阅读：`docs/00-project-scan.md`、`docs/01-code-mapping.md`、`docs/02-requirements.md`、`docs/03-system-architecture.md`、`docs/04-module-design.md`、`docs/05-database-design.md`、`docs/06-api-design.md`。

## 重要数据表

- 数据中心：`projects`、`records`、`images`、`records_fts`。
- 同步/推送：`sync_runs`、`collection_request_logs`、`push_logs`。
- 知识库：`knowledge_documents`、`knowledge_chunks`、`knowledge_vectors`、`knowledge_index_tasks`。
- AI/分析：`chat_sessions`、`field_profiles`、`query_cache`。
- Dashboard：`dashboards`、`dashboard_versions`、`dashboard_audit_logs`、`visualization_runs`。
- 项目管理：`org_people`、`pm_projects`、`pm_project_documents`、`pm_requirement_sets`、`pm_requirements`、`pm_requirement_matches`、`pm_project_assets`、`pm_project_participants`、`pm_project_tasks`、`pm_cost_entries`。
- 配置：`settings`。

完整字段、约束、状态值、外键和读写代码见 `docs/05-database-design.md`，不要只依据表名猜含义。

## 关键 API

- 配置/连接：`settings:*`、`connections:test-platform`、`connections:test-model`。
- 数据/同步：`data:*`、`sync:*`、`push:*`。
- AI/分析：`agent:ask`、`chat:*`、`analytics:*`。
- Dashboard：`dashboards:list/get/save/restore/diagnose/runs/audit-logs/export-*`。
- 知识库：`knowledge:documents/document/document-preview/upload/retry/tags/delete/rebuild/stats`。
- 项目：`projects:list/get/create/update/delete/upload-agreement/confirm/retry-analysis/start-matching/requirements/*/matches/costs/assets/participants/tasks/export-data/export-excel/import-data`。

API 的参数、返回值和实际调用页面以 `docs/06-api-design.md` 和 `src/shared/*.ts` 为准。`projects:discard-draft`、`analytics:field-profile-semantics` 当前可能未被 renderer 调用；`listSyncRuns()` 当前只在数据库内部存在。

## 权限模型

已确认本项目按单机单用户范围运行，不建设登录、角色、RBAC、操作者身份区分或组织数据范围。`feature.<module>` 只是本地导航功能开关，不是后端授权。在线协议解析需在上传动作显式确认 `allowExternalProcessing`，但普通在线问答/大屏上下文没有统一字段脱敏层。

## 关键业务规则

- 配置中的 Token/API Key 使用 Electron `safeStorage` 加密保存；不要读取或输出明文。
- 同步先配置类型/字段/过滤，再预览并启动；同步任务和项目任务存在运行冲突保护。
- 知识库支持五类文件；资源不足、文件超限或索引失败时按状态记录并可重试。
- Dashboard 通过 QuerySpec 访问本地数据，保存前校验，版本/恢复/诊断/导出写审计。
- 项目匹配要求项目可匹配、需求审核集已发布且没有同项目运行任务；向量分数和模型复核分数会保存。
- 项目详情可导出 JSON 完整快照或包含 9 个工作表的 Excel 报表；Excel 仅用于报表交换，不作为项目 JSON 导入格式。
- 推送必须有目标节点类型、项目 UID、至少一条记录和合法字段映射；本地标识字段会从消息体移除。
- `records` 删除可能级联知识索引和项目资产关联；执行删除前必须确认影响范围。

## 开发约束

修改前必须读取根目录 `agents.md`。尤其遵守：深色主题只使用现有主题变量；表格配置响应式 `scroll.y`、`min-height: 0`、列宽拖拽/键盘/版本化缓存；详情浮层保持上下文、内部滚动、HTML 清洗和弱遮罩；所有控件具备 focus/disabled/loading 状态。

新增跨模块能力必须同步修改：共享类型 -> main service/DB -> IPC handler -> preload API -> renderer 调用 -> 文档和 smoke。不要在 renderer 直接访问 Node API、SQLite、文件系统或外部 HTTP。

## 禁止随意修改

- 不要提交、打印或复制 Token、API Key、私钥、完整数据库连接信息、真实业务 payload、用户数据库或截图。
- 不要绕过 preload 在 renderer 开启 `nodeIntegration`。
- 不要直接删除/重建用户数据库、`$appData` 或备份目录；数据破坏操作必须先确认精确目标和备份。
- 不要把 `out/`、`release/`、模型/OCR资源和临时调试文件当作源码提交。
- 不要只根据文件名、类名或常见架构推断业务；先查调用链、类型、SQL、页面和脚本。
- 不要将当前 feature 开关描述成权限；不要将推测的业务公式写成确定规则。

## 已知风险

当前最重要风险：在线模型数据外发没有统一脱敏策略；默认平台地址为 HTTP；主进程承载重任务；SQLite/向量检索规模受限；`AppDatabase` 和大型页面耦合；统一错误码、独立 migration 和完整单元测试仍不足。RBAC 不属于本项目范围，详见 `docs/08-known-issues.md`。

## 修改前后检查

修改前：

```powershell
Get-Content -Encoding UTF8 .\agents.md
npm run typecheck
```

按影响范围检查 `docs/01-code-mapping.md`、`docs/04-module-design.md`、`docs/05-database-design.md`、`docs/06-api-design.md` 和相关状态/配置定义。

修改后至少执行：

```powershell
npm run typecheck
npm run build
npm run smoke:project-management
```

涉及知识库执行 `npm run knowledge:smoke`；涉及 Dashboard/查询执行相关 `smoke-dashboard-*`/`smoke-query-*`；涉及 UI、表格、匹配抽屉或详情浮层，启动 CDP 后执行项目管理 UI smoke，并按 `agents.md` 做深色主题、列宽、滚动、响应式和无障碍检查。

## 文档阅读顺序

1. `AI_CONTEXT.md`（本文件）和 `agents.md`。
2. `docs/00-project-scan.md`：仓库边界和技术入口。
3. `docs/01-code-mapping.md`：页面/API/服务/表/状态映射。
4. `docs/02-requirements.md`：已实现需求、功能编号和业务规则。
5. `docs/03-system-architecture.md`：架构、数据流和风险。
6. `docs/04-module-design.md`、`docs/05-database-design.md`、`docs/06-api-design.md`：修改具体模块时查阅。
7. `docs/07-development-guide.md`：运行、测试、构建和扩展流程。
8. `docs/08-known-issues.md`、`docs/09-document-audit.md`：限制、风险和审计缺口。

## 代码依据索引

- `src/main/index.ts`：Electron 生命周期、窗口安全配置、IPC 和服务装配。
- `src/preload/index.ts`：contextBridge API 白名单。
- `src/main/database.ts`：SQLite schema、迁移、状态和读写。
- `src/main/settings.ts`：安全配置保存和 feature/navigation/sync 配置。
- `src/main/visslm.ts`：VISSLM 同步、附件和推送。
- `src/main/knowledge.ts`：文档、OCR、embedding 和检索。
- `src/main/ollama.ts`、`src/main/model-client.ts`：AI 工具和模型适配。
- `src/main/project-management.ts`：项目协议、需求、匹配、成本、人员和计划。
- `src/main/project-export.ts`：项目快照到 Excel 多工作表工作簿的转换。
- `src/renderer/src/App.tsx`、`src/renderer/src/dashboard/`、`src/renderer/src/project-management/`：页面和 UI 交互。
- `src/shared/*.ts`：跨进程协议。
- `package.json`、`README.md`、`electron.vite.config.ts`、`scripts/`：运行、构建和验证。
- `scripts/smoke-project-export.ts`：项目 Excel 导出写入/重新读取 smoke。
- `agents.md`：持续开发约束。
