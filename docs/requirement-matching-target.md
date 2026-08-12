# VISSLM Agent 需求分析专家精准匹配升级：目标与交付说明

> 用途：立项、开发验收和上线评审。本文按当前工作树中的实现、脚本、测试夹具和现有文档整理，不是营销文案。
>
> 状态说明：本文同时记录“已实现能力”和“尚未达到上线门禁的事项”。当前工作树包含未提交修改；文中“当前”均指本次读取到的文件内容，不代表某个已发布版本。

## 0. 可直接采用的目标文本

### 0.1 建设目标

建设 VISSLM Agent 的“需求分析专家精准匹配能力”。用户通过 `@需求分析专家` 输入一个或多个数据中心需求编号后，系统应先精确定位每个编号对应的基准需求，再在数据中心全部可用候选记录中识别业务目标真正相同、相近或部分重叠的需求，最终按每个基准编号返回名称、描述、模块和可解释的综合匹配度。

这里的“精准匹配”以业务目标为准，不以关键词、产品域、模块或记录类型相同为充分条件。系统必须同时比较需求类型、功能对象、目标动作、当前状态、目标状态、触发条件、输入输出、约束和验收结果；仅主题相同、模块相同、动作模式相同但业务对象不同的记录，不得直接判为正式匹配。

### 0.2 可实施目标

1. **输入与定位**：支持一次输入 1-20 个需求编号，自动去重、大小写不敏感并保持输入顺序。每个编号必须通过数据中心唯一定位；编号不存在、详情不可读或没有可用需求文本时，只返回该编号的明确状态，不用相似编号猜测基准需求。
2. **候选范围**：候选范围为数据中心全部已建立有效索引、且存在可比较需求文本的记录，不按模块、产品域、需求类型或节点类型预先排除；必须排除用户输入的基准记录自身。索引未覆盖的有效记录不得被静默忽略，应在索引同步或结果状态中明确提示。
3. **文本标准化**：清除 HTML 标签、脚本、样式、实体编码、控制字符和发布版本/处理意见/历史回复等噪声；保留原始名称、描述、模块、需求类型及可追溯证据。字段缺失显示“未标注”或空值，不得由模型臆造。
4. **混合召回**：对基准需求和候选需求生成统一语义卡片，分别执行 Dense 向量召回、SQLite FTS5/BM25 词法召回和结构化字段召回；每路取前 100 条，用 RRF（`k=60`）合并，形成最多 50 条候选。三路召回结果只用于提高覆盖率，不直接作为最终匹配结论。
5. **候选重排**：使用本地 Cross-Encoder 对最多 50 条候选进行重排，取前 20 条进入业务复核。模型资源、候选 UID、排序结果和分数必须通过程序校验；重排失败时对该基准编号失败关闭，不得退回到仅按向量分展示。
6. **业务复核**：对前 20 条候选执行一次 AI 初审和一次不读取初审结果的独立复核。两次结果必须完整覆盖候选 UID，并提供关系、分数、相同点、主要差异以及双方原文证据。两次结论不一致时，按较低关系等级和较低分数保守输出。
7. **硬规则约束**：文案修改与权限配置/功能新增/缺陷修复必须区分；动作不同的需求不得判为高度相似；动作相同但功能对象不同最多判为“同类模式”；功能新增与缺陷修复在类型和动作冲突时降级。硬规则优先于模型高分。
8. **结果分层**：`duplicate`、`highly_similar` 为正式匹配；`partial_overlap`、`same_pattern` 为参考关联；`topic_only`、`unrelated` 不进入正式结果。无正式匹配时必须明确说明“未发现业务目标一致的高度相似或重复需求”，不能用主题相近记录充数。
9. **用户可见结果**：每个基准编号必须展示编号、名称、描述、模块和匹配结论；每条可见候选必须展示候选编号、名称、描述、模块、匹配关系、综合匹配度、相同点、主要差异、原文证据和复核状态。综合匹配度是 0-100 的未校准业务判断分，不得解释为概率或准确率。
10. **失败关闭与可追溯**：编号定位、索引、召回、重排、AI JSON、UID 覆盖、证据支持或硬规则校验任一关键环节失败时，只对对应编号返回“精准匹配失败关闭”和原因，不输出未经验证的候选。多编号请求中，已通过的编号仍可正常返回；每条结果必须能够追溯到候选 UID 和原始证据。

### 0.3 关系和分数口径

| 关系 | 业务判定 | 综合匹配度 | 输出层级 |
| --- | --- | --- | --- |
| `duplicate` | 业务目标、功能对象和目标动作基本一致，可视为重复需求 | 85-100 | 正式匹配 |
| `highly_similar` | 核心业务目标和对象高度相近，但存在可说明差异 | 70-94 | 正式匹配 |
| `partial_overlap` | 仅部分目标、对象或流程重叠 | 40-69 | 参考关联 |
| `same_pattern` | 动作模式相似，但功能对象或业务目标不同 | 25-59 | 参考关联 |
| `topic_only` | 仅产品域、模块或主题相同，不构成业务匹配 | 10-39 | 不展示 |
| `unrelated` | 无有效业务关联 | 0-24 | 不展示 |

