# 07 开发与部署指南

> 最后分析时间：2026-08-01（Asia/Singapore）  
> 代码基线：Git `9bab57fc5166770784c1855857a6e1a8ebaa6200`；分析对象为当前工作树，工作树含未提交改动。  
> 本指南只描述当前仓库能直接验证的流程；本项目已确认不建设 RBAC、登录和组织级权限，发布审批等其他生产治理内容若未由代码确认则标记为“待确认”。

## 1. 项目约束

这是 Windows x64 Electron 桌面应用，不存在可单独部署的 HTTP 后端。开发时同时启动 Electron 主进程和 renderer，数据访问通过 preload 暴露的 `window.visslm` IPC API 完成。

主要入口：

| 层 | 入口 | 作用 |
| --- | --- | --- |
| 主进程 | `src/main/index.ts` | Electron 生命周期、窗口、IPC handler、服务装配 |
| preload | `src/preload/index.ts` | `contextBridge` 白名单 API |
| renderer | `src/renderer/src/main.tsx`、`src/renderer/src/App.tsx` | React 根节点、页面导航和业务页面 |
| 共享协议 | `src/shared/*.ts` | IPC 参数、结果、枚举和 Dashboard/项目管理契约 |
| 数据访问 | `src/main/database.ts` | `node:sqlite`、迁移、查询和持久化 |

修改跨进程功能前必须同时检查 preload、handler、共享类型和调用页面。不得只修改一个 renderer 文件后假定接口已经存在。

## 2. 环境要求

| 项目 | 当前实现/要求 | 代码依据 |
| --- | --- | --- |
| 操作系统 | Windows 10 或更高版本（x64）；Electron 23 起不再支持 Windows 7/8/8.1 | `README.md`、`package.json` `win.target`、主进程启动兼容性检查 |
| Node.js | README 建议 Node.js 24，实际运行时还必须兼容 Electron 43 的 `node:sqlite` | `README.md`、`package.json`；最低版本未在 `engines` 中锁定 |
| 包管理器 | npm，仓库包含 `package-lock.json` | 根目录文件 |
| 本地模型 | 可选；默认 Ollama 地址和模型由 `src/main/settings.ts` 提供 | `src/main/settings.ts:17-18,35-44` |
| 网络 | 访问 VISSLM、在线模型，以及首次准备 embedding/OCR 资源时需要 | `src/main/visslm.ts`、`src/main/model-client.ts`、`scripts/prepare-local-resources.mjs` |
| 本地资源 | embedding 模型和 Tesseract `chi_sim`/`eng` 语言包 | `src/main/knowledge.ts`、`scripts/prepare-local-resources.mjs` |

不要把 API Token、在线模型 API Key、实际业务 JSON 或真实请求体写进示例、日志、截图或提交记录。

## 3. 安装与本地启动

```powershell
npm install
npm run typecheck
npm run dev
```

`npm run dev` 执行 `electron-vite dev`。Electron 主进程在 `app.whenReady()` 中创建 `<userData>\visslm-agent.db`，并创建 `<userData>\assets\base64`；没有独立的数据库初始化命令。首次启动后，应用会在 `AppDatabase` 构造函数中执行 `migrate()`。

首次使用本地知识库或需要离线验证 embedding/OCR 时：

```powershell
npm run prepare:model
```

该命令从配置的 Hugging Face revision 下载 embedding 文件，从 Tesseract 数据源下载 `eng.traineddata.gz` 和 `chi_sim.traineddata.gz`，并生成资源 manifest。资源默认写入 `buildResources/models` 和 `buildResources/ocr`；这两个目录已在 `.gitignore` 中排除，不应把运行资源提交到版本库。

首次启动后的配置顺序：

1. 在“系统配置”保存 VISSLM 地址、用户名和 Token，并测试连接。
2. 选择本地或在线模型，保存模型地址、提供商、模型名称及必要的 API Key，并测试连接。
3. 在“数据采集”配置数据类型、返回字段和过滤条件，先预览，再保存并同步。
4. 在“资产中心”检查记录和附件；需要知识问答时上传文档并等待索引完成。
5. 在“AI 助手”验证本地数据问答；生成大屏时使用可视化专家入口。
6. 回写平台前先检查“数据推送”的预览，再执行真实推送。

## 4. 配置说明

### 4.1 应用内配置

`SettingsService` 使用 `settings` 表保存配置。Token 和 API Key 经 Electron `safeStorage.encryptString` 加密后才写入数据库；`getAll()` 只返回 `hasToken`/`hasApiKey`，不会把明文返回 renderer。

