# 00 项目扫描报告

> 最后分析时间：2026-08-01（Asia/Singapore）  
> 代码基线：Git `9bab57fc5166770784c1855857a6e1a8ebaa6200`，分支 `main`；分析对象为当前工作树，工作树含未提交改动。  
> 说明：本报告只把当前源代码、配置、脚本和已生成构建产物作为证据。不能由代码确认的内容标记为“待确认”，由实现间接归纳的内容标记为“推测”。敏感凭据不在文档中展开。

## 1. 扫描结论

VISSLM Agent 是面向 Windows 的 Electron + React + TypeScript 本地数据智能工作台。程序从 VISSLM 平台同步项目/节点记录到本地 SQLite，下载并去重附件图片，解析本地文档建立知识库和向量索引，提供数据问答、可视化大屏生成/版本治理/导出、项目需求提取与数据匹配，并可将选定记录按字段映射推送回 VISSLM。

这一定位有直接证据：仓库说明在 `README.md`，主进程初始化和 IPC 入口在 `src/main/index.ts:848-902`，平台同步/推送实现位于 `src/main/visslm.ts`，本地数据库实现位于 `src/main/database.ts`。

## 2. 项目目录结构

```text
visslmRequirement/
├─ src/
│  ├─ main/
│  │  ├─ index.ts                 # Electron 生命周期、窗口、IPC handler
│  │  ├─ database.ts              # node:sqlite DatabaseSync、迁移、查询和持久化
│  │  ├─ settings.ts              # 配置与 Electron safeStorage 密钥读写
│  │  ├─ visslm.ts                # VISSLM HTTP 客户端、同步、推送
│  │  ├─ knowledge.ts             # 文档解析、OCR、embedding、向量检索
│  │  ├─ ollama.ts                # 通用数据助手、工具调用和回答编排
│  │  ├─ model-client.ts          # Ollama/OpenAI-compatible/Anthropic 适配
│  │  ├─ project-management.ts    # 项目、协议分析、需求审核、匹配、成本/人员/计划
│  │  ├─ analytics/query-engine.ts# 字段画像、QuerySpec 执行、缓存
│  │  ├─ experts/                 # 专家路由、可视化生成/补丁/运行记录
│  │  └─ dashboards/              # 大屏校验和质量诊断
│  ├─ preload/index.ts            # contextBridge 暴露 window.visslm
│  ├─ renderer/
│  │  ├─ index.html               # HTML 宿主
│  │  └─ src/
│  │     ├─ main.tsx              # React/Ant Design 根入口
│  │     ├─ App.tsx               # 工作台导航和主要页面
│  │     ├─ dashboard/            # Dashboard Studio 和组件渲染
│  │     └─ project-management/   # 项目列表、详情、匹配抽屉等
│  └─ shared/                     # 主进程/渲染进程共享类型和协议
├─ scripts/                      # 资源准备、单元/集成 smoke、CDP UI 回归
├─ buildResources/               # 打包时注入的本地模型、OCR、图标
├─ electron.vite.config.ts       # Electron Vite 三入口构建配置
├─ package.json / package-lock.json
├─ README.md                     # 当前开发、部署、测试说明
├─ agents.md                     # 用户提供的持续开发约束（文件名大小写为小写）
├─ out/                          # 已生成构建产物，不是源代码
├─ release/                      # 已生成 Windows 打包产物，不是源代码
├─ $appData/、tmp/               # 本地运行/调试数据，不应作为产品源代码
└─ docs/                         # 本次生成的项目文档
```

目录证据来自仓库文件清单和 `src`/`scripts` 实际文件；`out`、`release`、`$appData`、`tmp` 是当前工作树中的产物或运行数据，是否应从版本库清理属于待确认事项。

## 3. 技术栈

