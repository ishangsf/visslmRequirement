# 区域需求编号分析修复

## 验收场景

用户通过 `@通用数据助手` 提供四个区域的需求编号后缀，并声明统一前缀 `VISSLM-TSIS-`，要求按区域分析。华东区 6 个、西北区 2 个、西南区 12 个、北方区 17 个，共 37 个不同编号。

## 验收要求

- 从用户输入恢复完整编号及区域对应关系，不能把区域名称作为记录正文的必需匹配条件。
- 明确的区域编号清单不依赖意图分类和查询规划模型成功返回 JSON。
- 精确匹配编号；不能把更长编号、其他前缀或正文提到该编号的记录误认为目标需求。
- 查询遵守当前数据范围；全部 37 个编号都必须被核对，不能被普通列表的返回上限截断。
- 分区域展示可核验的记录内容、实际命中及未找到编号；缺失记录不能以其他记录代替。
- 保留证据引用和分组数据视图；分析模型不可用时，仍交付已核验的事实，并明确分析未完成。

## 修改前基线

以下命令均通过：

- `npm run typecheck`
- `npx tsx tests/assistant-planner-recovery-regression.ts`
- `npm run test:ai-assistant-intent`
- `npm run smoke:project-management`

工作区已有与本任务无关的修改，保留原状。本任务修改区域编号解析、通用助手路由与检索回答及其回归测试，并在数据库类新增一个精确批量编号读取方法，不修改数据库结构。

## 本机数据核对

2026-09-19 使用 Node `DatabaseSync` 的 `readOnly: true` 打开现有应用数据库，按 `records.item_id = ? COLLATE NOCASE` 核对完整编号，未修改数据库。全库范围：华东区 6/6、西北区 2/2、西南区 12/12、北方区 16/17；唯一未找到编号为 `VISSLM-TSIS-4015`。其余 36 个编号均仅对应一条记录。此核对证明本机场景有可用数据，不代表模型在线分析已通过验收。

## 交付状态

`ACCEPTED_WITH_RISKS`

代码与离线集成验收通过；在线模型的实际归纳质量尚未验证，也未替换正在运行的客户端。

## 实现与验证

- 区域编号清单直接形成查询计划，不依赖分类或规划模型；按完整编号读取，避开全文索引与关键词数量限制。
- 继承项目、节点类型、记录集合及基础过滤条件；按用户提供的区域分组，保留缺失编号、重复归属及空组。
- 回答模型收到全部目标记录的有界内容摘要；模型不可用时仍返回可核验事实并说明未生成归纳建议。引用校验在该路径支持超过原来的 20 条证据。
- `npx tsx tests/assistant-regional-requirements-regression.ts` 通过：原始 37 编号、空/无效/异常模型响应、成功分析的完整证据、后续编号引用、错误编号碰撞、范围限制、全空结果、组内去重及跨组归属。
- `npx tsx artifacts/regional-readonly-check.ts` 通过：先只读备份现有应用数据库，再对临时快照执行实际 `OllamaAgent.ask`；模拟模型连接失败仍完成，命中 36 条、分组 6/2/12/16、保留 36 个来源、明确缺少 4015。
- 修改后 `npm run typecheck`、`npx tsx tests/assistant-planner-recovery-regression.ts`、`npm run test:ai-assistant-intent`、`npm run smoke:project-management`、`npm run build` 均通过。
- `git diff --check` 通过。构建存在离线查看器大分包提示，不阻塞构建。本次不涉及 UI 样式或布局变更。

支持边界：一次最多 12 个区域、200 个区域编号条目。超出或缺少可确定前缀的简写不进入该直接执行路径，仍由既有流程处理。返回内容为有界摘录，完整记录通过证据入口核查。

## Windows 打包交付（2026-09-19）

打包状态：`ACCEPTED`。`npm run package -- --publish never` 成功生成 Windows x64 安装包 `release/VISSLM-Agent-Setup-1.5.0.exe`（535894607 字节）。已检查 app.asar 内包含区域需求解析和路由修复；`npm run verify:requirement-matching-package` 通过，12 个模型资源文件校验通过，隔离用户数据目录启动检查通过。未执行安装或发布。

SHA-256：`89fc7bf358fc26b3ac615316d687218b83940d2d1c9d5945faa4e02377ea981f`。