| 配置范围 | 主要 key/字段 | 作用 |
| --- | --- | --- |
| 平台 | `platform.baseUrl`、`platform.username`、`platform.token` | VISSLM 连接；Token 为 safeStorage 密文 |
| 模型 | `model.source`、`model.provider`、`model.baseUrl`、`model.model`、`model.thinking`、`model.apiKey.<provider>` | Ollama/在线模型选择和协议参数 |
| 功能开关 | `feature.<module>` | 控制导航中的功能模块可见性；不是权限控制 |
| 导航 | `navigation.order`，版本号为 1 | 侧栏顺序，读取时校验并补齐默认项 |
| 采集 | `sync.scope`，当前配置版本为 2 | 数据类型、返回字段和筛选规则 |

未显式配置时，平台和模型默认地址由 `src/main/settings.ts` 提供。正式环境应由部署/业务方确认是否必须改为 HTTPS 或内网地址。

### 4.2 环境变量

| 变量 | 用途 | 注意 |
| --- | --- | --- |
| `VISSLM_RESOURCE_ROOT` | 覆盖本地模型/OCR 资源根目录 | 资源准备和运行时定位共同使用 |
| `VISSLM_EMBEDDING_MODEL_PATH` | 指定 embedding 模型目录 | 目录应包含 `config.json` |
| `VISSLM_HF_ENDPOINT` | Hugging Face 下载地址 | 仅影响资源准备 |
| `VISSLM_OCR_ENDPOINT` | Tesseract 语言包地址 | 仅影响资源准备 |
| `VISSLM_KNOWLEDGE_TEST_FALLBACK=1` | 启用测试 hash embedding | 不得用于生产数据 |
| `VISSLM_TEST_USER` / `VISSLM_TEST_TOKEN` | `smoke-app.mjs` 的测试凭据 | 只放在本地环境变量，不进仓库 |
| `VISSLM_CDP_PORT` | UI smoke 的 CDP 端口 | 默认 `9223`；不是业务接口 |
| `ELECTRON_RENDERER_URL` | 主进程开发时加载指定 renderer URL | `src/main/index.ts:103-105` |

## 5. 数据库初始化、备份与恢复

数据库类型是 Node 内置 `node:sqlite` 的同步 `DatabaseSync`。构造时开启 WAL、外键和 5 秒 busy timeout，并执行内置 `CREATE TABLE IF NOT EXISTS`/索引/FTS 迁移，具体 schema 在 `src/main/database.ts:452-1037`。

本地数据位置由 Electron `app.getPath('userData')` 决定：

```text
<userData>\visslm-agent.db
<userData>\assets\base64\
```

备份步骤：

1. 退出应用，确保主进程已经关闭数据库。
2. 一并复制数据库文件及 `assets\base64` 目录。
3. 若需要恢复，先备份目标机器原目录，再替换文件并启动应用。
4. 知识库文档只保存源文件路径和解析结果；若原始文件路径失效，重新解析/重建索引会失败。

当前没有独立、版本化的 migration 文件夹；schema 变更集中在 `AppDatabase.migrate()`。新增表、列或索引时，必须考虑旧数据库升级、重复启动、外键和已有数据回填，并补充 smoke。

## 6. 前端、主进程和 preload 调试

- 前端页面入口和导航集中在 `src/renderer/src/App.tsx`；可视化页面在 `src/renderer/src/dashboard/`，项目管理在 `src/renderer/src/project-management/`。
- 主进程日志通过 `console.error` 输出；窗口加载失败和 renderer warning/error 在 `src/main/index.ts:108-119` 记录。
- renderer 不应直接导入 Node/Electron API；新增主进程能力应先在 `src/main/index.ts` 注册 handler，再在 `src/preload/index.ts` 暴露类型化方法。
- `BrowserWindow` 已启用 `sandbox`、`contextIsolation`，并关闭 `nodeIntegration`；不要为了方便在 renderer 打开 Node 能力。
- UI smoke 通过 Electron CDP 访问已启动的调试端口。启动方式必须让 Electron 暴露 `--remote-debugging-port=9223`，再执行相应脚本；CDP smoke 不是普通 `npm run dev` 的自动副作用。

## 7. 测试与验证

### 7.1 必跑检查

```powershell
npm run typecheck
npm run build
npm run smoke:project-management
```

`typecheck` 使用 `tsc --noEmit`，`build` 使用 electron-vite 构建 main/preload/renderer，项目管理 smoke 使用 `tsx` 直接验证领域服务和数据库行为。

需求匹配升级的专用检查：

```powershell
npm run smoke:agent-requirement-analysis
npm run benchmark:requirement-matching -- --records 5000 --report-only
npm run compare:requirement-rerankers -- --manifest test-data/requirement-matching/reranker-model-manifest.json --report-only
```

