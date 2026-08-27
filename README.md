# VISSLM Agent

VISSLM Agent 是一个面向 Windows 的数据智能工作台，用于采集 VISSLM 平台数据、建立本地知识索引、进行数据问答、生成可追溯的数据大屏，并将本地数据按字段映射推送回 VISSLM。

项目采用 Electron + React + TypeScript 构建，默认使用 SQLite 保存本地数据。AI 对话支持 Ollama 本地模型，也支持多个在线模型服务；embedding 和 PDF OCR 资源在本地加载。

## 功能概览

### 数据采集与数据中心

- 配置 VISSLM 地址、用户名和 API Token，支持连接测试。
- 递归同步项目、集合、任务等节点，并保存原始 JSON 与规范化文本。
- 采集每种数据类型前通过平台网页登录会话读取字段目录，按原始属性 Key 保存显示名、声明类型、平台类型和字段标志；字段目录暂时不可用时保留最近一次成功缓存并继续采集。
- 同步前按数据类型配置字段过滤条件、返回字段和采集范围，支持预览实际请求与匹配结果。
- 可配置用户属性 Key；采集请求会将这些 Key 强制加入 `ReturnProperty`，对非空值解析用户显示名并补充 `${key}_text`（对象属性补充 `key_text`）。字符串支持英文/中文逗号、英文/中文分号分隔，trim 后忽略空片段；多值字符串以英文逗号写回、数组保持数组，对象的 `key` 按相同规则写入 `key_text`，顺序、重复项及其位置保持，登录名查询缓存去重。配置了非空 Key 时，采集需要平台登录密码。
- 每次同步都会按 `_valm_ItemID` 刷新已有本地记录的最新属性值；本地 UID 和项目关联保持不变，新增字段需加入对应类型的 `ReturnProperty`。
- 查看项目、节点类型、记录详情、附件图片、数据统计和采集请求日志。
- 记录支持全文检索、项目/类型筛选、批量删除，以及 `.visslmpack` 二进制资源包导出；仍兼容旧 JSON/JSONL 导入。
- 旧 JSON/JSONL 导入按 256 条批次流式解析和提交，避免把大文件与完整记录数组同时驻留内存；导入过程中可继续使用应用内的记录索引能力。
- 正文图片下载后按 SHA-256 内容寻址保存到二进制资源目录；富文本只保存资源令牌，避免 Base64 放大数据文件。
- 下载失败、签名/MIME 校验失败的正文图片会标记为 `unresolved`；这类记录不会被资源包完整导出，也不会调用平台创建接口。

### 本地知识库

- 支持批量上传 `DOCX`、`PDF`、`XLSX`、`XLS` 和 `TXT`，单个文件最大 100 MB。
- 自动解析、分块、去重、生成向量索引；失败文档可以重试，文档支持标签筛选和分块预览。
- PDF 保留页码，Excel 保留工作表名；扫描型 PDF 使用 `chi_sim` 和 `eng` OCR 语言资源补充识别。
- 默认使用 `Xenova/bge-small-zh-v1.5` 本地 embedding 模型，运行时禁止远程下载，不依赖 Ollama embedding 服务。
- 采集记录和上传文档共用本地向量检索能力，问答引用可打开对应的记录或文档详情。

### AI 助手与可视化专家

- 未在当前消息 `@` 专家时自动判断问题类型：普通问题使用普通对话，明确涉及本地数据或需求编号时自动调用对应数据能力；也可以明确 `@通用数据助手`、`@需求分析专家` 或 `@数据可视化专家`。
- 无 `@` 的需求编号分析只按编号精确提取本地记录并把原文/字段交给大模型，不执行内置需求匹配、召回、重排或评分；需要内置匹配时请使用 `@需求分析专家`。
- 通用数据助手通过工具调用检索本地记录、字段、统计结果和知识库内容，不直接执行任意 SQL 或代码；规划字段查询时同时参考平台显示名、声明类型和采集值观察类型。
- 回答可以附带来源引用、查询数据表和记录详情；无证据时会明确说明未检索到结果。
- `@需求分析专家` 支持一个或多个需求编号定位数据中心记录；编号先做精确查找，不把自然语言相似度当作编号定位依据。
- 需求分析会清洗原始需求文本，再执行完整原文 Dense 与本地 FTS5/BM25 的 RRF 混合召回（大索引先做粗向量候选预筛，最终保留前 50 条），由本地 Cross-Encoder 重排、程序确定性评分，并对前 10 条候选进行一次批量 AI 关系解释。
- 复核只允许 `duplicate`、`highly_similar`、`partial_overlap`、`same_pattern`、`topic_only`、`unrelated` 六类关系；结果按“正式匹配”和“参考关联需求”分组，并校验原始证据。必要阶段失败时不回退到向量分，也不输出未经验证的候选结论。
- 通过 `@数据可视化专家` 或“可视化大屏”入口生成结构化 Dashboard。
- 支持字段画像、数据范围、指标聚合、趋势分析、全局筛选器、组件数据口径和受限自定义公式。
- 支持组件编辑、对话式修改、版本保存与恢复、质量诊断、PNG/PDF/JSON 导出和操作审计。

