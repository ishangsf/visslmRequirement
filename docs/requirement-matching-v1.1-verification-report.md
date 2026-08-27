# 需求历史匹配 v1.1 验证报告

验证日期：2026-08-28（Asia/Singapore）  
分支：`main`  
验证基线提交：`c0fd38a`（功能分支合并提交）  
内部交付结论：`ACCEPTED_WITH_RISKS`

## 已交付行为

- 项目需求内容自动进入统一匹配核心，自动召回数据中心历史需求，并按 `finalRank` / 版本化“综合匹配分”排序。
- 项目管理与需求分析 Agent 共享 `RequirementMatchingCore.match()` 及一致的结果投影。
- 50 条混合召回、20 条 Cross-Encoder 重排、10 条可选解释；精确业务哈希候选可补召。
- 动作、对象、否定和约束冲突确定性拒绝；字段不足降为歧义；仅合格精确业务哈希可确认重复。
- 模型解释不参与分数、排名或确认；外部解释需要显式授权。
- 匹配运行和候选追加保存，需求快照竞态失败不写部分候选；默认读取最新兼容成功运行。
- 新流程不写旧匹配表、不自动关联资产、不自动修改需求状态。
- UI 展示排名、综合匹配分、关系、决策、证据、运行版本和降级码，并声明分数不是统计概率。
- 发布模式为 `legacy_safe / shadow / v1_1`；默认 `v1_1`，非法持久化值回退 `legacy_safe`。

## 自动化验证证据

以下命令在功能分支变基后执行，并在合并后的 `main` 再次执行；全部退出 0：

- `npm run typecheck`
- `npm run test:requirement-matching-safety`
- `npm run test:requirement-matching-domain`
- `npm run test:requirement-matching-metamorphic`
- `npm run test:requirement-matching-gates`
- `npx tsx ./tests/requirement-matching/run-repository-regression.ts`
- `npx tsx ./tests/requirement-matching/run-service-regression.ts`
- `npx tsx ./tests/requirement-matching/ipc-contract-regression.ts`
- `npx tsx ./tests/requirement-matching/rollout-regression.ts`
- `npx tsx ./tests/requirement-matching/performance-contract-regression.ts`
- `npx tsx ./tests/requirement-matching/contract-regression.ts`
- `npx tsx ./tests/requirement-matching/current-index-regression.ts`
- `npx tsx ./tests/requirement-matching/formal-match-regression.ts`
- `npx tsx ./tests/requirement-matching/v2-regression.ts`
- `npm run smoke:project-management`
- `VISSLM_UI_STATIC_ONLY=1 npm run smoke:project-management-ui`
- `npm run smoke:project-matching-run-ui`
- `npm run smoke:agent-similarity`
- `npm run smoke:agent-requirement-analysis`
- `npm run build`

硬闸门结果：精确合格重复 `Recall@50 = 100%`；重复执行结果完全一致；项目与 Agent 投影一致；业务写入计数为 0；排序清单哈希为 `9c5ed8aa71146a86ce9f38892a4dce5fdcdf1ac34c209823719621cafd373285`。

## 性能证据

当前开发环境执行：

`npm run benchmark:requirement-matching -- --records 5000 --iterations 3 --warmup 1 --report-only`

合并后的最新结果：5000 条记录、4999 条当前索引；召回阶段 P50 `33.58 ms`、P95 `33.71 ms`，命令退出 0。该结果只覆盖 Dense、FTS5/BM25 与 RRF，不包含 Cross-Encoder 或解释模型。

## 已知风险与发布条件

仓库和当前开发环境没有打包的 `Xenova/bge-reranker-base` 本地资源，因此不能在本机诚实完成“真实 Cross-Encoder 端到端、目标硬件、5000 条”的基线与相对回归门禁。占位基线明确标记为 `BLOCKED_PENDING_TARGET_MODEL`，不得用于发布放行。

正式发布前必须在包含实际打包模型的指定目标硬件上记录端到端基线，并验证 P95 回归不超过 20%、峰值内存回归不超过 25%。在此之前，本实现功能和安全门禁通过，但性能发布证据仍是残余风险。

本方案按要求不使用人工评测集。自动化事实和变形测试只能证明确定性安全、协议正确、稳定性与一致性，不能推导开放域业务语义准确率；该语义质量限制作为持续风险保留。