项目不再提供人工金标、双人标注/裁决、Excel 标注样本包及依赖人工标签的质量指标脚本。自动化验收由固定业务回归、异常失败关闭测试、当前索引范围回归和性能基准组成。benchmark 默认只覆盖混合召回，使用 `--include-reranker` 才会加载真实本地 Cross-Encoder，不能把 fake 模型或未下载资源的结果当作上线 P95 证据。

`compare:requirement-rerankers` 按 `queryId` 对同一查询下的全部候选分组排序，报告排序一致性、延迟、内存快照和模型体积。候选模型的固定 revision、哈希和许可清单位于 `test-data/requirement-matching/reranker-model-manifest.json`；模型切换由自动回归、技术指标、资源约束和产品决策共同确定。

### 7.2 知识库和离线分析

```powershell
npm run knowledge:smoke
npm run smoke:dashboard-audit
npm run smoke:query-formulas
npm run smoke:project-export
npx tsx .\scripts\smoke-analytics-cache.ts
npx tsx .\scripts\smoke-query-calculations.ts
npx tsx .\scripts\smoke-visualization-core.ts
npx tsx .\scripts\smoke-dashboard-versions.ts
npx tsx .\scripts\smoke-dashboard-quality.ts
npx tsx .\scripts\smoke-dashboard-governance.ts
npx tsx .\scripts\smoke-dashboard-drafts.ts
npm run smoke:dashboard-editor
```

`smoke:project-export` 会实际写出并重新读取 Excel 工作簿，检查 9 个工作表和关键字段。需求分析固定回归使用通用 hard-negative 合同夹具，夹具编号只用于测试数据，不参与运行时分支。可视化的 golden、性能、视觉矩阵、像素差异和回归脚本也位于 `scripts/`，涉及 renderer 或布局时应按变更范围选择执行。

### 7.3 外部连接和端到端

`smoke-app.mjs` 需要运行中的 Electron、CDP 端口以及测试平台凭据：

```powershell
$env:VISSLM_TEST_USER='masked-test-user'
$env:VISSLM_TEST_TOKEN='masked-test-token'
node .\scripts\smoke-app.mjs
```

真实平台和在线模型测试会产生外部副作用或发送业务数据，执行前必须确认测试租户、数据范围和网络策略。不得把真实输出保存进仓库。

### 7.4 UI 回归

以下脚本需要先启动带 CDP 的 Electron：

```powershell
$env:VISSLM_CDP_PORT='9223'
node .\scripts\smoke-stage5-ui.mjs
node .\scripts\smoke-asset-center-ui.mjs
node .\scripts\smoke-data-visualization-handoff.mjs
node .\scripts\smoke-chat-mention.mjs
node .\scripts\smoke-push-config-ui.mjs
npx tsx .\scripts\smoke-project-management-ui.mjs
```

涉及表格、抽屉、匹配详情或主题时，还必须按 `agents.md` 检查深色主题、列宽拖拽/键盘/持久化、表格内部纵向滚动、窄窗口横向滚动、详情浮层层级和 HTML 清洗。

## 8. 构建、打包和部署

```powershell
npm run build
npm run package:dir
npm run package
```

- `build` 只生成 `out/` 构建产物。
- `package:dir` 生成未安装的 Windows 目录包。
- `package` 先执行 `prepare:model` 和 `build`，再由 electron-builder 生成 Windows x64 NSIS 安装包到 `release/`。
- `package.json` 使用 `asar: true`；模型和 OCR 通过 `extraResources` 注入，`@napi-rs/canvas`、`onnxruntime-node`、`sharp` 通过 `asarUnpack`。
- 当前未配置 Windows 代码签名证书；正式分发是否需要签名、自动更新和版本发布渠道，待确认。

发布前检查：

1. 确认资源 manifest、模型 revision 和 OCR 语言包完整。
2. 在干净 Windows 环境安装目录包/NSIS 包并启动。
3. 验证 userData 初始化、Token/API Key 保存与重启恢复。
4. 验证本地模型、VISSLM 连接、知识库、项目管理和导出功能。
5. 确认安装包不包含真实数据库、真实凭据、调试截图或日志。

## 9. 新增模块和接口

### 9.1 新增页面模块

1. 先阅读根目录 `agents.md` 和 `AI_CONTEXT.md`，确认主题、表格、抽屉和响应式约束。
2. 在 `App.tsx` 注册页面 key、导航项、功能开关和页面组件；若模块较大，拆到独立目录。
3. 业务数据类型放入对应 `src/shared/*.ts`；禁止在 renderer 和 main 各自定义相似但不兼容的结构。
4. 主进程服务负责业务规则和持久化；renderer 只负责交互、展示和调用 preload。
5. 更新 `docs/01-code-mapping.md`、`docs/02-requirements.md`、`docs/04-module-design.md`、`docs/06-api-design.md`。
6. 增加领域 smoke 和必要的 CDP UI smoke。

