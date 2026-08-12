# VISSLM Agent 需求分析专家精准匹配升级：目标与交付说明

> 用途：立项、开发验收和发布评审。本文按当前实现、自动化测试、模型资源和发布制品整理。

## 1. 建设目标

建设 VISSLM Agent 的“需求分析专家精准匹配能力”。用户通过 `@需求分析专家` 输入一个或多个数据中心需求编号后，系统精确定位基准需求，在当前 embedding 模型版本已建立有效索引的全部数据中心记录中，识别业务目标真正相同、相近或部分重叠的需求，并返回名称、描述、模块、需求类型和可解释的综合匹配度。

“精准匹配”以业务目标为准，不以关键词、产品域、模块或记录类型相同为充分条件。系统同时比较需求类型、功能对象、目标动作、当前状态、目标状态、触发条件、输入输出、约束和验收结果；仅主题相同、模块相同或动作模式相同但业务对象不同的记录，不得直接判为正式匹配。

## 2. 可实施目标

1. **输入与定位**：一次输入 1-20 个需求编号，自动去重、大小写不敏感并保持输入顺序。编号不存在、详情不可读或没有需求文本时，返回明确状态，不猜测基准需求。
2. **候选范围**：候选限于当前 embedding `modelVersion` 已建立有效向量索引、且存在可比较文本的数据中心记录；不按模块、产品域、项目、需求类型或节点类型预过滤；排除本次输入的全部基准 UID。
3. **文本标准化**：解码 HTML 实体，清除 HTML、脚本、样式、控制字符和发布版本/处理意见/历史回复等噪声；从原始字段提取名称、描述、模块、需求类型、产品域和业务场景；无法确认的字段保持为空。
4. **语义卡片**：统一构建需求类型、产品域、业务模块、功能对象、需求动作、当前/目标状态、触发条件、输入、输出、功能行为、业务约束、验收结果和原文证据。
5. **混合召回**：执行 Dense、SQLite FTS5/BM25 和结构化字段三路召回；每路最多 100 条，以 RRF（`k=60`）合并为最多 50 条候选。召回分只用于候选生成和排序。
6. **候选重排**：使用本地 `Xenova/bge-reranker-base` INT8 Cross-Encoder 重排最多 50 条候选，取前 20 条进入业务复核；资源、UID 覆盖和分数异常时失败关闭。
7. **业务复核**：AI 初审和独立复核分别读取原始字段及语义卡片。每个候选只能属于 `duplicate`、`highly_similar`、`partial_overlap`、`same_pattern`、`topic_only`、`unrelated` 之一，并返回相同点、差异和双方原文证据。
8. **程序校验**：校验 JSON、候选 UID 全覆盖、未知/重复 UID、关系与分数区间、原文证据和硬规则。两次复核不一致时采用较低关系等级和较低分数。
9. **结果分层**：`duplicate`、`highly_similar` 为正式匹配；`partial_overlap`、`same_pattern` 为参考关联；`topic_only`、`unrelated` 不展示。不得为凑数量展示低相关候选。
10. **失败关闭**：索引、召回、重排、AI 复核或程序校验任一关键环节失败时，只对对应编号返回失败原因，不输出未经验证的候选；多编号请求中的其他编号可继续完成。

## 3. 关系与综合匹配度

| 关系 | 业务判定 | 分数范围 | 输出层级 |
| --- | --- | ---: | --- |
| `duplicate` | 业务目标、功能对象和目标动作基本一致 | 85-100 | 正式匹配 |
| `highly_similar` | 核心目标和对象高度相近，存在有限差异 | 70-94 | 正式匹配 |
| `partial_overlap` | 部分目标、对象或流程重叠 | 40-69 | 参考关联 |
| `same_pattern` | 动作模式相似，但对象或目标不同 | 25-59 | 参考关联 |
| `topic_only` | 仅产品域、模块或主题相同 | 10-39 | 不展示 |
| `unrelated` | 无有效业务关联 | 0-24 | 不展示 |

关系先于分数确定。Dense、BM25 和 Cross-Encoder 分只参与召回及排序，不能单独触发正式匹配。“综合匹配度”是双重 AI 复核、保守合并和硬规则校验后的业务判断分，不解释为统计概率或准确率。

## 4. 硬规则

- 文案修改不等于权限配置或功能新增。
- 功能新增不等于缺陷修复。
- 相同模块不等于相同需求。
- 功能对象相近但目标动作不同，不得判为高度相似。
- 动作相同但功能对象不同，最多判为 `same_pattern`。
- 记录类型差异作为判定特征，不作为召回预过滤条件。
- 硬规则优先于模型高分。

## 5. 端到端流程

```text
用户问题
  -> 编号解析与数据中心精确定位
  -> HTML/字段清洗与需求语义卡片
  -> 当前模型版本有效索引范围
  -> Dense + FTS5/BM25 + 结构化字段召回
  -> RRF 合并最多 50 条候选
  -> 本地 Cross-Encoder 重排
  -> 前 20 条 AI 业务关系初审
  -> 独立语义复核
  -> UID/证据/关系-分数/硬规则校验
  -> 正式匹配、参考关联、无匹配或失败关闭
  -> answer + sources + dataViews
```

## 6. 展示契约

