# VISSLM 需求匹配 v1.5 业务场景目录

状态：已冻结。本文档是 Task 1 的业务场景、标签和验收契约；数据生成器、评测器和报告必须按本文档消费，不得自行改写场景含义。

## 1. 不可变生成契约

以下值是本版本唯一有效的生成常量：

```text
datasetVersion=requirement-matching-accuracy-v1.5
seed=requirement-matching-v1.5-seed
queryCount=24
candidateCount=600
domains=requirement_management,configuration_management,defect_management,data_sync,permission_approval,query_reporting
```

| 字段 | 固定值 | 约束 |
| --- | --- | --- |
| `datasetVersion` | `requirement-matching-accuracy-v1.5` | 写入数据清单、每条查询和评测报告 |
| `seed` | `requirement-matching-v1.5-seed` | 生成顺序、文本变体、UID 和标签必须由此值确定 |
| `queryCount` | `24` | 六个业务域各四条查询 |
| `candidateCount` | `600` | 24 条查询各展开 25 个候选槽位，候选记录合并为一个全局池 |
| `querySlotsPerQuery` | `25` | 每个查询必须完整使用 `S01` 至 `S25`，不得增删槽位 |
| `normalizationVersion` | `requirement-business-v1` | 业务哈希和业务事实抽取使用的归一化版本 |
| `explanationMode` | `disabled` | LLM 解释不参与标签、排序或验收指标 |
| `globalCandidatePool` | `true` | 所有 600 条候选对每条查询保持可检索；不得按查询预先裁剪候选池 |

### 1.1 稳定标识和展开规则

- 查询 ID 采用 `q-{domainAlias}-{ordinal}`，其中 `ordinal` 为 `01` 至 `04`。
- 槽位 ID 固定为 `S01` 至 `S25`，大小写和编号不得改变。
- 候选 UID 由 `c-{queryId}-{slotId}` 拼接，例如 `c-q-rm-01-S01`。UID 在 600 条候选记录内唯一。
- 每个查询的 25 个槽位各生成一条候选记录；24 组展开结果的并集为 600 条记录。
- 评测某条查询时，其 25 个本地槽位按第 5 节读取持久化构造标签；评测器在运行时将其余 `600 - 25 = 575` 条跨查询候选派生为 `relevanceGrade=0`、`relation=unrelated`。只有候选属于当前查询自己的已标注槽位时，才使用该槽位的等级和关系。
- 575 条跨查询候选必须原样留在同一个全局检索池中，不能按 `queryId` 或槽位归属预先裁剪。查询锚点和业务标识全局唯一，避免不同查询之间意外产生未声明的精确正例。
- 数据集只持久化 `24 × 25 = 600` 个本地构造标签，每条候选记录对应其所属查询的一个槽位；不得持久化或物化 14400 个查询—候选标签。评测审计数学仍覆盖 `24 × 600 = 14400` 个运行时关系，其中 600 个读取本地构造标签，另外 13800 个跨查询关系由评测器运行时派生为 grade-0/unrelated。`candidateCount=600` 同时表示唯一候选记录数和持久化本地构造标签数。
- `candidateUid`、查询 ID、业务域、场景名称、相关性等级、资格状态和冲突类别必须共同写入可审计标签。标签由本目录规定的构造规则直接得到，不由人工主观判断，也不从历史关联反推。

### 1.2 本地构造标签记录的最小字段

每个持久化本地构造标签至少包含以下字段；每条查询固定保存 25 个，不为另外 575 个跨查询关系创建标签记录：

```text
datasetVersion
seed
queryId
candidateUid
domain
candidateSlot
scenario
relevanceGrade
hardConflictClass
candidateEligible
expectedDecisionStatus
expectedReasonCode
```

`relevanceGrade` 表示构造协议中的语义相关性；`expectedDecisionStatus` 和 `expectedReasonCode` 表示生产确定性策略的安全边界，两者不可互相替代。

### 1.3 审计标签与检索输入隔离

