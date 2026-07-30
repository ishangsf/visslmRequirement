# VISSLM Agent 桌面工具

一个面向 VISSLM 平台数据采集、检索、统计与本地 AI 问答的 Windows 桌面应用。

## 当前能力

- 配置 VISSLM 平台地址、用户名和 API Token，Token 使用 Electron `safeStorage` 加密后保存在当前 Windows 用户目录。
- 递归同步项目、集合、任务等节点，并保存原始 JSON 和便于知识检索的规范化文本。
- 扫描记录详情与附件中的图片，下载后转为 Base64；通过 SHA-256 去重，避免重复占用空间。
- 同步前可选择平台数据类型；类型字段从当前平台对象动态读取，并支持按字段值组合过滤采集范围。
- 提供项目/类型筛选、全文检索、记录详情、图片预览、数据量与类型分布统计。
- 导出知识库 JSONL，每行一条独立知识文档，图片以 Base64 Data URL 内联。
- 使用 Ollama 原生 Chat API 和工具调用完成本地 AI 问答；默认模型为 `qwen3:8b`。
- 通过 `@数据可视化专家` 生成结构化大屏，支持组件编辑、版本恢复、质量诊断和 JSON/PDF 导出。

## 使用

1. 确保 Ollama 正在运行，并已安装模型：

   ```powershell
   ollama pull qwen3:8b
   ```

2. 安装并启动 `VISSLM Agent`。
3. 在“系统配置”中填写平台配置与模型配置，分别测试连接并保存。
4. 在“数据同步”中选择数据类型，并按需添加字段过滤条件，然后保存范围或直接按配置同步。
5. 在“数据中心”查看、筛选和导出数据，或进入“AI 问答”提问。

## 本地开发

要求 Node.js 24 或与 Electron 43 兼容的 Node.js/npm 环境。

```powershell
npm install
npm run typecheck
npm run dev
```

构建与生成 Windows 安装包：

```powershell
npm run build
npm run package
```

## 数据存储

当前使用 Electron 内置 SQLite：

- 无需部署额外数据库服务，适合单机桌面工具。
- 支持事务、索引、FTS5 全文检索和可迁移的结构化表设计。
- SQLite 保存元数据、原始 JSON、规范化知识文本和图片索引；Base64 图片文件单独落盘，避免数据库被大对象迅速撑大。

如果后续出现多人共享、集中权限管理、高并发同步或超大规模向量检索需求，可保持现有数据访问接口不变，将存储层迁移到 PostgreSQL，并配合 `pgvector` 或独立向量数据库。当前阶段使用 SQLite 能减少部署复杂度，同时不会妨碍后续迁移。

## 安全说明

- API Token 不写入源码、日志或导出的知识库文件。
- 当前测试平台使用 HTTP，Token 在网络传输中无法获得 HTTPS 的链路保护。正式环境建议为 VISSLM 接口启用 HTTPS，并定期轮换 Token。
- 安装包目前未使用商业代码签名证书，Windows 可能显示未知发布者提示。

## 验证命令

`scripts/smoke-app.mjs` 会通过 Electron 预加载 API 验证平台连接、模型连接、同步、查询、统计和 Agent 问答。测试凭据只从环境变量读取：

```powershell
$env:VISSLM_TEST_USER='your-user'
$env:VISSLM_TEST_TOKEN='your-token'
node .\scripts\smoke-app.mjs
```

可视化专家的离线回归不需要连接 Ollama：

```powershell
npx tsx .\scripts\smoke-visualization-core.ts
npx tsx .\scripts\smoke-dashboard-versions.ts
npx tsx .\scripts\smoke-dashboard-quality.ts
npx tsx .\scripts\smoke-visualization-regression.ts
```

阶段 5 桌面 UI 回归需要先以 `9223` 端口启动 Electron 调试预览，然后执行：

```powershell
$env:VISSLM_CDP_PORT='9223'
node .\scripts\smoke-stage5-ui.mjs
```

该门禁在 1280×800 视口检查质量诊断抽屉、查询数据列表和记录详情，并把截图保存到系统临时目录。