### 9.2 新增 IPC 接口

1. 在 `src/shared` 定义参数、结果、错误/状态枚举。
2. 在 `src/main/index.ts` 注册 `ipcMain.handle`，并调用服务或数据库方法。
3. 在 `src/preload/index.ts` 以最小白名单方法暴露；同步更新 `AppApi` 类型。
4. 在 renderer 中调用 `window.visslm`，处理返回的 `ok=false` 和 rejection 两种现有错误语义。
5. 为参数边界增加运行时校验；当前项目还没有统一 schema 校验层，这是新增接口应补强的地方。
6. 增加 API 映射、权限/功能开关说明和前后端契约 smoke。

### 9.3 新增数据表

1. 在 `AppDatabase.migrate()` 加入幂等建表、索引、外键和必要的历史数据处理。
2. 增加类型映射、读写方法和删除策略；优先使用 prepared statement。
3. 明确状态值、时间字段、唯一约束、级联行为和数据生命周期。
4. 若表服务于长任务，说明任务恢复、重复执行和失败状态。
5. 更新 `docs/05-database-design.md` 的表清单、ER 图、读写代码和风险。
6. 用临时数据库执行 create/read/update/delete、重复启动和升级场景 smoke。

### 9.4 权限与功能开关

当前没有用户登录、角色、RBAC 或组织权限，这是已确认的单机单用户产品边界。`feature.<module>` 只控制本地导航可见性，不能作为后端授权。后续普通功能不得自行引入角色权限；若未来产品范围改变，应另行设计身份、数据范围和审计边界。

## 10. 代码规范和提交约束

- 遵守 `tsconfig.json` 的 strict TypeScript、ESM 和 `forceConsistentCasingInFileNames`。
- 保持 main/preload/renderer/shared 的边界，不在 renderer 直接操作 SQLite、文件系统或外部 HTTP。
- 复用现有主题变量和 `agents.md` 的表格/浮层约束；新增表格必须有响应式 `scroll.y`、内部收缩和可调整列宽。
- 不提交 `node_modules/`、`out/`、`release/`、模型/OCR资源、`.env`、日志、用户数据库、真实凭据或业务截图。
- 当前未发现仓库内正式分支和提交规范文件；分支命名、提交格式、审查人和发布审批属于待确认事项。若团队已有规范，应以团队规范为准。

## 11. 常见问题

| 现象 | 排查 |
| --- | --- |
| Token/API Key 保存失败 | 检查 Windows 用户会话是否支持 Electron `safeStorage`；确认不是把明文写入数据库的替代方案 |
| 知识库文档一直失败 | 检查源文件路径、扩展名、100 MB 限制、embedding/OCR 资源和主进程日志 |
| 在线协议解析被拒绝 | 在线模型必须在本次上传时显式确认 `allowExternalProcessing`；拒绝后不会继续解析 |
| UI smoke 找不到页面 | 确认 Electron 已带 CDP 端口、脚本端口一致，且功能开关没有隐藏目标模块 |
| 项目匹配无法启动 | 检查项目已确认、需求审核集已发布、没有同项目运行任务，且本地知识索引可用 |
| 构建包缺少本地模型 | 先执行 `npm run prepare:model`，确认 `buildResources/models` 和 `buildResources/ocr` manifest 完整 |
| 数据库锁定/损坏 | 退出所有应用实例；单实例锁由 Electron 控制，必要时从备份恢复，不要直接删除生产数据库 |

## 12. 代码依据索引

- `README.md`：安装、配置、数据目录、测试、构建和安全注意事项。
- `package.json`：依赖、npm scripts、Electron Builder 配置。
- `electron.vite.config.ts`：main/preload/renderer 构建入口。
- `tsconfig.json`：TypeScript 编译约束。
- `src/main/index.ts:80-119,122-846,848-902`：窗口安全配置、IPC、应用生命周期和服务装配。
- `src/main/settings.ts:17-220`：默认配置、配置 key、safeStorage 和采集配置版本。
- `src/main/database.ts:452-1037,4966-4979`：schema、迁移、SQLite 参数和同步历史内部方法。
- `src/preload/index.ts:54-245`：renderer 可用的 IPC 白名单。
- `scripts/prepare-local-resources.mjs`：embedding/OCR 资源准备和 manifest。
- `scripts/smoke-*.ts/.mjs`：领域、知识库、Dashboard、项目管理和 UI 回归。
- `agents.md`：持续开发和 UI 验收约束。