- `candidateUid`、`queryId`、`candidateSlot`、`scenario`、`relevanceGrade`、`hardConflictClass`、`candidateEligible`、`expectedDecisionStatus` 和 `expectedReasonCode` 只允许存在于非搜索元数据通道，包括旁路清单、数据库身份列、评测器标签映射、候选结果关联字段和结果报告。
- 上述审计标签及其值严禁写入候选或查询的原始可搜索业务字段，包括 `name`、`item_id`、`node_type`、`sourceTitle`、`sourceDescription`、`requirementType`、`productDomain`、`module`、`evidence`、`matchingText`、`lexicalTerms`，以及任何会被转换为检索文本的 `raw_json` 字段。
- 审计标签严禁进入 `normalizedText`、FTS5/BM25 索引文本、Dense Embedding 文本、RRF 特征或输入、CrossEncoder 查询/候选文本。RRF 只能融合由真实业务文本召回得到的排名，不能读取标签、UID、等级或预期决策。
- UID 可以作为数据库主键、候选结果关联键和审计连接键传递，但不得被拼接到搜索文本、向量文本或 CrossEncoder 输入中，也不得作为排序特征。
- 数据生成校验必须逐字段检查标签泄漏；任何审计标签或其稳定值进入可搜索字段、`normalizedText` 或模型输入时，数据集无效并退出非零。

## 2. 六个业务域和 24 条查询

每个业务域固定四个查询模板。模板中的动作、对象、约束和业务标识是查询的基础业务事实；生成器可以使用稳定的同义改写和展示包装，但不得改变这些事实。

| queryId | domain | 模板名称 | action | object | 稳定业务标识 | 基础约束或限定 |
| --- | --- | --- | --- | --- | --- | --- |
| `q-rm-01` | `requirement_management` | requirement_create | 创建 | 需求条目 | `REQ-RM-01` | 必须填写需求标题与验收标准 |
| `q-rm-02` | `requirement_management` | requirement_version_update | 修改 | 需求版本 | `REQ-RM-02` | 仅限当前项目维护 |
| `q-rm-03` | `requirement_management` | requirement_change_query | 查询 | 需求变更记录 | `REQ-RM-03` | 按需求编号查询 |
| `q-rm-04` | `requirement_management` | requirement_review_export | 导出 | 需求评审清单 | `REQ-RM-04` | 最多导出 500 条 |
| `q-cm-01` | `configuration_management` | configuration_parameter_manage | 配置 | 系统参数 | `CFG-CM-01` | 必须保留审计记录 |
| `q-cm-02` | `configuration_management` | configuration_template_import | 导入 | 配置模板 | `CFG-CM-02` | 仅限管理员导入 |
| `q-cm-03` | `configuration_management` | configuration_change_query | 查询 | 配置变更记录 | `CFG-CM-03` | 按配置编号查询 |
| `q-cm-04` | `configuration_management` | configuration_item_validate | 校验 | 配置项 | `CFG-CM-04` | 响应时间不超过 3 秒 |
| `q-dm-01` | `defect_management` | defect_create | 创建 | 缺陷单 | `BUG-DM-01` | 必须填写严重级别 |
| `q-dm-02` | `defect_management` | defect_status_update | 修改 | 缺陷状态 | `BUG-DM-02` | 仅限当前处理人修改 |
| `q-dm-03` | `defect_management` | defect_detail_query | 查询 | 缺陷详情 | `BUG-DM-03` | 按缺陷编号查询 |
| `q-dm-04` | `defect_management` | defect_trend_statistics | 统计 | 缺陷趋势 | `BUG-DM-04` | 按周统计 |
| `q-ds-01` | `data_sync` | sync_task_configure | 配置 | 数据同步任务 | `SYNC-DS-01` | 定时每 15 分钟执行 |
| `q-ds-02` | `data_sync` | incremental_sync_execute | 同步 | 增量数据 | `SYNC-DS-02` | 每次最多同步 1000 条 |
| `q-ds-03` | `data_sync` | sync_failure_query | 查询 | 同步失败记录 | `SYNC-DS-03` | 按任务编号查询 |
| `q-ds-04` | `data_sync` | reconciliation_export | 导出 | 同步对账结果 | `SYNC-DS-04` | 必须保留 90 天 |
| `q-pa-01` | `permission_approval` | approval_rule_create | 创建 | 审批规则 | `AUTH-PA-01` | 必须二级审批 |
| `q-pa-02` | `permission_approval` | user_permission_validate | 校验 | 用户权限 | `AUTH-PA-02` | 仅限当前组织 |
| `q-pa-03` | `permission_approval` | approval_record_query | 查询 | 审批记录 | `AUTH-PA-03` | 按审批编号查询 |
| `q-pa-04` | `permission_approval` | approval_notification_send | 发送 | 审批通知 | `AUTH-PA-04` | 自动发送 |
| `q-qr-01` | `query_reporting` | report_data_query | 查询 | 报表数据 | `RPT-QR-01` | 按报表编号查询 |
| `q-qr-02` | `query_reporting` | business_metric_statistics | 统计 | 业务指标 | `RPT-QR-02` | 每 5 分钟统计 |
| `q-qr-03` | `query_reporting` | task_status_display | 展示 | 任务状态 | `RPT-QR-03` | 实时展示 |
| `q-qr-04` | `query_reporting` | query_result_export | 导出 | 查询结果 | `RPT-QR-04` | 最多导出 10000 条 |

