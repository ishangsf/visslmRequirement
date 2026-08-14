# VISSLM Agent

VISSLM Agent 是一个面向 Windows 的数据智能工作台，用于采集 VISSLM 平台数据、建立本地知识索引、进行数据问答、生成可追溯的数据大屏，并将本地数据按字段映射推送回 VISSLM。

项目采用 Electron + React + TypeScript 构建，默认使用 SQLite 保存本地数据。AI 对话支持 Ollama 本地模型，也支持多个在线模型服务；embedding 和 PDF OCR 资源在本地加载。

## 功能概览

### 数据采集与数据中心

- 配置 VISSLM 地址、用户名和 API Token，支持连接测试。
- 递归同步项目、集合、任务等节点，并保存原始 JSON 与规范化文本。
- 同步前按数据类型配置字段过滤条件、返回字段和采集范围，支持预览实际请求与匹配结果。
- 查看项目、节点类型、记录详情、附件图片、数据统计和采集请求日志。
- 记录支持全文检索、项目/类型筛选、批量删除，以及 JSON/JSONL 导入和 JSONL 导出。
- 附件图片下载后转为 Base64，并按 SHA-256 去重后单独保存。

### 本地知识库

- 支持批量上传 `DOCX`、`PDF`、`XLSX`、`XLS` 和 `TXT`，单个文件最大 100 MB。
- 自动解析、分块、去重、生成向量索引；失败文档可以重试，文档支持标签筛选和分块预览。
- PDF 保留页码，Excel 保留工作表名；扫描型 PDF 使用 `chi_sim` 和 `eng` OCR 语言资源补充识别。
- 默认使用 `Xenova/bge-small-zh-v1.5` 本地 embedding 模型，运行时禁止远程下载，不依赖 Ollama embedding 服务。
- 采集记录和上传文档共用本地向量检索能力，问答引用可打开对应的记录或文档详情。

### AI 助手与可视化专家

- 通用数据助手通过工具调用检索本地记录、字段、统计结果和知识库内容，不直接执行任意 SQL 或代码。
- 回答可以附带来源引用、查询数据表和记录详情；无证据时会明确说明未检索到结果。
- `@需求分析专家` 支持一个或多个需求编号定位数据中心记录；编号先做精确查找，不把自然语言相似度当作编号定位依据。
- 需求分析会先清洗原始需求文本并构建语义卡片，再执行 Dense、本地 FTS5/BM25 和结构化字段的 RRF 混合召回（保留前 50 条），由本地 Cross-Encoder 重排后交给 AI 做业务关系初审和独立复核（前 20 条）。
- 复核只允许 `duplicate`、`highly_similar`、`partial_overlap`、`same_pattern`、`topic_only`、`unrelated` 六类关系；结果按“正式匹配”和“参考关联需求”分组，并校验原始证据。必要阶段失败时不回退到向量分，也不输出未经验证的候选结论。
- 通过 `@数据可视化专家` 或“可视化大屏”入口生成结构化 Dashboard。
- 支持字段画像、数据范围、指标聚合、趋势分析、全局筛选器、组件数据口径和受限自定义公式。
- 支持组件编辑、对话式修改、版本保存与恢复、质量诊断、PNG/PDF/JSON 导出和操作审计。

### 数据推送

- 在“数据推送”中选择本地记录，预览将要发送的请求和消息体。
- 支持目标节点类型、项目 UID、父节点、插入位置和源字段到目标字段的映射。
- 预览不会发送请求；真实推送使用 VISSLM `POST /alm/rest/items` 接口，并保留请求日志和逐条成功/失败状态。
- `_valm_Uid`、`_valm_NodeType` 和 `_valm_ItemID` 会从推送消息体中强制移除，避免把本地标识误当作新记录标识。

## 快速开始

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows x64 |
| Node.js | Node.js 24，或与 Electron 43 兼容的版本 |
| 包管理器 | npm |
| 本地模型 | 使用本地 AI 时需要 Ollama；需求分析精准匹配还需要本地 Cross-Encoder 资源 |
| 网络 | 首次准备 embedding/OCR 资源、访问 VISSLM 或使用在线模型时需要网络 |

### 安装与启动

```powershell
npm install
npm run typecheck
npm run dev
```

如果要使用知识库或需求分析精准匹配，先准备本地 embedding、Cross-Encoder 和 OCR 资源：

```powershell
npm run prepare:model
```