关系先于分数确定。Dense 分、BM25 分和 Cross-Encoder 分只用于召回和排序，不能单独触发正式匹配。综合匹配度在完成双重 AI 复核、保守合并和程序硬规则校验后生成；在完成金标校准前，不作为统计概率使用。

### 0.4 质量、性能和上线门禁

正式上线前必须完成真实业务金标：至少 200 个基准查询、3,000 对候选需求；每对需求由两名标注人员独立标注，分歧由第三方裁决，并覆盖正式匹配、参考关联、主题相近、无关和 hard-negative。金标状态必须为 `ready`，且预测覆盖全部测试查询。

上线质量门禁为：Recall@50 `>= 98%`、正式匹配精确率 `>= 95%`、`topic_only` 被误判为正式匹配的比例 `<= 5%`、hard-negative 正式误判为 0；同时记录并设定 nDCG@10、MRR 的最低值，较冻结基线至少提升 0.01。指标未达标时不得以“向量召回分高”替代业务匹配结论。

性能目标按代表性 Windows 硬件和 5,000 条候选记录测量：本地混合召回加 Cross-Encoder 重排 P95 `<= 3 秒`；包含 AI 初审和独立复核的完整请求 P95 `<= 60 秒`，并单独记录模型服务等待时间。资源 manifest、模型 revision、文件哈希和许可必须完整；当前默认使用本地 `Xenova/bge-reranker-base` INT8，候选模型 `bge-reranker-v2-m3` 必须经过同一金标集的效果、延迟、内存和体积对比后再决定是否替换。

上线采用四阶段门禁：代码契约与回归通过 -> 金标完成 -> 离线质量和性能通过 -> 小范围试用与安装包验证通过。任一阶段未通过时只能作为受控试用或内部验证能力发布，不能对外宣称“精准匹配准确率已达标”；必须保留评测报告、模型清单、失败日志、停用开关和回滚版本。

## 1. 背景

VISSLM Agent 的“需求分析专家”接收一个或多个数据中心需求编号，定位基准需求，再从本地数据中心记录中找出业务上真正相近的需求。精准匹配升级解决的核心问题是：同一产品域、模块或关键词相同，并不等于业务目标相同；文案修改、权限配置、功能新增、缺陷修复以及相同动作但不同功能对象，都需要被区分。

本升级的结果不是一个只按相似度排序的列表，而是一个可解释、可回溯、可拒绝不确定结论的匹配流程：

- 先把原始记录清洗为可比较的需求语义卡片；
- 用 Dense、词法/BM25 和结构化字段三路召回，控制候选漏检；
- 用本地 Cross-Encoder 重排候选；
- 由 AI 分两次独立判定业务关系，并由程序校验 UID、证据、关系和分数；
- 只把通过校验的正式匹配或参考关联展示给用户；
- 任何关键依赖或结构化结论失败时，对该基准需求失败关闭，不用向量分冒充最终结论。

## 2. 十项目标

| 编号 | 目标方面 | 可交付结果 | 验收关注点 |
| --- | --- | --- | --- |
| T-01 | 需求定位与批量输入 | 支持从 `@需求分析专家` 请求中解析一个或多个需求编号，去重并按输入顺序处理，最多 20 个编号 | 不存在、无法读取或无可匹配内容的编号必须给出明确结果，不调用无效候选流程 |
| T-02 | 数据标准化 | 将名称、描述、原始字段和规范化文本转成统一语义卡片，并清除 HTML 标签、实体和匹配噪声 | AI 证据不得直接携带 `<p>`、`&quot;` 等原始表示；缺失字段保留为空或 `unknown`，不得臆造 |
| T-03 | 召回覆盖 | 对全部已建立记录索引的候选执行 Dense、词法/BM25、结构化字段三路召回，再以 RRF 合并 | 三路各取前 100，RRF `k=60`，合并候选最多 50；正式质量以 Recall@50 验证 |
| T-04 | 候选重排 | 使用本地 `Xenova/bge-reranker-base` INT8 Cross-Encoder 对最多 50 条候选重排，取前 20 条进入 AI 复核 | 资源、输出 UID、覆盖范围和分数均须有效；重排失败不得降级为向量排序结果 |
| T-05 | 业务关系判定 | 让 AI 对每个候选输出六种关系、业务判断分、相同点、差异及双方原文证据，并进行初审和独立复核 | 关系必须受业务规则约束；独立判定分歧按较低关系和较低分数保守合并 |
| T-06 | 误判抑制与失败关闭 | 对动作、功能对象、需求类型和证据做程序校验；任何关键环节失败时不输出未经验证的候选 | 重点关注 topic-only 被提升为正式匹配、hard-negative 被提升为正式匹配，以及模型返回未知/重复/遗漏 UID |
| T-07 | 可解释展示 | 返回 `answer`、`sources` 和 `dataViews`，按基准需求分组展示正式匹配与参考关联 | 用户能看到关系、综合匹配度、相同点、主要差异、双方证据、召回分、重排分和复核状态 |
| T-08 | 可测量评测 | 建立版本化金标协议、预测文件格式和评测脚本，使用 Recall@50、正式精确率、topic-only 误判率、nDCG@10、MRR 和 hard-negative 门禁 | 人工金标未达到 `ready` 前，不得宣称质量门禁通过 |
| T-09 | 模型资源可复现 | 记录 embedding、Cross-Encoder 的模型 ID、revision、文件清单、哈希和许可，运行时优先使用本地资源 | 资源缺失要明确失败；候选模型已有独立评测清单和技术报告，但没有人工金标精度结论 |
| T-10 | 性能与分阶段上线 | 用可复现 benchmark 分别测召回和本地重排，并按金标、资源、性能、受控试用、发布验证分阶段推进 | 5,000 条合成候选加真实本地重排已通过阶段性 P95 门槛；当前 benchmark 不包含真实 embedding 或 AI 网络/本地大模型复核延迟 |