业务域别名固定为：`rm`、`cm`、`dm`、`ds`、`pa`、`qr`。24 个查询 ID 必须全部出现且各不重复；每个域恰好出现四次。

## 3. 关系等级和标签语义

关系等级固定为以下五级：

```text
4=eligible_exact_duplicate
3=highly_similar
2=partial_overlap
1=same_pattern_or_topic_only
0=unrelated_or_hard_conflict
```

这些语义等级是数据构造协议的事实，不是对开放域真实数据的人工判断，也不是 Embedding、BM25、RRF 或 CrossEncoder 分数。生成器必须先依据场景变换确定等级，评测器再使用该等级计算指标。

### 3.1 各等级的构造边界

| 等级 | 构造事实 | 是否进入语义正例集合 | 说明 |
| --- | --- | --- | --- |
| `4` | 动作、对象、约束、否定状态和业务标识相同，候选符合资格；格式变体在业务归一化后也属于此级 | 是 | `S01` 是规范精确重复；`S02` 是格式变体。只有符合资格的记录才能成为精确正例 |
| `3` | 主要动作和对象一致，表达或非关键细节有受控差异，仍保持同一业务意图 | 是 | 不得改变动作、对象、否定或关键约束到冲突状态 |
| `2` | 共享部分业务对象、动作或约束，但只覆盖查询意图的一部分 | 是 | 不得伪装成完整业务重复 |
| `1` | 共享工作模式或主题词，但缺少同一业务对象的完整事实 | 否 | 保留为弱主题/模式相关性，仅用于 NDCG 分级增益，不进入 Recall 或 MRR 的相关候选集合 |
| `0` | 无关、资格不满足、关键信息缺失，或任一确定性硬冲突 | 否 | 不得被确认；硬冲突还必须进入冲突误确认统计 |

`S02 format_only_equivalent` 的语义等级为 `4`：它可以改变空白、标点、HTML 包装、实体编码或源字段排列，但归一化后的业务字段和 `hashRequirementBusiness` 必须与 `S01` 相同。它是独立候选记录和独立场景标签，不增加规范查询的 `S01` 槽位数量。

### 3.2 指标使用的标签集合

- **精确集合**：每条查询的 `S01` 和 `S02`，且 `candidateEligible=true`。`S15` 即使业务内容看起来精确，也不属于精确集合，因为它不符合资格。
- **语义正例集合**：`relevanceGrade >= 2` 且候选符合资格，即当前查询自己的 `S01` 至 `S06`。grade 1 不进入此集合。
- **NDCG 弱相关集合**：当前查询自己的 `S07`、`S08` 和 `S16`，等级固定为 `1`，只用于 `NDCG@10` 的分级增益。
- **安全负例集合**：当前查询自己的 `S09` 至 `S15`、`S17` 至 `S25`，加上该查询对应的全部 575 条跨查询候选。跨查询候选统一为 grade 0/unrelated；本地 `S09` 至 `S13` 是五类硬冲突，`S14` 是证据缺失，`S15` 是资格过滤，其他为无关或噪声。
- `Recall@1`、`Recall@5`、`Recall@10`、`Recall@50` 和 `MRR` 使用语义正例集合；`NDCG@10` 使用完整的 `0..4` 等级。
- 精确 `Recall@50` 只使用精确集合，并单独报告语义 `Recall@50`，避免格式变体、资格过滤和弱相关候选混淆硬门与工程指标。

