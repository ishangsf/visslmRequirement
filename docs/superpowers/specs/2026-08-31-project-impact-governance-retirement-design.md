# 变更影响与项目治理功能退役设计

## 1. 背景与目标

项目管理模块此前增加了需求变更影响分析、追溯复核分派、决策审计、AI 辅助复核和项目治理中心。当前产品阶段暂不需要这些上层能力，应完整撤除其界面、公开合同、运行逻辑、持久化、导出和回归负担。

撤除不能破坏需求版本发布后的任务与资产关系安全。因此保留 Phase 1 建立的逻辑身份、版本追溯和发布重映射能力，仅硬删除 Phase 2–5 的上层功能及数据表。

## 2. 决策摘要

- 采用硬删除，而不是功能开关或仅隐藏入口。
- 物理删除 Phase 2–5 的五张数据库表，历史复核、AI 建议和治理确认数据不可恢复。
- 保留 `logicalId`、需求集版本、fingerprint、关系版本和 `traceStatus`。
- 保留发布时的逻辑身份重映射、匹配运行和候选数据。
- 旧 Snapshot 中的退役字段只被忽略，不恢复数据。
- 新 Snapshot 和 Excel 不再输出退役内容。
- 不重写 Git 历史；通过新的撤除变更表达产品决策。

## 3. 删除范围

### 3.1 共享合同

删除以下类型和公开 API 合同：

- 需求变更影响报告、变更类型、建议、批量决定。
- 追溯复核分派、优先级和状态。
- 追溯决定审计。
- AI 追溯复核运行、结果、授权、取消和失败状态。
- 项目治理提醒、确认、SLA 和 AI 用量汇总。

从 `AppApi` 删除：

- 获取需求变更影响报告。
- 应用追溯决定。
- 分派追溯复核。
- 查询决定审计。
- 启动、取消和查询 AI 复核。
- 获取治理报告和确认治理提醒。

### 3.2 主进程和服务

删除对应 IPC handler、preload bridge、项目管理 service 方法和 database 方法。删除 AI 复核后台 runner、提示词构建、模型输出解析、客户端工厂注入及取消控制。

项目管理服务构造器恢复为不依赖 AI 追溯复核客户端工厂的形式；其他需求提取和匹配模型能力不受影响。

### 3.3 数据库

启动迁移事务性执行：

```sql
DROP TABLE IF EXISTS pm_project_governance_acknowledgements;
DROP TABLE IF EXISTS pm_project_trace_ai_results;
DROP TABLE IF EXISTS pm_project_trace_ai_runs;
DROP TABLE IF EXISTS pm_project_trace_decision_audits;
DROP TABLE IF EXISTS pm_project_trace_reviews;
```

删除这些表的建表语句、索引、映射器、读写方法、启动恢复逻辑和项目级级联清理逻辑。`DROP TABLE IF EXISTS` 必须可重复执行。

不得删除或改变以下数据：

- `pm_requirement_sets`、`pm_requirements` 的逻辑身份和版本字段。
- 任务/资产需求关系中的逻辑身份、源/目标版本、`trace_status` 和 metadata。
- `pm_project_match_runs` 和 `pm_project_match_candidates`。
- 项目、任务、资产、需求、人员、成本和文档数据。

### 3.4 Renderer

删除：

- “变更影响”工作区、入口、摘要、需求/关系列表、批量决定和复核分派弹窗。
- 追溯决定审计 Tab。
- AI 辅助复核授权、运行记录、轮询、取消和结果选择。
- “项目治理”主 Tab、提醒表、SLA、AI 用量、筛选和确认弹窗。
- 对应状态、hooks、列定义、辅助函数、共享类型别名和 CSS。

保留任务和资产界面中的最小追溯状态提示、版本 Tooltip、手工解除和重新关联能力。`suspect` 关系不再有批量确认动作。

## 4. 保留的底层安全行为

### 4.1 发布重映射

发布需求新基线时：

- 相同 `logicalId` 唯一匹配的新需求继续自动重映射任务/资产关系，并保持 `valid`。
- 无唯一对应的新需求继续保留历史关系并标记为 `suspect`。
- 新基线继续使旧匹配运行进入 stale，防止旧候选冒充当前结果。
- 应用重启继续处理遗留 running 匹配运行。

### 4.2 手工维护

用户可在任务或资产现有编辑流程中解除 `suspect`/`invalid` 历史关系，再关联当前已发布需求。不得新增替代性的批量影响处理入口。

### 4.3 追溯矩阵

保留标准化 `traceMetadata` Snapshot 数据和 Excel“需求追溯矩阵”，用于说明当前任务/资产与需求版本之间的关系。该矩阵只表达关系事实，不提供影响分析、分派、决定或 AI 建议。

