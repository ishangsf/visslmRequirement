# 需求重排模型技术对比报告

## 结论

已完成 `Xenova/bge-reranker-base` INT8 与 `onnx-community/bge-reranker-v2-m3-ONNX` INT8 的本地资源校验和同批业务输入技术测量。线上继续使用 `bge-reranker-base`；`bge-reranker-v2-m3` 只保留为技术候选，不进入安装包。

选择依据为当前自动化固定业务回归、推理延迟、资源体积、打包约束和运行稳定性。单个固定查询的排序差异不能替代最终 AI 业务关系判定和程序硬规则。

## 可复现资源

固定清单位于 `test-data/requirement-matching/reranker-model-manifest.json`。

| 模型 | Revision | 许可 | INT8 资源体积 | 用途 |
| --- | --- | --- | ---: | --- |
| `Xenova/bge-reranker-base` | `280bcc27a84e0b898c251e06fddb25171bd9b101` | Apache-2.0 | 300,993,942 bytes | 当前默认、随安装包发布 |
| `onnx-community/bge-reranker-v2-m3-ONNX` | `6f5ff65298512715a1e669753bc754d2bc8f367b` | Apache-2.0 | 587,813,009 bytes | 技术候选、不随安装包发布 |

候选模型最小 INT8 资源约为当前模型的 `1.95x`。两套资源均通过 byteSize 与 SHA-256 校验。

## 输入范围

从本机数据中心只读提取 `VISSLM-TSIS-779`，使用生产完整清洗原文构建查询文本，固定候选为：

`VISSLM-TSIS-889`、`376`、`613`、`395`、`528`、`1837`。

该输入用于固定业务回归和技术排序比较，不作为统计概率或固定准确率依据。

## 技术测量

环境：Windows x64、Node `v24.15.0`、28 逻辑 CPU、本地 Transformers.js、`max_length=512`、batch size 6、预热 1 次、测量 3 次。

| 指标 | bge-reranker-base | bge-reranker-v2-m3 | 候选相对变化 |
| --- | ---: | ---: | ---: |
| P50 推理耗时 | 431.747 ms | 1,196.159 ms | `2.77x` |
| P95 推理耗时 | 448.309 ms | 1,458.775 ms | `3.25x` |
| 模型资源体积 | 300,993,942 bytes | 587,813,009 bytes | `1.95x` |
| 排序 Kendall Tau | - | `-0.2` | 排序明显不同 |

单进程 RSS 会受到模型顺序加载、ONNX Runtime 内存池和垃圾回收影响，因此内存快照仅作为技术记录，不解释为稳定的独立模型峰值。

两模型在该查询上的排序：

- `bge-reranker-base`：`613 > 1837 > 395 > 376 > 528 > 889`
- `bge-reranker-v2-m3`：`889 > 1837 > 528 > 613 > 395 > 376`

`889` 在固定验收中必须为 `topic_only`。这说明 Cross-Encoder 只负责候选重排，不能直接替代 AI 业务关系判定和硬规则校验。

## 当前选型

继续使用 `bge-reranker-base`，原因如下：

- 已纳入当前自动化固定业务回归与失败关闭链路；
- 推理延迟明显低于候选模型；
- 模型资源约为候选模型的一半，安装包和磁盘压力更低；
- 已完成发布制品哈希、隔离安装、启动和卸载验证。

后续更换模型时，必须重新执行固定业务回归、异常路径、当前索引范围、技术排序对比、性能、资源哈希和安装包验证。

## 复现命令

```powershell
npm run export:requirement-reranker-inputs -- --database <visslm-agent.db> --base-item-id VISSLM-TSIS-779 --candidate-item-ids VISSLM-TSIS-889,VISSLM-TSIS-376,VISSLM-TSIS-613,VISSLM-TSIS-395,VISSLM-TSIS-528,VISSLM-TSIS-1837 --output tmp/requirement-reranker-inputs/VISSLM-TSIS-779.json

npm run compare:requirement-rerankers -- --manifest test-data/requirement-matching/reranker-model-manifest.json --base-path buildResources/models/Xenova/bge-reranker-base --candidate-path <candidate-model-directory> --inputs tmp/requirement-reranker-inputs/VISSLM-TSIS-779.json --run --warmup 1 --iterations 3 --batch-size 6
```