## 4. 硬冲突和确定性决策边界

五类硬冲突是本目录的独立业务场景类别。每个候选最多标记一个 `hardConflictClass`；硬冲突统一使用等级 `0`，不得依赖模型解释改变其安全结论。

| hard-conflict 类别 | 构造规则 | 当前策略中的确定性触发 | 预期决策 |
| --- | --- | --- | --- |
| `action_conflict` | 保持对象和主题接近，但把动作替换为不同规范动作，例如 `查询` 与 `删除` | `normalizeRequirementAction` 结果不同，`ACTION_CONFLICT` | `rejected`，`relation=unrelated`，`mayConfirm=false` |
| `object_conflict` | 保持动作相同，替换为不相容业务对象，且对象字符重叠不足以形成层级包含 | `objectConflict`，`OBJECT_CONFLICT` | `rejected`，`relation=unrelated`，`mayConfirm=false` |
| `negation_conflict` | 动作、对象相同，但一方是肯定要求、另一方带否定表达 | `negated` 布尔值不一致，`NEGATION_CONFLICT` | `rejected`，`relation=unrelated`，`mayConfirm=false` |
| `identifier_conflict` | 动作、对象和约束模板相同，仅业务标识值不同，例如 `REQ-RM-03` 与 `REQ-RM-04` | 将标识写入同一约束键，使 `constraintsConflict` 触发 `CONSTRAINT_CONFLICT` | `rejected`，`relation=unrelated`，`mayConfirm=false`；报告保留业务类别 `identifier_conflict` |
| `key_constraint_conflict` | 同一约束类型的值不同，例如响应时间 `3 秒` 与 `10 秒`、数量上限 `500` 与 `1000` | `constraintKey` 相同但归一化约束值不同，`CONSTRAINT_CONFLICT` | `rejected`，`relation=unrelated`，`mayConfirm=false` |

`identifier_conflict` 是业务标签类别，当前生产策略没有单独的 `IDENTIFIER_CONFLICT` reason code，因此其 fixture 必须使用可被现有约束键识别的稳定标识格式；验收按业务类别统计，策略证据按 `CONSTRAINT_CONFLICT` 记录。该映射是冻结契约的一部分，不要求 Task 1 修改生产代码。

生产策略的优先级边界固定如下：

1. `candidateEligible=false` 先返回 `rejected/CANDIDATE_INELIGIBLE`。
2. 归一化版本不一致返回 `ambiguous/NORMALIZATION_VERSION_MISMATCH`；这是运行级兼容性门，不占用 25 个场景槽位。
3. 依次检查动作、否定、对象和约束冲突；任一命中都返回 `rejected`，不能被哈希或模型结果升级。
4. 任一必需业务事实缺失返回 `ambiguous/MISSING_REQUIRED_FIELD`。
5. 业务哈希相同且候选符合资格返回 `duplicate/confirmed/EXACT_BUSINESS_HASH`。
6. 仅 `normalizedTextMatches=true` 时返回 `duplicate/suggested/EXACT_NORMALIZED_TEXT`；该路径不能把结果升级为确认。
7. 其余无冲突候选最多为 `suggested`，`relation` 不得由解释模型擅自填成确认关系。

## 5. 每查询 25 个候选槽位

下表对每个查询逐字适用。每条 `q-*` 必须生成 `S01` 至 `S25` 各一条记录，因此单查询严格为 25 条；下表中的 `expectedReasonCode` 是策略证据约束，`none` 表示不得产生硬冲突 reason code。