## 3. 范围与非目标

### 3.1 本次范围

- 需求分析专家路由、编号解析和基准记录定位。
- 数据中心记录的需求文本清洗、字段别名读取、语义卡片构建和词法项提取。
- Dense、SQLite FTS5/BM25、结构化字段评分和 RRF 混合召回。
- 本地 Cross-Encoder 重排、AI 业务关系初审、独立复核、保守合并和程序校验。
- 正式匹配/参考关联的结构化响应、来源证据和失败关闭提示。
- `scripts/smoke-agent-requirement-analysis.ts` 的固定行为回归。
- `scripts/evaluate-requirement-matching.ts` 的金标校验和指标门禁。
- `scripts/benchmark-requirement-matching.ts` 的召回/重排阶段性能测量。
- `scripts/prepare-local-resources.mjs` 定义的本地 embedding、Cross-Encoder 和 OCR 资源准备链路。

### 3.2 明确非目标或当前未完成项

- 当前没有完成至少 200 个查询、3,000 对需求的人工双标和裁决；`gold-scaffold.json` 仍是 `annotationStatus: "scaffold"`。
- 已完成 `bge-reranker-v2-m3` 与现用 `bge-reranker-base` 的资源校验和固定 hard-negative 技术测量，详见 `docs/requirement-reranker-comparison-report.md`；人工金标仍未完成，因此不能写成模型精度优选结论，也不能替换线上默认模型。
- 当前没有完成概率校准；界面中的“综合匹配度”是业务判断分，不是统计概率，也不代表固定的准确率保证。
- 当前 benchmark 不测 AI 初审/独立复核的网络或本地大模型耗时，不提供在线 AI 延迟、吞吐或 P95 保证。
- 当前已完成 `npm run package:dir`、`npm run package`、目录包/NSIS 版本检查和打包模型资源校验；干净 Windows 安装验证、Authenticode 签名和真实自动更新升级链路仍需分别验证。
- 本文不新增 API、角色、RBAC、数据权限、统计看板或新的数据库契约；现有系统仍是单机单用户边界。
- 本文不把项目管理已有 `pm_requirement_matches` 流程的阈值、状态或业务公式改写为需求分析专家的质量指标。

## 4. 端到端流程

```text
用户问题
  -> @需求分析专家路由与编号解析
  -> 数据中心定位、排除基准记录
  -> HTML/字段清洗与需求语义卡片
  -> Dense + FTS5/BM25 + 结构化字段召回
  -> RRF 合并最多 50 条候选
  -> 本地 Cross-Encoder 重排
  -> 取前 20 条，分批 AI 业务关系初审
  -> 分批 AI 独立复核
  -> UID/覆盖/证据/关系-分数/硬规则校验
  -> 保守合并
  -> 正式匹配、参考关联或失败关闭
  -> answer + sources + dataViews
```

### 4.1 输入与定位

1. 路由器通过 `@需求分析专家` 识别专家；未提供该专家标记时由现有路由逻辑决定是否进入需求分析路径。
2. 编号解析支持字母数字编号及 `-`、`_`、`.` 分隔形式，去除重复编号，最多保留 20 个，并保持首次出现顺序。
3. 每个编号通过 `AppDatabase.findRecordByItemId` 定位；同时尝试原编号和大写编号。
4. 所有已定位基准记录的 UID 都加入排除集合，避免把基准需求自身召回为候选。
5. 多编号按基准逐条处理；某一编号失败时，该编号进入错误说明，其他编号仍可继续形成各自结果。

### 4.2 三路召回

- **Dense**：`KnowledgeService.rankRequirementRecordMatches` 使用本地 embedding 记录索引，对语义卡片的 `matchingText` 做向量排序。
- **词法/BM25**：`AppDatabase.searchRequirementRecordsLexical` 使用语义卡片提取的词法项查询记录全文索引；代码会对候选词做数量和长度约束。
- **结构化字段**：遍历本地记录，重新构建候选语义卡片，用功能对象、动作、当前状态、目标状态、产品域、模块和需求类型计算结构化分。
- 每一路最多取 100 条，按 UID 合并后以 Reciprocal Rank Fusion 排序，`RRF_K=60`，最终候选上限为 50 条。