使用 Ollama 本地模型时，先启动 Ollama 并下载默认模型：

```powershell
ollama pull qwen3:8b
```

首次启动后按以下顺序配置：

1. 打开“系统配置”，填写 VISSLM 平台地址、用户名和 API Token，测试并保存。
2. 选择“本地大模型”或“在线大模型”，填写模型服务地址、模型名称及必要的 API Key，测试并保存。
3. 打开“数据采集”，选择数据类型和字段过滤条件，先预览范围，再保存配置并开始同步。
4. 在“资产中心”查看采集记录，或上传文档到“知识库”并等待索引完成。
5. 在“AI 助手”中提问；需要制作大屏时使用 `@数据可视化专家`，或把当前数据范围交给可视化专家。
6. 如需回写平台，在“数据推送”中先检查请求预览，再确认真实推送。

## 模型配置

### 本地 Ollama

- 默认地址：`http://127.0.0.1:11434`
- 默认模型：`qwen3:8b`
- 使用 Ollama 原生 `/api/tags` 和 `/api/chat` 接口。
- “思考模式”可在模型配置中开启或关闭；本地 Ollama 使用原生 `think` 参数。

### 在线模型

设置页内置以下服务商适配：OpenAI、Anthropic、DeepSeek、通义千问、智谱 AI、Moonshot、MiniMax，以及 OpenAI 兼容接口。配置时需要填写对应的 API 地址、模型名称和 API Key。

在线模型也支持配置“思考模式”。应用会按服务商协议传递开关：OpenAI 推理模型使用 `reasoning_effort`，DeepSeek 和智谱 AI 使用 `thinking.type`，通义千问使用 `enable_thinking`，Anthropic 使用对应的 `thinking` 配置。MiniMax M 系列等思考模型的能力可能由模型固定提供，不能通过通用接口关闭。是否真正生效仍取决于所选模型；不支持该参数的模型可能忽略开关或返回接口错误。

在线模型会接收发送给模型的对话上下文、检索结果和生成任务数据。使用前应确认数据合规要求；API Key 使用 Electron `safeStorage` 加密后保存，不写入源码、日志或导出文件。

## 构建与打包

构建前端和 Electron 主进程：

```powershell
npm run build
```

生成 Windows x64 NSIS 安装包：

```powershell
npm run package
```

只生成未安装的 Windows 目录包：

```powershell
npm run package:dir
```

`package` 和 `package:dir` 会自动执行 `npm run prepare:model`，完成以下步骤：

1. 从固定 revision 的 `Xenova/bge-small-zh-v1.5` 下载 embedding 文件。
2. 从固定 revision 的 `Xenova/bge-reranker-base` 下载本地 Cross-Encoder 文件。
3. 下载 Tesseract `chi_sim`、`eng` 语言资源。
4. 将资源写入 `buildResources/models` 和 `buildResources/ocr`，并生成资源 manifest。
5. 通过 Electron Builder 的 `extraResources` 打入安装包。

因此，打包机器需要能够访问 Hugging Face 和 OCR 资源地址；安装后的应用不会为了 embedding、Cross-Encoder 或 OCR 再次联网下载资源。模型和 OCR 资源目录已加入 `.gitignore`，不应提交到仓库。

## 环境变量

以下变量用于资源准备、测试或特殊部署场景：

| 变量 | 用途 |
| --- | --- |
| `VISSLM_RESOURCE_ROOT` | 覆盖本地 embedding、Cross-Encoder 和 OCR 资源根目录；资源准备和运行时定位都会读取 |
| `VISSLM_EMBEDDING_MODEL_PATH` | 指定 embedding 模型目录，目录中应能找到 `config.json` |
| `VISSLM_HF_ENDPOINT` | 覆盖 Hugging Face 下载地址，适用于镜像或内网代理 |
| `VISSLM_OCR_ENDPOINT` | 覆盖 Tesseract 语言包下载地址 |
| `VISSLM_KNOWLEDGE_TEST_FALLBACK` | 设置为 `1` 时启用测试用 hash embedding，不建议生产环境使用 |
| `VISSLM_TEST_USER` / `VISSLM_TEST_TOKEN` | `smoke-app.mjs` 使用的测试凭据 |
| `VISSLM_CDP_PORT` | UI 回归脚本使用的 Electron CDP 端口，默认 `9223` |

例如使用内网镜像准备资源：