| slot | scenario | relevanceGrade | hardConflictClass | 资格 | 构造协议 | expectedDecisionStatus / expectedReasonCode | 指标角色 |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| `S01` | `eligible_exact_duplicate` | 4 | `none` | `true` | 所有业务字段和稳定标识与查询相同；原始文本为规范版本 | `confirmed / EXACT_BUSINESS_HASH` | 精确正例、confirmed precision |
| `S02` | `format_only_equivalent` | 4 | `none` | `true` | 仅改变空白、标点、HTML 包装、实体编码或字段排列；归一化业务哈希与 `S01` 相同 | `confirmed / EXACT_BUSINESS_HASH`；`normalizedTextMatches` 可为 `true`，但哈希分支优先 | 精确正例、格式不变性 |
| `S03` | `highly_similar_same_object` | 3 | `none` | `true` | 保持动作和对象，改写非关键描述或展示细节；业务事实兼容且不产生哈希相等 | `suggested / none`，不得确认 | grade-3 召回、MRR、NDCG@10 |
| `S04` | `highly_similar_adjacent_object` | 3 | `none` | `true` | 保持同一动作和业务域，使用相邻对象或同一对象的兼容子范围 | `suggested / none`，不得确认 | grade-3 召回、MRR、NDCG@10 |
| `S05` | `partial_overlap_shared_object` | 2 | `none` | `true` | 共享主要对象，但只覆盖其中一个子流程或部分字段 | `suggested / none`，不得确认 | grade-2 召回、NDCG@10 |
| `S06` | `partial_overlap_shared_constraint` | 2 | `none` | `true` | 共享一个兼容约束，缺少查询的其他关键业务事实；约束值不得冲突 | `suggested / none`，不得确认 | grade-2 召回、NDCG@10 |
| `S07` | `same_pattern_or_topic_only` | 1 | `none` | `true` | 共享工作模式和少量主题词，但对象或场景只保持弱关联 | `suggested / none`，不得确认 | grade-1 弱相关，仅用于 NDCG@10 |
| `S08` | `topic_only` | 1 | `none` | `true` | 仅共享业务域或主题词，不共享完整业务意图；保持事实完整以避免落入缺失字段 | `suggested / none`，不得确认 | grade-1 弱相关，仅用于 NDCG@10 |
| `S09` | `action_conflict` | 0 | `action_conflict` | `true` | 对象接近但规范动作不同，例如查询对删除 | `rejected / ACTION_CONFLICT` | 硬冲突误确认率 |
| `S10` | `object_conflict` | 0 | `object_conflict` | `true` | 动作相同但对象不相容，且不构成对象层级包含 | `rejected / OBJECT_CONFLICT` | 硬冲突误确认率 |
| `S11` | `negation_conflict` | 0 | `negation_conflict` | `true` | 相同动作和对象，一方肯定、一方带 `不得`、`禁止` 或等效否定 | `rejected / NEGATION_CONFLICT` | 硬冲突误确认率 |
| `S12` | `identifier_conflict` | 0 | `identifier_conflict` | `true` | 同一标识约束模板下替换稳定业务标识值；只改变标识，不改变动作和对象 | `rejected / CONSTRAINT_CONFLICT`，`relation=unrelated`，`mayConfirm=false`；业务标签保留 `identifier_conflict` | 标识冲突误确认率 |
| `S13` | `key_constraint_conflict` | 0 | `key_constraint_conflict` | `true` | 同一关键约束模式下替换数值或阈值，例如 `3 秒` 对 `10 秒` | `rejected / CONSTRAINT_CONFLICT` | 约束冲突误确认率 |
| `S14` | `missing_required_field` | 0 | `none` | `true` | 候选缺少动作、对象或来源事实，`businessFacts.source=missing` | `ambiguous / MISSING_REQUIRED_FIELD` | 证据缺失安全门、零业务写入 |
| `S15` | `candidate_ineligible` | 0 | `none` | `false` | 候选可以使用精确或相似业务内容，但命中当前项目排除、来源资格或候选资格过滤 | `rejected / CANDIDATE_INELIGIBLE` | 资格过滤、精确集合排除 |
| `S16` | `same_title_description_diff` | 1 | `none` | `true` | 标题完全相同，描述含义明显不同但不构造动作、对象、否定或关键约束冲突 | `suggested / none`，不得确认 | 标题歧义、grade-1 弱相关，仅用于 NDCG@10；confirmed precision |
| `S17` | `long_unrelated_noise` | 0 | `none` | `true` | 候选包含至少 512 个 Unicode 字符的无关噪声，使用不同业务锚点；不标记硬冲突 | `suggested / none`，不得确认 | 噪声抑制、confirmed precision |
| `S18` | `cross_domain_distractor_01` | 0 | `none` | `true` | 来自另一业务域，保留可检索的通用词但不共享查询业务锚点 | `suggested / none`，不得确认 | 全局候选池、confirmed precision |
| `S19` | `cross_domain_distractor_02` | 0 | `none` | `true` | 来自第二个不同业务域，使用不同对象和业务标识 | `suggested / none`，不得确认 | 全局候选池、confirmed precision |
| `S20` | `cross_domain_distractor_03` | 0 | `none` | `true` | 来自第三个不同业务域，使用主题相近但业务事实不同的文本 | `suggested / none`，不得确认 | 全局候选池、confirmed precision |
| `S21` | `cross_domain_distractor_04` | 0 | `none` | `true` | 来自第四个不同业务域，保持可召回词但不共享规范业务意图 | `suggested / none`，不得确认 | 全局候选池、confirmed precision |
| `S22` | `unrelated_distractor_01` | 0 | `none` | `true` | 不同实体和流程的完整候选，加入少量通用动词作为词法干扰 | `suggested / none`，不得确认 | 无关抑制、confirmed precision |
| `S23` | `unrelated_distractor_02` | 0 | `none` | `true` | 不同实体和流程的完整候选，使用不同稳定标识 | `suggested / none`，不得确认 | 无关抑制、confirmed precision |
| `S24` | `unrelated_distractor_03` | 0 | `none` | `true` | 与查询只共享格式或产品名，不共享动作—对象业务事实 | `suggested / none`，不得确认 | 无关抑制、confirmed precision |
| `S25` | `unrelated_distractor_04` | 0 | `none` | `true` | 与查询无业务关系的完整候选，作为每组最后一个稳定干扰项 | `suggested / none`，不得确认 | 无关抑制、confirmed precision |