当前结构化召回会按 200 条分页读取本地记录并在应用进程中计算，因此数据量变大时的耗时和内存必须通过 benchmark 及实际数据规模验证，不能仅凭小样本推断生产性能。

### 4.3 本地重排与 AI 复核

1. Cross-Encoder 对最多 50 条候选分批推理，批大小为 8，输入截断到模型允许的 512 token；输出分数被限制在 0 到 100。
2. 按重排分降序取最多 20 条进入 AI 复核。召回分和重排分只用于候选顺序，不直接决定最终关系。
3. 初审和独立复核都按每批 5 条候选调用模型；独立复核的提示明确要求不参考初审答案。每个批次的结构化输出最多重试一次，即最多尝试两次。
4. 每个候选必须且只能出现一次，且必须覆盖本批全部候选 UID；缺少总结、明细、相同点、差异或原文证据都视为失败。
5. 两次判定关系一致时标记为 `independently_verified`；不一致时使用关系等级较低者，并使用两次分数中的较低值，标记为 `conservatively_reconciled`。

### 4.4 关系规则与结果分层

程序先合并两次 AI 判定，再执行关系硬规则降级。规则不是统计模型，不能替代人工金标：

- 基准是文案修改而候选不是文案修改，最多保留 `topic_only`。
- 两边动作已知但动作不同，功能对象相近时最多为 `partial_overlap`，对象也不相近时最多为 `topic_only`。
- 两边动作相同但功能对象相似度低于当前规则阈值时，最多为 `same_pattern`。
- 功能新增与缺陷修复在需求类型和动作冲突时，最多为 `topic_only`。

最终仅有以下两层可见结果：

- **正式匹配**：`duplicate`、`highly_similar`。
- **参考关联需求**：`partial_overlap`、`same_pattern`。

`topic_only` 和 `unrelated` 不进入 `dataViews` 或 `sources`。没有正式匹配时，回答明确说明未发现业务目标一致的高度相似或重复需求，而不是把主题相近记录改写为正式匹配。

## 5. 数据标准化契约

### 5.1 清洗边界

`buildRequirementSemanticCard` 从 `RecordDetail` 读取名称、描述、`raw`、`normalizedText` 等已有字段。用于匹配的纯文本处理包括：

- 解码常见命名实体和数字/十六进制实体，最多进行有限轮次解码；
- 将 `<br>`、段落结束转成换行，移除 HTML 标签、`script/style` 内容和控制字符；
- 合并空白，去除部分数据中心元数据噪声，如发布版本、创建人、创建时间、客户来源、处理意见和历史回复；
- 描述为空时按已有原始字段别名寻找描述；对象、数组和不存在字段不被强行转换成虚构文本。

清洗后的文本用于语义卡片、证据和召回输入。AI 返回的 `baseEvidence`、`candidateEvidence` 必须能在对应卡片的 `evidence` 中找到，且经归一化后至少保留两个字符；否则结果失败关闭。

### 5.2 语义卡片字段

| 字段 | 当前来源或推断方式 | 用途 |
| --- | --- | --- |
| `requirementType` | `IssueType`、`issueType`、`_valm_IssueType`、需求类型等原始字段别名 | 区分需求类型，参与关系规则 |
| `productDomain` | 产品域原始字段；缺失时从标题/描述中的已知域名推断 | 结构化召回和解释 |
| `module` | 多组模块字段别名 | 结构化召回和展示 |
| `functionalObject` | 根据标题、模块、动作、按钮/字段/页面等文本规则推断 | 业务目标相似性与动作规则 |
| `action` | 规则识别为 `rename_label`、`configure_permission`、`compare`、`enable_selection`、`add_capability`、`remove_capability`、`relax_constraint`、`tighten_constraint`、`fix_defect`、`change_flow`、`optimize_ui` 或 `unknown` | 关系降级和 AI 上下文 |
| `currentState` / `targetState` | 现状、期望结果、建议或引号修改模式中提取 | 区分当前问题和目标变化 |
| `trigger` / `input` / `output` | 触发条件、场景、输入/选择/填写/导入、输出/生成/导出/显示等句式提取 | AI 逐字段比较 |
| `behavior` | 清洗后的描述或标题，最多保留当前实现允许的长度 | 回答描述和候选上下文 |
| `constraints` / `acceptance` / `businessScene` | 约束、验收/预期结果和业务场景句式提取 | AI 逐字段比较 |
| `evidence` | 标题与清洗后描述组成的紧凑证据文本 | 原文证据回溯和校验 |
| `matchingText` | 以上字段加标题、行为组成的结构化文本 | Dense 检索和 Cross-Encoder 输入 |
| `lexicalTerms` | 标题、域、模块、功能对象、状态、触发和验收等字段分词去重 | FTS5/BM25 召回 |

这些字段主要由别名和正则规则推断，并非人工审核后的结构化主数据。字段识别不足属于当前评测和后续优化范围，不能把空字段当成事实缺失以外的业务结论。

## 6. 关系定义与分数口径