每个基准编号展示编号、名称、描述、模块、需求类型和匹配结论。每条可见候选展示：

- 需求编号、名称、描述、模块和需求类型；
- 匹配关系和综合匹配度；
- 相同点、主要差异和双方原文证据；
- Dense 召回分、Cross-Encoder 重排分和 AI 复核状态。

没有正式匹配时必须返回：

> 未发现业务目标一致的高度相似或重复需求。检索到的记录仅存在主题、模块或操作模式上的关联。

编号不存在、记录不可读、文本为空或关键流程异常时，不写入未经验证的 `sources` 或 `dataViews`。

## 7. 自动化验收

### 7.1 固定业务回归

`VISSLM-TSIS-779 · 基线管理名称修改` 为固定合同案例：

- `VISSLM-TSIS-889` 必须为 `topic_only`；
- `VISSLM-TSIS-376` 允许 `topic_only` 或 `partial_overlap`；
- `VISSLM-TSIS-613`、`395`、`528` 不得成为正式匹配；
- `VISSLM-TSIS-1837` 为 `same_pattern`；
- 基准不产生正式匹配，并返回无高度相似或重复需求的结论。

固定回归同时覆盖多编号分组、HTML/实体清洗、IssueType 提取、两次复核、未知/重复/遗漏 UID、证据校验和重排失败关闭。

### 7.2 候选索引范围

Dense、BM25 和结构化召回统一使用当前 embedding `modelVersion` 的有效索引记录集合。自动化回归验证：

- 未索引记录和仅旧模型版本索引的记录被排除；
- 当前模型版本的词法或结构化命中记录可被召回；
- 跨项目、跨节点类型记录不会被预过滤；
- 本次输入的全部基准 UID 被排除。

### 7.3 性能与资源

- 5,000 条合成候选、混合召回和真实 `Xenova/bge-reranker-base` INT8 Cross-Encoder：P50 `1413.24 ms`，P95 `2550.91 ms`，通过 `3000 ms` 阶段门槛。
- embedding 与 Cross-Encoder 模型固定 ID、revision、许可、文件大小和 SHA-256；运行时禁止远程模型加载。
- `bge-reranker-v2-m3` 仅作为技术候选，对比资源体积、延迟、内存快照和排序差异，不进入发布制品。
- 完整 AI 初审/独立复核耗时受模型服务影响，需单独记录，不与本地重排耗时混合解释。

### 7.4 发布制品

`v1.2.0` 已完成首次精准匹配发布；`v1.2.1` 移除人工金标、双人标注/裁决、Excel 标注样本包及依赖人工标签的评测代码，同时保持运行时精准匹配链路不变。发布验证包括：

- TypeScript、需求分析、当前索引范围、普通相似查询、知识库和项目管理回归；
- Windows x64 NSIS 构建、版本元数据、`latest.yml` 和 blockmap；
- 安装包内 12 个模型文件大小与 SHA-256 校验；候选模型和运行期敏感文件排除；
- 隔离目录静默安装、隔离 `userData` 启动、数据库初始化、静默卸载和无安装目录残留。

当前安装包 Authenticode 状态为 `NotSigned`；真实在线更新升级链路仍需在可访问私有 GitHub Release 的环境验证。

## 8. 验收命令

```powershell
npm run typecheck
npm run smoke:agent-requirement-analysis
npx tsx ./tests/requirement-matching/contract-regression.ts
npx tsx ./tests/requirement-matching/current-index-regression.ts
npx tsx ./tests/requirement-matching/reranker-comparison-regression.ts
npm run knowledge:smoke
npm run smoke:agent-similarity
npm run smoke:project-management
npm run benchmark:requirement-matching -- --records 5000 --include-reranker --max-p95-ms 3000
npm run prepare:model -- --check
npm run build
```

## 9. 证据索引

| 证据 | 文件 |
| --- | --- |
| 专家编排、双复核、响应和失败关闭 | `src/main/experts/requirement-analysis-agent.ts` |
| 语义卡片和硬规则字段 | `src/main/requirements/semantic-card.ts` |
| 三路召回和 RRF | `src/main/requirements/hybrid-retrieval.ts` |
| 本地 Cross-Encoder | `src/main/requirements/cross-encoder-reranker.ts` |
| 当前模型版本索引依赖 | `src/main/knowledge.ts`、`src/main/database.ts` |
| 固定行为与失败关闭 | `scripts/smoke-agent-requirement-analysis.ts`、`test-data/requirement-matching/fixed-outcomes.json` |
| 索引范围与合同回归 | `tests/requirement-matching/current-index-regression.ts`、`tests/requirement-matching/contract-regression.ts` |
| 模型技术对比 | `scripts/compare-requirement-rerankers.ts`、`docs/requirement-reranker-comparison-report.md` |
| 性能测量 | `scripts/benchmark-requirement-matching.ts` |
| 模型资源 | `scripts/prepare-local-resources.mjs`、`test-data/requirement-matching/reranker-model-manifest.json` |

## 10. 验收结论口径

验收分别记录代码契约、固定业务回归、索引范围、性能、模型资源、安装包和运行验证。自动化检查通过代表当前定义的业务规则和故障路径已被验证；综合匹配度仍是业务判断分，不作统计概率或固定准确率承诺。