槽位计数对每条查询固定为：`2` 个 grade-4 槽位（其中 `S01` 是唯一规范 `eligible_exact_duplicate`，`S02` 是格式等价变体）+ `2` 个 grade-3 + `2` 个 grade-2 + `3` 个 grade-1 + `16` 个 grade-0 = `25`。其中 `S09` 至 `S13` 恰好覆盖五类 `hard-conflict`，没有任何硬冲突槽位遗漏。

## 6. 构造和归一化不变性

### 6.1 精确和格式场景

- `S01` 与查询共享相同的 `hashRequirementBusiness`，候选资格为真，必须能够走 `EXACT_BUSINESS_HASH` 的确认分支。
- `S02` 允许原始标题或描述包裹 `<p>`、实体编码、额外空白、标点差异，也允许输入字段在源载荷中的排列不同；清洗、NFKC、大小写和标点归一化后，业务字段及哈希必须与 `S01` 相同。
- 格式变体不能通过修改动作、对象、约束值、否定状态、产品域或模块来伪装；一旦修改这些事实，必须归入对应等级或硬冲突槽位。

### 6.2 业务事实和硬冲突场景

- 动作比较使用 `normalizeRequirementAction` 的别名语义，例如 `查询`、`检索`、`搜索`、`查看` 归一为同一查询动作；动作冲突必须使用归一化后确实不同的动作。
- 对象冲突必须使用不相容对象；对象的同义或层级包含不能标记为 `object_conflict`。
- 否定冲突由 `negated` 的肯定/否定差异构造；“不得”“禁止”“不允许”等否定表达都属于同一否定事实。
- 标识符冲突和关键约束冲突都使用同一约束键、不同原始值，保证现有 `constraintsConflict` 识别差异；两者在业务标签中保持独立统计。
- 缺失字段场景不能同时带有一个确定性硬冲突；缺失字段优先验证 `MISSING_REQUIRED_FIELD` 的安全边界。

### 6.3 全局候选池