当前允许的关系只有六种。下表中的分数范围是模型结构化输出和程序校验接受的当前口径，部分区间存在重叠；最终关系必须结合业务字段和硬规则判断，不能按分数单独切割。

| 关系 | 当前语义 | 当前可接受分数范围 | 展示层 |
| --- | --- | --- | --- |
| `duplicate` | 业务目标、功能对象和动作基本相同，可视为重复需求 | 85-100 | 正式匹配 |
| `highly_similar` | 核心业务目标和对象高度相近，但仍有可说明差异 | 70-94 | 正式匹配 |
| `partial_overlap` | 只有部分业务目标、对象或流程重叠 | 40-69 | 参考关联需求 |
| `same_pattern` | 动作模式相似，但功能对象或业务目标不同 | 25-59 | 参考关联需求 |
| `topic_only` | 主要是产品域、模块或主题相同，不足以构成业务匹配 | 10-39 | 不展示 |
| `unrelated` | 没有可用的业务关联 | 0-24 | 不展示 |

“综合匹配度”取经过两次复核、保守合并和硬规则处理后的业务判断分。它不是校准概率；`denseScore` 与 `rerankerScore` 也不是正式精确率或置信度证明。

## 7. 展示契约

### 7.1 响应顶层结构

需求分析专家沿用现有 `ChatResponse`，返回：

- `answer`：按每个基准需求输出定位、描述、模块、需求类型、匹配结论和最多 8 条正式/参考结果的文本说明。
- `sources`：只包含可见的正式匹配和参考关联记录；每条带 UID、名称、节点类型、编号、证据片段和最终业务判断分。
- `dataViews`：有可见结果时包含一个结构化数据视图；没有可见结果或全部失败时不输出候选数据视图。

### 7.2 `dataViews` 与分组

当前视图契约如下：

- `id`：`requirement-analysis:<请求编号按输入顺序拼接>`。
- `title`：`需求分析精准匹配结果`。
- `description`：说明候选经过混合召回、本地 Cross-Encoder、AI 初审、独立复核和程序校验，并说明综合匹配度未校准。
- `fields`：`description`、`module`、`requirementType`、`relation`、`matchScore`、`sharedEvidence`、`difference`、`evidence`、`denseScore`、`rerankerScore`、`reviewStatus`。
- 分组名：`<基准编号> · 正式匹配` 或 `<基准编号> · 参考关联需求`；每组保留 `count` 和候选行。
- 每行保留 `uid`、`name`、`nodeType`、`itemId`，以及上述字段对应的 `values`。

列标签使用现有契约：描述、模块、需求类型、匹配关系、综合匹配度、相同点、主要差异、原文证据、向量召回分、Cross-Encoder 重排分、AI 复核状态。表格应把长描述和证据作为可展开/详情内容处理，不能把百分比或关系文字解释为统计承诺。

### 7.3 失败和空结果展示

- 编号不存在：说明数据中心不存在该需求编号。
- 记录无法读取：说明对应记录详情无法读取。
- 没有可匹配文本：说明记录没有可用于匹配的需求内容。
- 关键流程异常：显示 `精准匹配失败关闭` 和错误原因，不显示未通过校验的候选，不写入 `sources`。
- 没有正式匹配但存在参考关联：显示“未发现业务目标一致的高度相似或重复需求”，并把参考关联单独分组。
- 没有候选：不伪造“无匹配”的分数证据；仅输出当前基准信息和无候选结论。

## 8. 评测金标与质量门禁

### 8.1 金标资产标准

金标文件遵循 `test-data/requirement-matching/schema.json` 和 `annotation-protocol.md`：

- `schemaVersion` 必须为 `1.0`，`annotationStatus` 为 `scaffold` 或 `ready`。
- 每个查询有一个 `baseItemId`、唯一 `queryId` 和一个 `train`、`validation` 或 `test` split；同一基准需求不得跨 split。
- 每个候选编号在同一查询内唯一，关系必须是六种关系之一，`relevance` 必须和关系一致。
- 相关性等级为：`duplicate=3`、`highly_similar=2`、`partial_overlap=1`、`same_pattern=1`、`topic_only=0`、`unrelated=0`。
- `hardNegative: true` 表示词法或主题上看似合理，但不得成为正式匹配的候选。
- 正式金标要求至少 200 个查询、3,000 对需求，覆盖正式匹配、参考关联、topic-only、unrelated 和 hard-negative。
- 每对需求由两名标注者独立标注；裁决者复核所有分歧；必须保留两次原始标签和裁决依据。完成覆盖和分歧裁决后才能标记 `ready`。

当前仓库的 `gold-scaffold.json` 没有人工查询和人工需求对，`predictions.example.json` 也是空预测示例；因此当前不能据此声称任何 Recall、Precision、nDCG 或 MRR 门禁通过。

### 8.2 指标定义

以下定义严格按 `scripts/evaluate-requirement-matching.ts` 当前实现：