| 层次 | 实际技术 | 代码/配置依据 |
|---|---|---|
| 桌面容器 | Electron `43.2.0` | `package.json`、`src/main/index.ts:1` |
| 构建 | electron-vite `4.0.1`、Vite `7.2.0`、Rollup | `electron.vite.config.ts` |
| UI | React `19.2.0`、Ant Design `6.1.0`、Ant Design Icons | `package.json`、`src/renderer/src/main.tsx` |
| 语言 | TypeScript `5.9.3`，严格模式、ES2022 | `tsconfig.json` |
| 数据库 | Node `node:sqlite` 的 `DatabaseSync`，SQLite WAL、外键、FTS5 | `src/main/database.ts:1-4,456-461,996-1036` |
| 图表/大屏 | ECharts、echarts-for-react、react-grid-layout、html-to-image | `package.json`、`src/renderer/src/dashboard` |
| 文档解析/Excel 导出 | mammoth、pdfjs-dist、xlsx、TXT 读取；项目快照可生成 Excel 工作簿 | `src/main/knowledge.ts:1-15,200-330`、`src/main/project-export.ts` |
| OCR | tesseract.js，`chi_sim` + `eng` | `src/main/knowledge.ts:300-330` |
| 本地 embedding | `@huggingface/transformers`，默认 `Xenova/bge-small-zh-v1.5`，384 维 | `src/main/knowledge.ts:19-28,370-470` |
| 模型服务 | Ollama 原生 API；OpenAI 兼容服务；Anthropic Messages API | `src/main/model-client.ts` |
| HTTP | Node/浏览器 `fetch` | `src/main/visslm.ts`、`src/main/model-client.ts` |
| 导出/媒体 | JSON/JSONL、PNG、PDF、Electron `printToPDF`、`@napi-rs/canvas` | `src/main/index.ts:362-515`、相关渲染文件 |
| 打包 | electron-builder，Windows x64 NSIS | `package.json:60-97` |
| 测试 | TypeScript/Node smoke、Electron CDP WebSocket UI 回归 | `package.json`、`scripts/`、`README.md:166-230` |

## 4. 启动、构建与部署入口

| 项目 | 入口/方式 | 证据 |
|---|---|---|
| 开发启动 | `npm run dev` -> `electron-vite dev` | `package.json:10` |
| 主进程 | `src/main/index.ts`，构建后 `out/main/index.js` | `package.json:4`、`electron.vite.config.ts` |
| preload | `src/preload/index.ts`，构建为 `out/preload/index.cjs` | `electron.vite.config.ts` |
| renderer | `src/renderer/index.html` -> `src/renderer/src/main.tsx` -> `App.tsx` | `electron.vite.config.ts`、`src/renderer/src/main.tsx` |
| 数据初始化 | `app.whenReady()` 创建 `<userData>/visslm-agent.db` 和 `<userData>/assets/base64` | `src/main/index.ts:860-888` |
| 构建 | `npm run build` -> electron-vite 三目标构建 | `package.json:11` |
| Windows 安装包 | `npm run package` -> 资源准备 + build + electron-builder NSIS x64 | `package.json:25`、`package.json:60-97` |
| 目录包 | `npm run package:dir` | `package.json:26` |
| 资源准备 | `npm run prepare:model`，写入 `buildResources/models`、`buildResources/ocr` | `scripts/prepare-local-resources.mjs`、`README.md:119-127` |
| 运行数据位置 | Electron `app.getPath('userData')`；数据库 WAL 和附件目录随应用用户数据保存 | `src/main/index.ts:861-864`、`README.md:234-245` |

## 5. 前端入口与页面

`src/renderer/src/main.tsx` 创建 React 根节点，使用 Ant Design 中文 locale、暗色算法和主题 token。`App.tsx:3895-4118` 的 `AppShell` 管理当前页面、功能开关、导航顺序、模型连通状态和页面元数据。当前页面键为：

