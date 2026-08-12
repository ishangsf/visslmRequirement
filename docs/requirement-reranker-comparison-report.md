# 需求重排模型技术对比报告

## 结论

本次已完成 `Xenova/bge-reranker-base` INT8 与 `onnx-community/bge-reranker-v2-m3-ONNX` INT8 的本地资源校验和同批业务输入技术测量。当前继续使用 `bge-reranker-base` 作为正式默认模型，`bge-reranker-v2-m3` 只保留为评测候选，不进入安装包，也不作为已通过精度验收的模型。

原因不是候选模型一定更差，而是当前人工金标仍为空脚手架。单个 hard-negative 查询只能证明两个模型会产生不同排序，不能证明任一模型达到正式匹配精确率、topic-only 误判率、nDCG@10 或 MRR 上线门槛。

## 可复现资源

固定清单位于 `test-data/requirement-matching/reranker-model-manifest.json`。

| 模型 | Revision | 许可 | INT8 资源体积 | 用途 |
| --- | --- | --- | ---: | --- |
| `Xenova/bge-reranker-base` | `280bcc27a84e0b898c251e06fddb25171bd9b101` | Apache-2.0 | 300,993,942 bytes | 当前正式默认、随安装包发布 |
| `onnx-community/bge-reranker-v2-m3-ONNX` | `6f5ff65298512715a1e669753bc754d2bc8f367b` | Apache-2.0，继承上游 BAAI 模型 | 587,813,009 bytes | 评测候选，不随安装包发布 |

候选模型最小 INT8 资源约为当前模型的 `1.95x`。两套资源均通过清单 byteSize 与 SHA-256 校验。

## 输入范围

从本机 VISSLM 数据中心只读提取 `VISSLM-TSIS-779`，并使用生产代码中的语义卡片构建逻辑生成查询文本。候选为固定回归中的 6 条记录：

`VISSLM-TSIS-889`、`376`、`613`、`395`、`528`、`1837`。

该输入属于合同级 hard-negative 样本，不是人工双人标注金标，不用于计算业务精度。

## 技术测量

环境：Windows x64、Node `v24.15.0`、28 逻辑 CPU、本地 Transformers.js、`max_length=512`、batch size 6、预热 1 次、测量 3 次。

| 指标 | bge-reranker-base | bge-reranker-v2-m3 | 候选相对变化 |
| --- | ---: | ---: | ---: |
| P50 推理耗时 | 431.747 ms | 1,196.159 ms | `2.77x` |
| P95 推理耗时 | 448.309 ms | 1,458.775 ms | `3.25x` |
| 模型资源体积 | 300,993,942 bytes | 587,813,009 bytes | `1.95x` |
| 排序 Kendall Tau | - | `-0.2` | 两者排序明显不同 |

测量进程中的 RSS 会受到两个模型顺序加载、ONNX Runtime 内存池和垃圾回收影响，因此本报告保留原始内存快照，但不把单进程 RSS 差值解释为稳定的独立模型峰值。正式选型需要隔离进程重复测量。

两模型在该查询上的排序：

- `bge-reranker-base`：`613 > 1837 > 395 > 376 > 528 > 889`
- `bge-reranker-v2-m3`：`889 > 1837 > 528 > 613 > 395 > 376`

这进一步说明 Cross-Encoder 只能负责候选重排，不能直接代替 AI 业务关系判定和硬规则校验。`889` 在固定验收中必须为 `topic_only`，无论它在候选模型中排名多高，都不得进入正式高度相似结果。

## 精度门槛状态

以下结论仍未被证明：

- Recall@50 `>= 98%`
- 高置信正式结果精确率 `>= 95%`
- topic-only 误判为高度相似的比例 `<= 5%`
- nDCG@10 和 MRR 明显优于当前版本
- `bge-reranker-v2-m3` 的业务效果优于 `bge-reranker-base`

原因是 `gold-scaffold.json` 仍为 `annotationStatus=scaffold`，没有不少于 200 条查询、3,000 至 5,000 个双人独立标注并经第三人裁决的需求对。

## 复现命令

先把候选模型最小 INT8 资源下载到不参与打包的本地目录，再执行：

```powershell
npm run export:requirement-reranker-inputs -- --database <visslm-agent.db> --base-item-id VISSLM-TSIS-779 --candidate-item-ids VISSLM-TSIS-889,VISSLM-TSIS-376,VISSLM-TSIS-613,VISSLM-TSIS-395,VISSLM-TSIS-528,VISSLM-TSIS-1837 --output tmp/requirement-reranker-inputs/VISSLM-TSIS-779.json

npm run compare:requirement-rerankers -- --manifest test-data/requirement-matching/reranker-model-manifest.json --base-path buildResources/models/Xenova/bge-reranker-base --candidate-path <candidate-model-directory> --inputs tmp/requirement-reranker-inputs/VISSLM-TSIS-779.json --run --warmup 1 --iterations 3 --batch-size 6
```

模型替换决定只能在正式人工金标集就绪并完成同批效果、延迟、内存和安装包体积比较后作出。