| 指标 | 计算口径 | 默认门禁 |
| --- | --- | --- |
| Recall@50 | 对每个查询，`relevance > 0` 的金标候选中，有多少出现在预测排名前 50；再对查询取平均。`partial_overlap` 和 `same_pattern` 也属于召回正例 | `>= 0.98` |
| 正式精确率 | 预测中关系为 `duplicate`/`highly_similar` 的候选里，金标同样属于这两类的比例 | `>= 0.95` |
| topic-only 误判率 | 金标关系为 `topic_only` 且预测为正式关系的数量，除以该评测集全部 `topic_only` 对数量 | `<= 0.05` |
| nDCG@10 | 前 10 名按金标 `relevance` 计算 DCG，再与每个查询的理想排序 DCG 比较，最后对查询平均 | 必须可计算；最低值通过 `--min-ndcg10` 显式设置 |
| MRR | 每个查询第一个 `relevance > 0` 候选的倒数排名，再对查询平均 | 必须可计算；最低值通过 `--min-mrr` 显式设置 |
| hard-negative | 任何 `hardNegative: true` 候选被预测为正式关系，即门禁失败；参考关联不触发当前“正式误判”检查 | 必须通过 |
| 覆盖完整性 | 预测文件必须覆盖评测 split 中的每个查询；缺少查询即失败 | 必须通过 |

评测集还必须达到查询数和需求对数量门槛，且 `annotationStatus` 必须为 `ready`。提供 `--baseline` 时，脚本默认要求 nDCG@10 和 MRR 相对基线各提升至少 `0.01`；不提供基线时不启用该两项增益比较。这里的基线应是冻结的词法或既有版本排名文件，不等同于已经完成的 `bge-reranker-v2-m3` 对比。

### 8.3 评测命令

格式/脚手架检查：

```powershell
npm run evaluate:requirement-matching -- --report-only
```

正式门禁（使用已经完成双标、裁决并冻结的真实资产）：

```powershell
npm run evaluate:requirement-matching -- --gold <gold.json> --predictions <predictions.json> --baseline <baseline.json>
```

`--report-only` 仍会在 JSON 报告中给出 `PASS` 或 `GATE_FAIL`，但用于探索时不以非零退出替代人工验收；去掉该参数后，数据不完整或任一门禁失败必须以非零状态退出。评测脚本本身只评估输入的预测文件，不负责生成真实预测，也不等同于端到端 UI 验收。

### 8.4 固定行为回归

`test-data/requirement-matching/fixed-outcomes.json` 是用户指定的合同回归夹具，不是人工金标。其基准 `VISSLM-TSIS-779` 的约束是：

- `VISSLM-TSIS-889` 必须为 `topic_only`；
- `VISSLM-TSIS-376` 允许 `topic_only` 或 `partial_overlap`；
- `VISSLM-TSIS-613`、`VISSLM-TSIS-395`、`VISSLM-TSIS-528` 只能是非正式关系；
- `VISSLM-TSIS-1837` 为 `same_pattern`；
- 该基准不应产生正式匹配。

窄范围 smoke 使用合成记录和固定模型响应检查这些行为，同时覆盖多编号分组、HTML/实体清洗、IssueType 提取、两次复核、未知/重复/遗漏 UID、证据校验和重排失败关闭。它证明的是代码契约回归，不是线上质量统计。

## 9. 模型与资源

### 9.1 当前模型资源

| 用途 | 当前资源 | 当前加载边界 |
| --- | --- | --- |
| 记录 embedding | `Xenova/bge-small-zh-v1.5`，revision `75c43b069aac4d136ba6bc1122f995fedcfd2781` | 本地资源；用于建立/查询记录向量索引；当前文档和知识库契约记录为 384 维 |
| 候选重排 | `Xenova/bge-reranker-base`，revision `280bcc27a84e0b898c251e06fddb25171bd9b101` | 本地 INT8 Cross-Encoder；代码版本标识为 `bge-reranker-base-int8-local-v1`，禁止远程模型加载 |
| AI 关系复核 | 现有 `ModelClient` 配置的本地 Ollama 或已配置在线模型服务 | 依赖当前设置和服务可用性；在线模型会接收本次复核上下文，现有系统没有统一字段级脱敏策略 |

资源准备脚本会记录模型 ID、revision、来源、许可、文件大小和 SHA-256 到 manifest；应用运行时会从资源根目录、打包资源或工作目录查找本地模型。真实运行前应执行：

```powershell
npm run prepare:model
```

资源缺失、索引不可用、Cross-Encoder 不可用或输出不符合契约时，需求分析对该编号失败关闭。`bge-reranker-v2-m3` 已完成技术测量，但没有人工金标精度结论，因此不能在验收材料中写出其优于现用模型的结论。

## 10. 性能与失败关闭门禁

### 10.1 当前 benchmark 的测量边界

`scripts/benchmark-requirement-matching.ts` 当前提供可重复的阶段性测量：

- 默认构造 5,000 条合成记录，预热 2 次，正式迭代 10 次；参数可调整但记录数至少 100、迭代至少 3 次。
- 输出 `p50`、`p95`、最小和最大耗时，默认 `maxP95Ms=30000`。
- 默认阶段是混合召回；脚本中的 Dense 返回是受控 benchmark retriever，不等同于真实 embedding 端到端延迟。
- 加 `--include-reranker` 才加载真实本地 Cross-Encoder，测量范围仍不包含 AI 初审和独立复核。
- `--report-only` 只报告，不把失败状态转换为强制退出；去掉该参数才作为脚本门禁执行。