```powershell
$env:VISSLM_RESOURCE_ROOT='D:\visslm-resources'
$env:VISSLM_HF_ENDPOINT='https://your-hf-mirror.example.com'
$env:VISSLM_OCR_ENDPOINT='https://your-ocr-mirror.example.com'
npm run prepare:model
```

## 数据存储

应用使用 Electron 的 `app.getPath('userData')` 作为数据目录，主要文件包括：

```text
<userData>\
├─ visslm-agent.db       # SQLite 数据库，包含 WAL、FTS5、配置和索引数据
└─ assets\base64\        # 按 SHA-256 保存的附件 Base64 文件
```

SQLite 保存平台记录、原始 JSON、规范化文本、知识库文档与分块、向量、Dashboard 版本、同步/推送日志和审计记录。Token、API Key 的密文也保存在数据库中，但只能通过当前操作系统用户的安全存储解密。

备份或迁移数据前请先退出应用，再一起保存数据库文件和 `assets\base64` 目录。知识库源文件仍保留原始文件路径；如果需要重新解析或重建索引，应确保源文件路径仍然有效。

## 验证与回归

### 静态检查

```powershell
npm run typecheck
npm run build
```

### 端到端 smoke

`smoke-app.mjs` 需要已经启动带 CDP 调试端口 `9223` 的 Electron，并从环境变量读取测试凭据：

```powershell
$env:VISSLM_TEST_USER='your-user'
$env:VISSLM_TEST_TOKEN='your-token'
node .\scripts\smoke-app.mjs
```

它会覆盖平台连接、模型连接、数据同步、查询、统计、Agent 问答和可视化工作台的基础链路。

### 知识库验证

```powershell
npm run knowledge:smoke
```

该脚本验证文档解析、重复文件去重、失败重试、记录增量索引和向量检索。

### 需求分析精准匹配与技术验证

```powershell
npm run smoke:agent-requirement-analysis
```

该命令是需求编号分析的窄范围 smoke 入口，覆盖多编号分组、原文清洗、全量 Dense/BM25/结构化混合召回、Cross-Encoder Top20 重排、确定性评分、Top10 一次批量 AI 解释、UID/证据严格校验、持久化缓存和失败关闭。运行真实匹配前应执行 `npm run prepare:model`，使本地 embedding 和 Cross-Encoder 资源可用；未就绪的语义卡片不会触发查询时 AI 生成，系统继续使用完整清洗原文参与召回和匹配。Dense、FTS5 和结构化召回都只在当前 embedding `modelVersion` 已建立向量索引的记录 UID 集合内运行。

自动化回归和性能基准命令：

```powershell
npm run benchmark:requirement-matching -- --records 5000 --report-only
npm run compare:requirement-rerankers -- --manifest test-data/requirement-matching/reranker-model-manifest.json --report-only
```

`test-data/requirement-matching` 仅保留固定行为回归和模型资源清单。项目不再建设人工金标、双人标注/裁决、Excel 标注样本包或依赖人工标签的质量门禁。匹配百分比继续称为“综合匹配度”，表示经过确定性评分、硬规则校验和可选 AI 解释后的业务判断分，不解释为统计概率。

### 可视化离线回归

以下测试不需要连接 Ollama：

```powershell
npm run smoke:dashboard-audit
npm run smoke:query-formulas
npx tsx .\scripts\smoke-visualization-core.ts
npx tsx .\scripts\smoke-analytics-cache.ts
npx tsx .\scripts\smoke-query-calculations.ts
npx tsx .\scripts\smoke-dashboard-versions.ts
npx tsx .\scripts\smoke-dashboard-quality.ts
npx tsx .\scripts\smoke-dashboard-governance.ts
npx tsx .\scripts\smoke-dashboard-drafts.ts
npm run smoke:dashboard-editor
npm run smoke:dashboard-golden
npm run smoke:dashboard-performance
npm run smoke:dashboard-visual-matrix
npm run smoke:dashboard-pixel-diff
npx tsx .\scripts\smoke-visualization-regression.ts
```

### 桌面 UI 回归

UI 回归脚本通过 Electron CDP 检查实际页面。请先用支持 `--remote-debugging-port=9223` 的 Electron 启动方式打开应用，再运行：

```powershell
$env:VISSLM_CDP_PORT='9223'
node .\scripts\smoke-stage5-ui.mjs
node .\scripts\smoke-asset-center-ui.mjs
node .\scripts\smoke-data-visualization-handoff.mjs
node .\scripts\smoke-chat-mention.mjs
node .\scripts\smoke-push-config-ui.mjs
npx tsx .\scripts\smoke-expert-progress.ts
```