候选记录生成后写入一个包含 600 条记录的全局索引。对任一查询，自己的 25 条候选读取第 5 节槽位标签，其余 575 条候选由评测器在运行时派生为 grade 0/unrelated，不创建额外标签记录。跨查询记录不得因其来源查询 ID 而被删除；它们必须经历同一 Dense、BM25/FTS5、RRF 和 CrossEncoder 链路，并参与该查询的 `NDCG@10` grade-0 排序背景、confirmed precision 和适用的无关/冲突误确认统计。若跨查询记录在词法或语义上接近，只能影响排序和安全指标，不能升级其 grade-0/unrelated 关系。

跨查询候选默认 `hardConflictClass=none`；若生产策略根据真实业务文本为其返回 `ACTION_CONFLICT`、`OBJECT_CONFLICT`、`NEGATION_CONFLICT` 或 `CONSTRAINT_CONFLICT`，它仍保持构造标签 grade 0/unrelated，并同时进入对应 reason code 的误确认统计。审计标签本身不得用于产生该策略判断。

## 7. 验收可追踪矩阵

| 目录覆盖 | 可观测断言 | 对应验收检查 |
| --- | --- | --- |
| `S01`、`S02`（24 条查询共 48 个符合资格精确场景） | 每条精确业务重复在 Top50；确认只来自这两类精确场景 | 精确 `Recall@50 = 100%`；`confirmed` precision `= 100%`；格式归一化证据为 `EXACT_BUSINESS_HASH` |
| `S01` 至 `S06` | 只有符合资格且 grade >=2 的候选进入语义 Recall/MRR 相关集合；等级 4、3、2 同时参与 NDCG 分级增益 | `Recall@1`、`Recall@5 >= 90%`、`Recall@10`、语义 `Recall@50`、`MRR >= 0.80`、`NDCG@10 >= 0.85`；逐关系和逐域报告 |
| `S07`、`S08`、`S16` | grade 1 保持弱主题/模式相关，但不进入 Recall@K 或 MRR 分母/命中数 | 只参与 `NDCG@10` 分级增益；不得被策略误升级为确认 |
| `S09` `action_conflict` | 任何动作冲突不得返回确认或正式关联 | `ACTION_CONFLICT` 误确认率为 `0`；纳入硬冲突总误确认率 |
| `S10` `object_conflict` | 任何对象冲突不得返回确认或正式关联 | `OBJECT_CONFLICT` 误确认率为 `0`；纳入硬冲突总误确认率 |
| `S11` `negation_conflict` | 任何否定状态冲突不得返回确认或正式关联 | `NEGATION_CONFLICT` 误确认率为 `0`；纳入硬冲突总误确认率 |
| `S12` `identifier_conflict` | 标识值不一致必须保持 `relation=unrelated`、`mayConfirm=false`，不得被解释模型或排序升级为确认 | 业务类别 `identifier_conflict` 误确认率为 `0`，策略 reason 为 `CONSTRAINT_CONFLICT` |
| `S13` `key_constraint_conflict` | 关键约束值不一致不得返回确认 | `CONSTRAINT_CONFLICT` 误确认率为 `0`；纳入硬冲突总误确认率 |
| `S09` 至 `S13` 全部五类 hard-conflict | 硬冲突集合没有漏类、没有确认、没有正式业务写入 | 硬冲突误确认率 `= 0`；按五类分别报告并报告聚合值 |
| `S14` `missing_required_field` | 缺失动作、对象或来源事实只能进入不确定安全边界 | `ambiguous`，reason 为 `MISSING_REQUIRED_FIELD`；正式业务写入数为 `0` |
| `S15` `candidate_ineligible` | 当前项目排除或资格过滤候选不能污染正例集合或确认结果 | `rejected/CANDIDATE_INELIGIBLE` 或在候选资格阶段排除；正式业务写入数为 `0` |
| `S17` 至 `S25` 长噪声、跨域和无关候选 | 无关候选可被检索但不能确认；跨查询记录仍在全局池 | `confirmed` precision `= 100%`；无关候选无正式业务写入 |
| 每条查询之外的 575 条跨查询候选 | 由评测器运行时派生为 grade 0/unrelated，不物化额外标签；完整进入 600 候选检索排名，任何一条被确认都是安全错误 | 跨查询无关误确认率 `= 0`；纳入 `NDCG@10` 的 grade-0 背景、confirmed precision，以及适用的 reason-code 误确认分母；正式业务写入数为 `0` |
| `S03` 至 `S08`、`S14` 至 `S25` 的所有 `suggested`、`ambiguous`、`rejected` 结果 | 非确认结果只能展示或拒绝，不能直接改变正式业务关系或需求状态 | `suggested`、`ambiguous`、`rejected` 正式业务写入数 `= 0` |
| 全部 24 条查询、600 条候选和六个域 | 数据清单、场景标签和索引规模一致 | 唯一 query/candidate ID；`queryCount=24`、`candidateCount=600`；六域覆盖；每查询 25 槽位；固定 seed 和快照哈希 |
| 全部 24 条查询的重复执行 | 相同数据、模型、索引和配置产生相同顺序、分数和决策 | 排序一致率 `= 100%`；稳定性报告包含每个 query ID |
| 全部 24 条查询的项目管理入口和需求分析 Agent 入口 | 两个入口消费同一生产核心结果 | 候选顺序、`finalRank`、关系和决策投影一致 |
| 全部评测运行 | 真实 CrossEncoder 身份正确且不发生降级；解释关闭 | CrossEncoder 降级次数 `= 0`；`degradationCodes` 不包含 `RERANKER_UNAVAILABLE`；解释不参与标签或排序 |