| 页面键 | 页面/组件 | 主要调用方向 |
|---|---|---|
| `dashboard` | `DashboardPage` | 统计、图表、数据概览 |
| `visualization` | `DashboardStudio` | 字段画像、QuerySpec、大屏保存/版本/导出/诊断 |
| `projects` | `ProjectManagementPage` | 项目、协议需求、匹配、成本、资产、组织人员、参与人、计划 |
| `data` | `AssetCenterPage` + `KnowledgeBasePage` | 记录浏览、导入导出、删除、知识库 |
| `chat` | `ChatPage` | AI 问答、历史会话、来源和数据结果 |
| `sync` | `SyncPage` | 采集配置、预览、执行、请求日志 |
| `push` | `PushPage` | 推送配置、预览、执行、推送日志 |
| `settings` | `SettingsPage` | 平台、模型、功能模块、导航顺序 |

功能开关默认值在 `src/shared/types.ts:89-120`；推送默认关闭。`PageKey` 和导航数据在 `App.tsx:110-145`。项目管理页面自带项目列表/详情切换，详情包含协议文件、需求审核与发布、匹配抽屉、成本、资产、人员和计划。

## 6. 后端入口与数据库访问

本项目没有独立 HTTP 后端、Controller 层或远程服务端部署。主进程同时承担应用服务和本地后端职责：

1. `src/main/index.ts:848-902` 负责单实例锁、应用生命周期、数据库和服务实例化、窗口创建和退出关闭。
2. `src/main/index.ts:100-846` 注册 `ipcMain.handle`，将 `window:*`、`settings:*`、`data:*`、`sync:*`、`agent:*`、`analytics:*`、`dashboards:*`、`knowledge:*`、`projects:*`、`organization:*`、`push:*` 通道映射到数据库或服务方法。
3. `src/preload/index.ts:40-245` 使用 `contextBridge.exposeInMainWorld('visslm', api)` 暴露白名单 API；渲染进程没有 Node 集成。
4. `src/main/database.ts:452-5202` 用 `DatabaseSync` 直接读写 SQLite；没有单独 DAO 文件，`AppDatabase` 同时承担数据库迁移、查询、映射和领域持久化。

因此用户要求中的“Controller -> Service -> DAO”在本仓库实际对应：

```text
React 页面 -> window.visslm (preload) -> ipcMain.handle (main/index.ts)
          -> 领域服务（KnowledgeService / ProjectManagementService / SyncService / PushService / OllamaAgent / QueryEngine）
          -> AppDatabase -> SQLite 表/FTS5/本地文件
```

## 7. 配置文件与配置项

| 配置 | 实际位置 | 处理方式 |
|---|---|---|
| 平台地址、用户名、Token | SQLite `settings`，键 `platform.*` | Token 通过 Electron `safeStorage` 密文保存；`SettingsService` 读取时脱敏为 `hasToken` |
| 模型来源、服务商、地址、模型、思考开关 | SQLite `settings`，键 `model.*` | API Key 按 `model.apiKey.<provider>` 保存；UI 只收到 `hasApiKey` |
| 功能开关 | SQLite `settings`，键 `feature.<key>` | 默认 `dashboard/visualization/projects/data/chat/sync=true`，`push=false` |
| 导航顺序 | SQLite `settings`，键 `navigation.order` | 包含版本号 `1`，损坏或版本不一致时回退默认顺序 |
| 数据采集范围 | SQLite `settings`，键 `sync.scope` | JSON 保存并带版本校验，具体逻辑在 `settings.ts:160-197` |
| 本地资源目录 | 环境变量 `VISSLM_RESOURCE_ROOT` 等 | 资源准备和运行时定位读取，见 `README.md:128-143` |
| smoke 凭据/CDP 端口 | 环境变量 `VISSLM_TEST_USER`、`VISSLM_TEST_TOKEN`、`VISSLM_CDP_PORT` | 仅测试/回归脚本使用 |

默认平台 URL、默认 Ollama URL 和默认模型是在 `src/main/settings.ts:17-19` 写入的。具体地址和凭据属于环境配置，不在本报告重复展开。

## 8. API 定义位置

类型契约位于：