### 数据推送

- 在“数据推送”中选择本地记录，预览将要发送的请求和消息体。
- 支持目标节点类型、项目 UID、父节点、插入位置和源字段到目标字段的映射。
- 首次进入时字段映射默认取第一条记录的全部可推送属性，其中 `Source` 默认映射到 `RequireBy`、`_valm_Description` 映射到 `UserStoryDescription`、`_valm_ItemID` 映射到 `AcceptCriteria`、`RAO` 映射到 `Devs`、`TSIS_ClarifyInfo` 映射到 `_valm_Description`；配置会在切换导航后保留，未映射属性不会写入请求消息体。
- 预览不会发送请求；真实推送使用 VISSLM `POST /alm/rest/items` 接口，并保留请求日志和逐条成功/失败状态。
- 正文中的每个唯一图片资源在每次推送时都会先调用 `FileCenterImg/UploadRichImg`；同一条记录内内容相同的图片只上传一次并复用本次返回路径。上传成功后替换正文链接，最后才调用 `/rest/items` 创建记录；任何图片失败时都不会创建对应记录。
- `_valm_ItemID` 仅允许作为源属性，默认映射到 `AcceptCriteria`，其原键不会进入消息体；`_valm_Uid`、`_valm_NodeType` 不允许作为源属性，三者均不允许作为目标属性。

## 快速开始

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 或更高版本（x64） |
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

1. 打开“系统配置”，填写 VISSLM 平台地址、用户名、API Token，以及用于字段定义读取、用户显示名查询和富文本图片上传的网页登录密码，然后测试并保存。API Token 用于 REST 接口；平台登录密码用于需要 `JSESSIONID` 的网页接口。采集字段定义或配置了非空用户属性 Key 时需要该密码；两类凭据均使用操作系统安全存储加密，界面不回显明文。
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

设置页内置以下服务商适配：OpenAI、Anthropic、DeepSeek、通义千问、智谱 AI、Moonshot、MiniMax、RawChat Codex（Responses），以及 OpenAI 兼容接口。配置时需要填写对应的 API 地址、模型名称和 API Key。

RawChat Codex 使用 Responses API，不是 Chat Completions。请选择“RawChat Codex（Responses）”，API 地址填写 `https://rawchat.cn/codex`，模型填写 RawChat 控制台已开通的模型（例如 `gpt-5.6-sol`），再保存并点击“测试模型”。为兼容旧配置，选择“OpenAI 兼容接口”但仍填写该 RawChat 地址时，客户端也会自动切换到 Responses 协议。

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
└─ assets\
   ├─ blobs\<sha 前 2 位>\<sha256>  # 按 SHA-256 保存的二进制图片资源
   └─ base64\                  # 旧版本迁移兼容目录（迁移成功后清理无引用文件）
```

SQLite 保存平台记录、原始 JSON、规范化文本、知识库文档与分块、向量、Dashboard 版本、同步/推送日志和审计记录。Token、API Key 的密文也保存在数据库中，但只能通过当前操作系统用户的安全存储解密。

备份或迁移数据前请先退出应用，再一起保存数据库文件和 `assets` 目录。跨设备传输优先使用“导出资源包”，它会把记录元数据、令牌化富文本和去重后的二进制图片打包到一个 `.visslmpack` 文件中。知识库源文件仍保留原始文件路径；如果需要重新解析或重建索引，应确保源文件路径仍然有效。

## 验证与回归

### 静态检查

```powershell
npm run typecheck
npm run build
npm run smoke:visslm-pack
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

该命令是需求编号分析的窄范围 smoke 入口，覆盖多编号分组、原文清洗、全量 Dense/BM25 混合召回、Cross-Encoder Top20 重排、确定性评分、Top10 一次批量 AI 解释、UID/证据严格校验和失败关闭。运行真实匹配前应执行 `npm run prepare:model`，使本地 embedding 和 Cross-Encoder 资源可用。Dense 与 FTS5 只在当前 embedding `modelVersion` 已建立向量索引的记录 UID 集合内运行。

自动化回归和性能基准命令：

```powershell
npm run smoke:performance-regressions
npm run smoke:data-import-stream
npm run smoke:request-retry
npm run smoke:itemid-dedup
npm run smoke:vector-prefilter
npm run smoke:dashboard-performance
npm run benchmark:requirement-matching -- --records 5000 --report-only
npm run compare:requirement-rerankers -- --manifest test-data/requirement-matching/reranker-model-manifest.json --report-only
```