## 5. Snapshot 与导入兼容

从 `ProjectDataSnapshot` 删除：

- `traceReviews`
- `traceDecisionAudits`
- `traceAiReviewRuns`
- `traceAiReviewResults`
- `governanceAcknowledgements`
- `governanceReport`

新 v2 Snapshot 不再写出这些字段。

旧 JSON Snapshot 可能继续包含额外字段。导入解析必须容忍未知字段并忽略上述退役内容，不创建退役表，不返回虚假的恢复成功信息。v1 和旧 v2 的项目、需求集、需求、任务、资产、匹配运行、候选和 `traceMetadata` 继续正常导入。

## 6. Excel 导出

删除工作表：

- “追溯决策审计”
- “AI复核建议”
- “项目治理”

保留 10 张工作表：

1. 项目概览
2. 技术协议
3. 项目人员
4. 项目参与人
5. 成本明细
6. 项目资产
7. 项目计划
8. 功能需求
9. 需求匹配
10. 需求追溯矩阵

“需求追溯矩阵”继续包含逻辑身份、源/目标版本、追溯状态和验证 metadata，不包含责任分派、决定审计或 AI 建议。

## 7. 文档清理

删除尚未实施的“项目治理策略配置设计”规格，避免项目文档继续描述已撤除方向。保留 Git 提交历史，不修改或强推既有提交。

若其他用户文档、架构文档或代码映射明确声称退役功能可用，应同步删除或标记为已退役；不得扩大为无关文档重写。

## 8. 错误与迁移处理

- DROP 表迁移放在明确事务边界内，任一数据库错误必须回滚并阻止使用半迁移状态。
- 删除生产调用前先删除或调整调用方，最终 TypeScript 不得依赖退役类型。
- 旧 Snapshot 的退役字段静默忽略；其余缺失引用继续使用现有 warning/skip 规则。
- 迁移后重复启动不得重新创建退役表。
- 删除项目不得再执行退役表 SQL。
- 不提供从已删除表恢复数据的应用内入口。

## 9. 测试策略

### 9.1 动态 smoke

保留并验证：

- Phase 0 的需求审核和发布门禁。
- Phase 1 的 `logicalId`、fingerprint、发布重映射、suspect 保留和 stale match run。
- Snapshot v2 的需求集、需求、匹配运行、候选和 `traceMetadata` 映射。
- v1/旧 v2 兼容。
- 旧数据库迁移和多次启动幂等。

移除 Phase 2–5 的影响分析、分派、审计、AI 复核和治理测试。

新增负向断言：

- 五张退役表迁移后不存在。
- 新 Snapshot 不包含六个退役字段。
- 旧 Snapshot 携带退役字段仍可导入，但不会恢复对应数据。

### 9.2 UI smoke

删除对退役工作区的正向合同，新增负向静态断言，确保生产 renderer、preload 和 main 中不存在退役 Tab、按钮、API、IPC channel 和后台 runner。

继续验证任务/资产追溯状态、版本 Tooltip、历史关系保留、表格滚动和主题约束。

### 9.3 导出 smoke

- 期望精确的 10 张工作表。
- 验证三张退役工作表不存在。
- 验证“需求追溯矩阵”表头和数据仍完整。
- 空数据场景仍保留追溯矩阵表头。

### 9.4 最终门禁

执行：

- `npm run typecheck`
- `npm run smoke:project-management`
- `VISSLM_UI_STATIC_ONLY=1 npm run smoke:project-management-ui`
- `npm run smoke:project-matching-run-ui`
- `npm run smoke:project-export`
- `npm run build`
- 限定范围 `git diff --check`

真实 Electron 窗口走查确认项目详情 Tabs 没有空白、错位或退役入口残留，并检查暗色/亮色主题。

## 10. 验收标准

- 生产代码不再公开或调用 Phase 2–5 功能。
- 五张退役表物理删除且不会重建。
- 需求发布重映射、任务/资产关系和追溯矩阵继续工作。
- 新 Snapshot 和 Excel 不输出退役内容。
- 旧 Snapshot 不因额外退役字段导入失败。
- 无退役 UI、IPC、API、后台 runner、死代码或失效样式残留。
- 全部自动化门禁通过；真实 UI 走查无布局断层。

## 11. 数据不可恢复声明

执行该设计后，以下本地历史数据被永久删除：追溯复核分派、追溯决定审计、AI 追溯复核运行与建议、治理提醒确认。除非用户另有外部备份，否则应用无法恢复这些数据。需求、任务、资产、匹配和基础追溯关系不受此删除影响。