示例：

```powershell
npm run benchmark:requirement-matching -- --records 5000 --report-only
npm run benchmark:requirement-matching -- --records 5000 --include-reranker --report-only
```

本机已完成 5,000 条合成候选、混合召回和真实 `Xenova/bge-reranker-base` INT8 Cross-Encoder 的阶段性测量：P50 为 `1413.24 ms`，P95 为 `2550.91 ms`，通过本项目设定的 `3000 ms` 阶段门槛。该结果仍使用受控 Dense retriever，不包含真实 embedding 建索引/查询，也不包含 AI 初审和独立复核，因此不是生产端到端时延承诺。上线前仍需保存真实索引和受控 AI 复核链路的测量报告，并明确是否包含网络等待。

### 10.2 失败关闭矩阵

| 失败点 | 当前行为 | 禁止行为 |
| --- | --- | --- |
| 编号不存在/详情不可读/匹配文本为空 | 返回该编号的明确说明，不输出候选 | 不用相似编号猜测基准 |
| embedding 或记录向量索引不可用 | 该编号失败关闭 | 不用词法分或向量分伪装最终匹配 |
| 召回结果为空 | 返回无候选结论 | 不生成虚构关系或证据 |
| Cross-Encoder 资源/推理失败 | 该编号失败关闭 | 不跳过重排直接进入 AI 复核 |
| 重排返回未知 UID、重复 UID、遗漏 UID、越界分数 | 该编号失败关闭，且不调用 AI 复核 | 不接受部分覆盖结果 |
| AI JSON 无效、缺明细/总结/证据、UID 未完整覆盖 | 每批最多再试一次；仍失败则该编号失败关闭 | 不输出未验证候选 |
| 两次关系或分数分歧 | 取较低关系和较低分数，保留保守复核状态 | 不取高分扩大正式匹配 |
| 硬规则发现动作/对象/类型冲突 | 按规则降级关系和分数 | 不以主题或模块相同覆盖规则 |

`ModelClient` 的请求超时属于当前模型调用实现的异常来源；其 180 秒超时配置不构成在线模型的服务等级承诺。失败关闭是单个基准编号的结果策略，多编号请求仍可展示其他编号已经通过校验的结果。

## 11. 分阶段上线计划

| 阶段 | 进入条件 | 工作内容 | 退出条件 | 当前状态 |
| --- | --- | --- | --- | --- |
| S0 代码与契约基线 | 当前代码、脚本和资源定义可读取 | 固化编号解析、语义卡片、三路召回、RRF、重排、双复核、关系规则、响应和失败关闭契约 | TypeScript、需求分析 smoke、固定回归可通过 | 代码和脚本已具备；需以本次命令结果为准复核 |
| S1 金标准备 | 需求样本范围和标注人员确定 | 冻结 query split；完成至少 200 查询/3,000 对双人标注、裁决和 hard-negative 标记 | `annotationStatus=ready`，覆盖要求满足，原始标签可追溯 | 未完成，当前为 scaffold |
| S2 离线质量与模型评测 | S1 完成，预测和冻结基线可生成 | 执行正式评测；设置并记录 nDCG@10/MRR 最低值；比较当前模型与冻结基线，并单独决定是否开展 `bge-reranker-v2-m3` 试验 | Recall@50、正式精确率、topic-only 误判率、nDCG/MRR、hard-negative 和完整性全部通过 | 未完成，无人工金标通过证据 |
| S3 性能与受控试用 | S2 通过，本地资源 manifest 完整 | 在代表性记录规模和硬件上分别测召回、含本地重排、含受控 AI 复核的耗时；使用已批准的测试数据做小范围试用 | 性能报告边界清楚，失败关闭可观测，未出现未经验证的正式结果 | 部分完成；5,000 条合成候选加真实本地重排 P95 已通过，真实索引、AI 延迟和受控试用未完成 |
| S4 上线评审与发布验证 | S2/S3 通过，产品和合规确认数据范围 | 复核模型资源、配置、错误提示、用户流程和发布环境；执行目录包、安装包和安装环境验证 | 评审材料包含真实门禁报告、资源清单、风险和回滚/停用决定 | 部分完成；`1.2.0` 目录包、NSIS 构建、版本元数据、更新清单和内置模型资源校验已通过，干净安装与升级链路仍待验证 |

## 12. 当前验收状态

### 12.1 当前已完成或已有代码证据