知识库上传、重建和记录索引均有可取消的后台任务边界，最多同时保留 2 个重任务；应用重启会把遗留索引任务标为可重试，并自动恢复排队文档。进度事件会显示耗时和单位吞吐，指标也会保存到任务快照，便于重启后诊断大文件处理速度。新向量会持久化低维粗向量和分片提示，旧数据按批渐进回填；完全相同的问题在 15 秒内复用有界搜索结果，大于 4096 条候选的向量检索先用固定容量小顶堆做粗向量预筛，再进行精确重排。当前任务边界是主进程内的 cooperative checkpoint，单次原生 embedding/OCR/模型调用不会被强制中断；需要更强隔离时再迁移到 worker/子进程。

旧 JSON/JSONL 导入会返回 `importRunId`，并在本地 `data_import_runs` 中记录批次数、源行数、解析错误数、重复审查批次和中断状态；数据中心的“导入运行记录”抽屉可在重启后查看这些检查点，并从原文件继续未提交前缀之后的批次。启动时会把遗留运行标记为失败并保留已提交批次的诊断线索。该记录不改变批次提交边界，若业务要求全有或全无仍需另行确认。

Renderer 和离线大屏使用按需注册的 ECharts 组件，PNG 导出库也只在点击导出时加载，避免把不常用依赖打入首屏；最近一次构建中 ECharts vendor chunk 约 1.62 MB，离线 viewer 约 1.49 MB。

VISSLM 查询、附件下载和采集预览等幂等 GET 请求对瞬时网络错误及 408/425/429/5xx 使用最多 3 次退避重试；创建记录和图片上传不会盲目重放，待平台明确幂等键后再启用可审计的 POST 重试。

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
│  ├─ requirements/              # 需求原文匹配、混合召回和本地重排
│  └─ experts/                   # 专家路由和可视化生成
├─ preload/                      # 安全暴露给渲染进程的 IPC API
├─ renderer/src/                 # React 页面和 Dashboard 工作台
└─ shared/                       # 主进程与渲染进程共用类型和查询协议
scripts/                         # 资源准备、smoke 和回归脚本
buildResources/                  # 打包时生成的模型与 OCR 资源
```

## 安全注意事项

- API Token、平台网页登录密码和在线模型 API Key 使用操作系统安全存储加密；日志和请求预览不会输出 Token、密码或 Cookie 值。
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

### RawChat Codex 测试失败

- 若提示 API Key 无效、已撤销或未正确填写，请在 RawChat 控制台重新生成 Key，并在设置页重新保存；不要把 Key 写入源码、日志或截图。
- 若提示当前 Key 未开通 Codex，请确认账户/Key 已启用 Codex 权限，或更换已开通 Codex 的 Key。
- 确认地址是 `https://rawchat.cn/codex`，不要把 `/chat/completions` 拼到地址后；客户端会自动请求 `/models` 和 `/responses`。
- 你曾经在聊天中公开过的 Key 应立即撤销，即使之后不再使用它也不能继续视为安全凭据。

### 同步没有记录

先在“数据采集”中执行预览，检查平台地址、用户名、Token、节点类型和字段过滤条件。采集请求的状态、HTTP 状态码和错误信息可在请求日志中查看。

### UI 回归提示找不到 CDP target

确认 Electron 已启动远程调试端口，端口与脚本一致，并且页面标题为 `VISSLM Agent`。支持端口变量的脚本可以设置 `VISSLM_CDP_PORT`；`smoke-app.mjs` 使用固定的 `9223`。

## 许可与第三方资源

仓库当前未提供独立的项目 LICENSE 文件。随应用准备的 `Xenova/bge-small-zh-v1.5` embedding 模型和 Tesseract 语言资源均带有 Apache-2.0 许可信息，具体来源、revision、文件哈希和许可记录会写入 `buildResources/models/manifest.json` 与 `buildResources/ocr/manifest.json`。
# 需求历史匹配 v1.1

项目需求会自动在当前可搜索的数据中心历史记录中执行 Dense/BM25 召回、RRF 融合、Cross-Encoder 重排和确定性策略判断，并按版本内的“综合匹配分”排序。该分数表示同一排序版本中的相对匹配程度，不是概率或业务准确率。

匹配结果按不可变运行保存。默认读取与当前需求快照兼容的最新成功运行，历史运行可显式查询；需求或索引变化后旧运行会标记为 stale。只有合格的精确业务哈希可得到 `confirmed + duplicate`，其他结果均为建议、歧义或拒绝。语义分数不会自动关联项目资产，也不会自动把需求改为“已满足”。

发布模式支持 `legacy_safe`、`shadow` 和 `v1_1`。回滚只切换安全读取路径，不恢复任何自动业务写入。当前自动化评测覆盖确定性事实、变形关系、重放一致性、精确重复 Recall@50、协议失败和零业务写入；它不使用人工评测集，也不宣称开放域业务语义准确率。