部分 UI 脚本会在系统临时目录生成截图或检查产物。`smoke-app.mjs` 固定连接 `9223` 端口；其余支持 CDP 端口的脚本可通过 `VISSLM_CDP_PORT` 覆盖默认值。

## 项目结构

```text
src/
├─ main/                         # Electron 主进程与业务服务
│  ├─ index.ts                   # 窗口、IPC 和应用生命周期
│  ├─ visslm.ts                  # VISSLM API、同步和推送
│  ├─ database.ts                # SQLite、FTS5、数据迁移
│  ├─ knowledge.ts               # 文档解析、OCR、embedding、向量检索
│  ├─ ollama.ts                  # 通用数据助手与工具调用
│  ├─ model-client.ts            # Ollama/在线模型适配
│  ├─ requirements/              # 需求语义卡片、混合召回和本地重排
│  └─ experts/                   # 专家路由和可视化生成
├─ preload/                      # 安全暴露给渲染进程的 IPC API
├─ renderer/src/                 # React 页面和 Dashboard 工作台
└─ shared/                       # 主进程与渲染进程共用类型和查询协议
scripts/                         # 资源准备、smoke 和回归脚本
buildResources/                  # 打包时生成的模型与 OCR 资源
```

## 安全注意事项

- API Token 和在线模型 API Key 使用操作系统安全存储加密；日志和请求预览会脱敏 Token。
- 当前 VISSLM 测试接口如果使用 HTTP，Token 不具备 HTTPS 传输保护。正式环境应启用 HTTPS 并定期轮换 Token。
- 请求日志、推送日志和 Dashboard 审计可能包含业务字段或响应内容，导出和共享前请检查数据范围。
- 使用在线模型时，相关上下文会离开本机并发送到配置的模型服务商；对敏感数据应优先使用本地模型或经过批准的内部接口。
- 安装包当前未配置商业代码签名证书，Windows 可能显示未知发布者提示。

## 常见问题

### 知识库提示 embedding 资源不存在

在项目根目录执行 `npm run prepare:model`。如果使用了自定义资源目录，确认 `VISSLM_RESOURCE_ROOT` 或 `VISSLM_EMBEDDING_MODEL_PATH` 指向包含模型配置文件的目录。

### 需求分析提示精准匹配失败关闭

确认 `buildResources/models/Xenova/bge-reranker-base` 下包含 `config.json`、`onnx/model_int8.onnx`、tokenizer 和 SentencePiece 文件，并检查 `buildResources/models/manifest.json` 的 `crossEncoder` 条目。也可设置 `VISSLM_RESOURCE_ROOT` 指向包含 `models/Xenova/bge-reranker-base` 的资源根目录后重启应用。Cross-Encoder 只允许本地文件加载；资源缺失、模型输出 UID/分数不合法、AI 结构化复核失败或原始证据校验失败时，该需求编号进入失败关闭路径，不使用向量召回分兜底。

### 需求分析没有可验证结果

先确认需求编号确实存在于数据中心，且记录描述或规范化文本不为空；再检查本地 embedding 索引、模型配置和主进程日志。没有通过完整候选覆盖、关系/分数校验和原始证据校验的记录不会进入来源或结果表；可见结果只包含正式匹配或参考关联需求。

### Ollama 已启动但模型连接测试失败

确认 Ollama 服务地址与设置页一致，并执行：

```powershell
ollama list
ollama pull qwen3:8b
```

### 同步没有记录

先在“数据采集”中执行预览，检查平台地址、用户名、Token、节点类型和字段过滤条件。采集请求的状态、HTTP 状态码和错误信息可在请求日志中查看。

### UI 回归提示找不到 CDP target

确认 Electron 已启动远程调试端口，端口与脚本一致，并且页面标题为 `VISSLM Agent`。支持端口变量的脚本可以设置 `VISSLM_CDP_PORT`；`smoke-app.mjs` 使用固定的 `9223`。

## 许可与第三方资源

仓库当前未提供独立的项目 LICENSE 文件。随应用准备的 `Xenova/bge-small-zh-v1.5` embedding 模型和 Tesseract 语言资源均带有 Apache-2.0 许可信息，具体来源、revision、文件哈希和许可记录会写入 `buildResources/models/manifest.json` 与 `buildResources/ocr/manifest.json`。