### 7.1 统计口径

- 精确召回的分母是每条查询的两个符合资格精确场景；被排除的 `S15` 不进入分母。
- 工程 `Recall@K` 和 `MRR` 的相关候选是符合资格且 `relevanceGrade >= 2` 的本地槽位，即每条查询的 `S01` 至 `S06`；grade 1 和全部跨查询候选都不进入相关候选集合。
- `NDCG@10` 按每条查询对全部 600 条候选的 `0..4` 等级计算，再给出 24 条查询的宏平均；grade 1 保留弱相关增益，575 条跨查询候选为 grade 0，不把硬冲突当成负等级之外的额外正例。
- 冲突误确认率按五类 hard-conflict 分别计算：该类别被确认的数量除以该类别出现的数量；聚合值使用五类总数。
- 跨查询无关误确认率按每条查询计算为 575 条运行时派生关系中被确认的数量除以 `575`，并按全部 `13800` 个运行时派生跨查询关系计算聚合值；这些关系不持久化，两种统计口径都必须为 `0`。若某个跨查询关系同时产生确定性冲突 reason code，该关系还进入对应 reason-code 误确认分母。
- `confirmed` precision 的分子是被生产策略正确确认的 grade-4 候选，分母是所有确认候选；任何本地 `S03` 至 `S25` 或任一跨查询候选被确认，都构成 confirmed precision 硬门失败或相应安全门失败。
- `suggested`、`ambiguous` 和 `rejected` 的业务写入计数必须在正式关联、需求状态和其他业务持久化入口分别核对，不能只检查 UI 展示。

## 8. 冻结结论

本目录已闭合以下范围：

- 固定数据版本、种子、24 条查询、600 条全局候选、六个业务域和每查询 25 个候选槽位；
- 24 个唯一 query ID、S01 至 S25 全部场景名、等级 `0..4` 和标签来源；
- `action_conflict`、`object_conflict`、`negation_conflict`、`identifier_conflict`、`key_constraint_conflict` 五类 hard-conflict 及其生产策略映射；
- 每条查询的 575 条跨查询候选由评测器运行时派生为 grade 0/unrelated，不物化额外标签，并完整参与检索和适用的安全统计；
- 审计 UID、查询 ID、场景、等级和预期决策与所有搜索字段、`normalizedText`、FTS/Dense/RRF/CrossEncoder 输入严格隔离；
- 精确、格式、语义等级、资格、缺失字段、噪声和跨域候选的决策边界；
- 精确 Recall@50、confirmed precision、硬冲突误确认率、零业务写入、Recall@K、MRR、NDCG@10、稳定性、降级和入口一致性的验收追踪。

Task 2 及后续实现必须保持本目录中的 ID、槽位数、等级、冲突类别和验收口径不变。
