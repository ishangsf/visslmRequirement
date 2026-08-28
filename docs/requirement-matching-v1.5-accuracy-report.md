# 项目需求与资产历史数据匹配 v1.5 准确性验证报告

## 验证结论

状态：`PASS`

本次验证使用生产匹配核心、真实本地 Embedding 和 `Xenova/bge-reranker-base`，未发生模型降级。构造业务场景下的排序、安全和稳定性门禁全部通过。

本报告验证构造业务场景下的技术准确性、安全性和排序稳定性，不代表开放域真实业务准确率。

## 构建与发布物

- 版本：`1.5.0`
- 源码提交：`58f679d130332f5b5b49ceca6b182e420c497ae1`
- 安装包：`release/VISSLM-Agent-Setup-1.5.0.exe`
- 安装包大小：`533990501` 字节
- 安装包 SHA-256：`6e542f7cd7e3503bcc2e3a8df3425401c5fdd2937673772953cfd93c08afff85`
- 打包资源：12 个模型文件的大小与 SHA-256 全部校验通过
- 隔离启动 smoke：通过，观察时长 `8458 ms`

模型资源：

- Embedding：`bge-small-zh-v1.5-local-v1`
- CrossEncoder：`bge-reranker-base-int8-local-v1`
- 匹配管线：`requirement-matching-pipeline-v1`
- 排序版本：`requirement-ranking-v1-cross-encoder`
- 配置哈希：`c8fc7bf0d939cd8cffc14865028e0fc1bbe7457c457b453fbe669f1ea12134b0`

## 测试数据

- 数据集版本：`requirement-matching-accuracy-v1.5`
- 固定种子：`requirement-matching-v1.5-seed`
- 快照 SHA-256：`3908346d438e2466da8deeadf1aec00ea7ab9bc5ee9a3490fc87ffb1b9c0ee91`
- 项目需求：24 条
- 历史候选：600 条
- 本地构造标签：600 条
- 业务域：需求管理、配置管理、缺陷管理、数据同步、权限审批、查询报表
- 评测耗时：`49190 ms`（重复运行 2 次）

标签来自固定生成规则，不来自人工判断，也不从历史关联反推。每次评测时，当前查询之外的 575 条候选按协议派生为 grade 0/unrelated，并继续参与真实全局检索。

## 指标与门禁

| 指标 | 结果 | 门槛 | 状态 |
| --- | ---: | ---: | --- |
| 精确重复 Recall@50 | 1.0000 | 1.0000 | PASS |
| 构造语义 Recall@5 | 1.0000 | ≥ 0.9000 | PASS |
| MRR | 1.0000 | ≥ 0.8000 | PASS |
| NDCG@10 | 0.9051 | ≥ 0.8500 | PASS |
| confirmed 精确率 | 1.0000 | 1.0000 | PASS |
| 硬冲突误确认率 | 0.0000 | 0.0000 | PASS |
| 正式业务写入数 | 0 | 0 | PASS |
| CrossEncoder 降级数 | 0 | 0 | PASS |
| 重复排序一致率 | 1.0000 | 1.0000 | PASS |
| 入口投影一致率 | 1.0000 | 1.0000 | PASS |

补充指标：精确 Recall@1=`0.5000`、精确 Recall@5=`1.0000`、语义 Recall@1/10/50 均为 `1.0000`。

## 执行命令

```powershell
npm run generate:requirement-matching-accuracy -- --output test-data/requirement-matching/v1.5/accuracy-dataset.json
npm run eval:requirement-matching-accuracy -- --dataset test-data/requirement-matching/v1.5/accuracy-dataset.json --output test-data/requirement-matching/v1.5/accuracy-result.json --repeat 2
npm run package
npm run verify:requirement-matching-package -- --installer release/VISSLM-Agent-Setup-1.5.0.exe --unpacked release/win-unpacked --output release/requirement-matching-v1.5-package-report.json
```

同时通过版本、数据集、指标边界回归，TypeScript 检查、自动匹配门禁和项目管理 smoke。

## 残余风险

- 本次数据为规则构造集，不能替代真实业务样本的长期线上观察。
- 当前高配开发机只用于功能与准确性验证；目标使用机器上的 P95 延迟和峰值内存门禁仍需后续单独执行。