- 已接入需求分析专家路由和多编号解析，最多 20 个编号并去重。
- 已实现需求文本清洗、HTML 实体处理、字段别名读取、噪声移除和语义卡片构建。
- 已实现 Dense、SQLite FTS5/BM25、结构化字段三路召回和 RRF 合并，候选上限 50。
- 已实现本地 `Xenova/bge-reranker-base` INT8 Cross-Encoder 重排，候选上限 20 进入 AI 复核。
- 已实现 AI 关系初审、独立复核、分批重试、保守合并、证据支持校验、关系/分数校验和硬规则降级。
- 已实现正式匹配与参考关联分组，过滤 `topic_only`/`unrelated`，并返回双方证据、相同点、差异、召回分、重排分和复核状态。
- 已实现关键依赖失败关闭，未通过校验的候选不进入 `sources` 或 `dataViews`。
- 已提供 `VISSLM-TSIS-779` 固定合同回归、无效 UID/证据回归和重排失败关闭回归。
- 已提供金标 schema、双人标注/裁决协议、评测脚本和阶段性 benchmark 脚本。
- 已完成 5,000 条合成候选加真实本地 Cross-Encoder 的阶段性性能测量，P50 `1413.24 ms`、P95 `2550.91 ms`，通过 `3000 ms` 门槛。
- 已完成 `npm run package:dir`，并核验目录包包含固定 revision 和哈希的 embedding、reranker 模型资源，候选 `bge-reranker-v2-m3` 未进入制品。
- 已完成 `npm run package`，生成 `VISSLM-Agent-Setup-1.2.0.exe`；主程序版本为 `1.2.0`，`latest.yml` 与 blockmap 已生成，打包内 12 个模型文件的大小和 SHA-256 均与 manifest 一致。

### 12.2 当前未完成、不得标为通过

- 人工金标资产仍为空脚手架，未达到 200 查询/3,000 对，`annotationStatus` 不是 `ready`。
- 没有真实人工金标上的 Recall@50、正式精确率、topic-only 误判率、nDCG@10、MRR 和 hard-negative 通过报告。
- 已完成 `bge-reranker-v2-m3` 的固定资源校验、单个 hard-negative 真实业务输入排序、延迟和体积测量；由于缺少正式人工金标，该结果只证明技术可运行和排序差异，不能证明候选模型更准确。线上继续使用 `bge-reranker-base`。
- 没有概率校准和统计精度保证；“综合匹配度”仍是未校准的业务判断分。
- 没有真实 embedding 索引和真实 AI 复核链路的完整端到端 P95 证据；现有阶段性 benchmark 明确排除 AI 复核延迟。
- 没有完成干净 Windows 环境的 NSIS 安装/卸载验证、Authenticode 签名或真实自动更新升级链路验收；当前安装包签名状态为 `NotSigned`。

## 13. 验收命令与证据索引

建议按以下顺序执行，命令输出应作为评审附件保存；真实业务 payload、凭据、用户数据库和模型文件不得提交到仓库：

```powershell
npm run typecheck
npm run smoke:agent-requirement-analysis
npm run evaluate:requirement-matching -- --report-only
npm run benchmark:requirement-matching -- --records 5000 --report-only
```

涉及现有项目管理流程时继续执行：

```powershell
npm run smoke:project-management
```

| 证据 | 文件 |
| --- | --- |
| 专家编排、语义卡片、召回、重排、双复核、响应和失败关闭 | `src/main/experts/requirement-analysis-agent.ts`、`src/main/requirements/semantic-card.ts`、`src/main/requirements/hybrid-retrieval.ts`、`src/main/requirements/cross-encoder-reranker.ts` |
| Dense 记录匹配和本地索引依赖 | `src/main/knowledge.ts`、`src/main/database.ts` |
| 需求分析路由和主进程装配 | `src/main/experts/router.ts`、`src/main/index.ts` |
| 固定行为与失败关闭回归 | `scripts/smoke-agent-requirement-analysis.ts`、`test-data/requirement-matching/fixed-outcomes.json` |
| 金标协议、schema 和质量门禁 | `test-data/requirement-matching/annotation-protocol.md`、`test-data/requirement-matching/schema.json`、`scripts/evaluate-requirement-matching.ts` |
| 阶段性能测量 | `scripts/benchmark-requirement-matching.ts` |
| 本地模型资源和 manifest | `scripts/prepare-local-resources.mjs` |
| 当前实现范围和运行约束 | `docs/02-requirements.md`、`docs/04-module-design.md`、`docs/07-development-guide.md`、`README.md` |

## 14. 评审结论模板

评审时应分别填写，而不能用“代码 smoke 通过”替代质量门禁：

- 代码契约：通过 / 不通过，证据为 TypeScript 和需求分析 smoke 输出。
- 固定合同回归：通过 / 不通过，证据为 `VISSLM-TSIS-779` 及失败关闭检查。
- 人工金标质量：通过 / 不通过 / 未开始，填写查询数、需求对数、split、标注/裁决记录和评测 JSON。
- 性能：通过 / 不通过 / 未测，填写记录规模、硬件、是否含真实 embedding、是否含 Cross-Encoder、是否含 AI 网络等待及 p50/p95。
- 资源：通过 / 不通过，填写模型 revision、manifest 哈希和本地加载检查。
- 发布：通过 / 不通过 / 未执行；除非已实际完成环境验证，否则不得标记通过。

在人工金标、正式指标、代表性性能和发布验证均未完成前，本升级只能认定为“代码能力已实现、上线验收未完成”，不能认定为正式上线质量已达标。