- `src/shared/types.ts`：`AppApi`、数据、同步、推送、知识库、聊天和配置类型；
- `src/shared/project-types.ts`：项目管理、需求、匹配、成本、组织与计划类型；
- `src/shared/query-spec.ts`：数据范围、字段画像和查询协议；
- `src/shared/dashboard.ts`：大屏、版本、审计和质量诊断协议；
- `src/preload/index.ts`：渲染侧 API 方法到 IPC 通道的实际映射；
- `src/main/index.ts`：IPC handler 的实际执行入口。

没有 OpenAPI/Swagger、HTTP Controller 或网络路由定义。IPC 通道的完整映射见 `docs/01-code-mapping.md` 和 `docs/06-api-design.md`。

## 9. 权限控制方式

扫描未发现登录页面、用户表、角色表、权限点常量、JWT/session 校验或 IPC 调用方身份校验。当前可确认事实是：

- 应用通过 Electron 单实例锁限制同一应用多实例，见 `src/main/index.ts:848-858`；
- 平台 Token/API Key 由本机用户配置，使用 `safeStorage` 加密保存，见 `src/main/settings.ts:204-221`；
- 功能模块启用/禁用只是本地 `feature.*` 设置和菜单过滤，不是安全授权，见 `App.tsx:3924-3937`；
- 所有 IPC handler 注册后未看到基于角色或用户的授权判断。

“本地单用户工作台”是基于上述实现的架构归纳，且已确认本项目不建设 RBAC、登录和组织级授权体系。审计日志和本机数据保护仍需遵守其他安全约束。

## 10. 外部系统与基础设施依赖

| 依赖 | 用途 | 证据/限制 |
|---|---|---|
| VISSLM/ALM HTTP API | 项目/节点查询、附件下载、数据推送 | `src/main/visslm.ts`；凭据由用户配置；README 说明正式环境应启用 HTTPS |
| Ollama | 本地模型连接 `/api/tags`、`/api/chat` | `src/main/model-client.ts`；默认 `127.0.0.1:11434` |
| 在线模型服务 | OpenAI、Anthropic、DeepSeek、Qwen、Zhipu、Moonshot、MiniMax、OpenAI-compatible | `src/main/model-client.ts`、`App.tsx:190-230`；请求上下文会离开本机 |
| Hugging Face/本地模型资源 | 下载并加载 embedding | `scripts/prepare-local-resources.mjs`、`knowledge.ts`；运行时默认禁止远程下载 |
| Tesseract 语言包 | 扫描型 PDF OCR | `knowledge.ts:300-330`；需要 `chi_sim`、`eng` |
| Windows 用户数据目录 | SQLite、WAL、附件、知识库源文件路径 | Electron `app.getPath('userData')` |
| CDP WebSocket | UI smoke 回归 | `scripts/smoke-*.mjs`；不是产品运行依赖 |

未发现消息队列、Redis、定时任务调度器或独立对象存储。同步、索引、协议分析和匹配任务都是主进程内异步任务；无 `setInterval`/cron/队列基础设施证据，详见架构和风险文档。

## 11. 测试方式

- 静态检查：`npm run typecheck`；构建检查：`npm run build`。
- 数据/领域 smoke：知识库、项目管理、查询公式、Dashboard 版本/审计/质量/治理等 `scripts/smoke-*.ts/.mjs`。
- 可视化离线回归：`smoke-dashboard-*`、`smoke-query-*`、`smoke-visualization-*`。
- Electron UI 回归：通过 CDP 端口连接已启动应用，检查页面文本、交互和截图。
- 现有 `package.json` 只为部分 smoke 提供 npm script；其他脚本需直接使用 `npx tsx` 或 `node`，完整清单见 `docs/07-development-guide.md`。

未发现 Jest/Vitest/Playwright 配置；UI 脚本使用 `ws` 自行连接 CDP，是否存在未纳入仓库的外部 CI 需要确认。

## 12. 初步业务模块

| 编号 | 模块 | 当前实现证据 |
|---|---|---|
| M-01 | 数据概览 | `DashboardPage`、`data:stats`、`AppDatabase.getStats` |
| M-02 | 数据采集 | `SyncPage`、`SyncService`、`sync:*` IPC、`sync_runs`/`collection_request_logs` |
| M-03 | 资产中心 | `AssetCenterPage`、`AppDatabase.listRecords/getRecord`、`records/images` |
| M-04 | 知识库 | `KnowledgeBasePage`、`KnowledgeService`、`knowledge_*` 表 |
| M-05 | AI 助手 | `ChatPage`、`OllamaAgent`、`ModelClient`、`chat_sessions` |
| M-06 | 分析查询 | `QueryEngine`、`QuerySpec`、`field_profiles/query_cache` |
| M-07 | 可视化大屏 | `DashboardStudio`、`VisualizationAgent`、`dashboards`/版本/审计表 |
| M-08 | 项目管理 | `ProjectManagementService`、`ProjectManagementPage`、`pm_*` 表 |
| M-09 | 数据推送 | `PushPage`、`PushService`、`push_logs`、`records.push_*` |
| M-10 | 系统配置 | `SettingsPage`、`SettingsService`、`settings` 表 |

## 13. 需要进一步确认的问题

1. VISSLM API 的生产基地址、认证协议、返回 JSON 契约和 HTTPS 要求是否已有外部接口文档；仓库只实现了客户端调用。
2. `node:sqlite` 对 Node/Electron 运行时版本的最低要求是否已在发布环境锁定；`package.json` 未声明 Node engines。
3. 未提交改动是否代表待发布功能，还是调试/实验状态；本报告按当前工作树记录。
4. 根目录运行数据目录、构建产物和临时文件是否应从版本库清理或加入忽略规则；当前 `.gitignore` 未覆盖全部现存运行目录。
5. 在线模型是否允许发送项目协议、业务记录和字段值；代码有“外发确认”选项，但无组织级数据分级策略。
6. 是否需要跨设备备份/恢复知识库源文件、附件和数据库；当前项目导出支持 JSON 快照和 Excel 报表，数据中心导出支持 JSON/JSONL，但不等同于完整数据库备份。
7. 是否需要后台任务在应用退出后继续执行；当前任务在主进程内运行，退出时只关闭数据库。
9. 是否要求所有表格都接入统一列宽组件；当前多数表格使用 `ResizableTable`，项目匹配/人员/参与人/计划等仍在页面内自定义实现。

## 14. 代码依据索引

| 证据 | 说明 |
|---|---|
| `README.md` | 产品定位、功能、安装、配置、测试、部署和安全注意事项 |
| `package.json` | 依赖、npm 脚本、Electron Builder 打包配置 |
| `electron.vite.config.ts` | main/preload/renderer 三入口构建配置 |
| `src/main/index.ts` | 主进程生命周期、窗口安全参数、全部 IPC handler、导入导出和服务装配 |
| `src/preload/index.ts` | contextBridge 白名单 API 和事件监听 |
| `src/main/database.ts` | SQLite 表、索引、迁移、FTS5、业务数据读写 |
| `src/main/visslm.ts` | 外部 VISSLM 查询、附件、同步、推送 |
| `src/main/knowledge.ts` | 文档解析、OCR、向量索引与检索 |
| `src/main/ollama.ts` / `src/main/model-client.ts` | AI 助手、工具调用、模型服务适配 |
| `src/main/project-management.ts` | 项目协议分析、需求审核/发布、匹配及项目辅助管理 |
| `src/main/analytics/query-engine.ts` | 字段画像和本地查询执行 |
| `src/main/experts/*` / `src/main/dashboards/*` | 可视化专家、校验、诊断和回归定义 |
| `src/renderer/src/App.tsx` | 工作台页面和导航 |
| `src/renderer/src/dashboard/*` | 大屏编辑、布局和组件渲染 |
| `src/renderer/src/project-management/*` | 项目管理界面及匹配/列宽交互 |
| `src/shared/*` | 跨进程数据契约、枚举、校验和大屏协议 |
| `scripts/*` | 资源准备和现有测试/回归方式 |
| `agents.md` | 用户要求的持续开发约束，后续修改应遵守 |
