# AI 语义化性能优化调研与实施方案

> 调研日期：2026-08-27
> 范围：资产中心「AI 语义化」的记录级语义卡片生成，不包含查询阶段的需求匹配重排。
> 结论性质：基于当前代码、现有需求约束、用户截图和公开官方资料的架构评审；尚未使用真实生产模型与完整生产数据集进行 A/B 基准。

## 1. 执行结论

优化前严重性能问题的首要原因不是 React 页面、SQLite 或网络流式解析，而是产品需求和后端实现共同锁死了一个高成本调用拓扑。以下固定拓扑和截图外推均是优化前基线，不代表本轮已落地行为：

```text
每条记录
  -> initial 深度推理
  -> independent 深度推理
  -> adjudication 深度推理
  -> 持久化

全部记录严格串行；每个 AI 阶段还允许最多 4 次结构校验尝试。
```

因此，33 条记录至少产生 99 次模型调用；如果三个阶段都耗尽校验重试，理论上可达到 396 次调用。截图中最近四条记录耗时为 632.9、228.4、255.6、286.0 秒，均值约 350.7 秒/条。按该样本外推，33 条约需 3 小时 13 分钟，和当前架构预期一致。

本轮已把固定“三阶段深度思考”改为 `standard/strict` 自适应质量路由；其核心行为是“结构化抽取 + 确定性校验 + 只对风险字段触发修复/裁决”：

```text
standard：确定性预处理与缓存命中
  -> 一次结构化抽取
  -> 程序校验（schema、UID、逐字证据、枚举、核心字段）
     -> 健康：直接 ready
     -> 失败/核心字段低置信：只做一次定向修复
strict：initial + 独立 independent（同记录并行）
  -> 分歧/低置信：才执行 adjudication
  -> 原子持久化与阶段边界审计
```

这不是降低正确性要求，而是把昂贵复核从“100% 无条件执行”改为“只对无法被程序证明安全的记录执行”。保留失败关闭、原文逐字证据、缓存签名、审计轨迹和查询阶段不偷偷生成卡片等现有正确性边界。单次模型请求仍有 15 分钟安全上限，但输出预算和结构校验重试已收紧。

目标应通过真实基准校准，建议首期以以下指标作为上线门：

| 指标 | 当前 | 首期目标 |
| --- | ---: | ---: |
| 平均模型调用数/记录 | 健康记录固定 3 次 | `<= 1.30` |
| 无升级 fast-path 占比 | 0% | `>= 80%` |
| 结构校验重试率 | 未聚合 | `< 3%` |
| 在线模型短记录 P50/P95 | 截图样本均值 350.7 秒 | `<= 20 / 60 秒` |
| 本地模型短记录 P50/P95 | 未测 | `<= 45 / 120 秒`，按硬件分档 |
| 33 条在线批量完成时间 | 样本外推约 193 分钟 | `<= 10 分钟`，并发 4、无持续限流时 |
| 不受支持的证据写入 | 程序失败关闭 | 继续保持 0 |
| 核心字段质量 | 无正式黄金集指标 | 相对基线下降不超过 1 个百分点 |

在完成真实 A/B 前，预估单条延迟可下降 3–8 倍、在线批量吞吐可提升 8–20 倍。这是工程目标，不是未经验证的承诺。

### 1.1 实施进度/本轮落地

以下是本轮代码已经落地、可以作为当前 PRD/验收基线的行为（行号以当前工作树为准）：

- `src/main/requirements/semanticization-service.ts:278-281` 将未指定质量模式默认到 `standard`，并把旧 `deepThinking=true` 兼容映射为 `strict`；`:451-469` 为 standard 健康路径执行一次结构化抽取，仅在核心字段低置信时做定向修复；`:470-516` 为 strict 并行执行不互相读取结论的 `initial`/`independent`，仅在分歧或低置信时调用 `adjudication`，否则合并已验证结果。
- `src/main/requirements/semanticization-service.ts:64-67`、`:718-733`、`:1107-1121` 将 `requirementType`、`productDomain`、`module` 等已知字段由服务端注入，模型不再承担这些字段的语义生成；`:135-187` 仍以严格 JSON Schema、逐字 `evidence` 文本、UID、置信度、枚举和核心字段作为输出校验边界。
- `src/main/requirements/semanticization-service.ts:49-62` 设置单次模型请求 15 分钟安全上限并收紧 standard/strict 阶段预算和重试预算；`:119-121` 将结构校验限制为一次定向修复尝试，失败仍关闭为 `failed`。
- `src/main/requirements/semanticization-service.ts:1088-1094` 保留内存/IPC 的完整事件流，但只在阶段开始/完成、模型错误、分歧等有意义边界持久化 trace；最终成功/失败路径仍保存可回看的结构化轨迹。质量模式与 trace/task 类型见 `src/shared/types.ts:474-496`、`:558-586`、`:611-630`。

本轮明确未实现、不得在需求或验收中写成已交付的能力：

- **跨记录有界并发**：`semanticization-service.ts:411-412` 仍按候选顺序逐条处理；strict 仅在同一记录内并行 `initial`/`independent`。
- **持久化 job manifest/恢复**：任务与候选仍由 `semanticization-service.ts:250-253`、`:331-332` 的服务进程内存持有，没有持久化 job/item、租约、进程重启恢复或崩溃续跑契约。
- **证据 ID 化**：当前 schema 仍要求模型返回逐字 `evidence` 文本（`:135-143`）；`evidenceIds` 预切分/服务端解引用只是后续方案。
- **完整指标平台**：当前 trace 仅保留安全的结构化模型使用量（`src/shared/types.ts:513-521`）和阶段事件，没有 records/min、队列、路由命中率等完整聚合与监控平台。

因此，本轮交付重点是“正确性约束保留、调用拓扑自适应、预算/重试收紧”；持久化队列、跨记录并发、证据 ID 和指标平台继续列入后续阶段。上述优化前基线中的固定三阶段、四次重试等描述只用于解释历史瓶颈，不应再作为当前实现断言。

### 1.2 本轮验收命令

文档/代码集成后的最小验收集如下；命令只验证已实现契约，不把后续并发、job 恢复、证据 ID 或完整指标平台当作本轮通过条件：

```powershell
npm run typecheck
npm run test:requirement-semanticization
npm run smoke:agent-requirement-analysis
npm run smoke:agent-similarity
npm run smoke:project-management
npm run build
git diff --check -- docs/requirement-matching-target.md docs/AI语义化性能优化调研与实施方案.md
```

`test:requirement-semanticization` 应报告 standard 健康/定向修复、strict 初步/独立复核/条件裁决的调用次数，`think`/质量模式快照，严格 Schema/UID/逐字证据/置信度/枚举校验，失败关闭、暂停/停止边界、trace 持久化和已知字段服务端注入。真实吞吐、P50/P95、跨记录并发和重启恢复基准需等后续实现专用 harness 后再设为门禁；本轮只能报告现有可观测字段，不能虚构完整指标平台。

## 2. 优化前基线与仍存在的瓶颈

本节保留优化前的调用拓扑和性能根因，用于解释为什么要调整需求硬约束；凡涉及固定三阶段、四次重试、全部事件写放大的表述，均是历史基线。当前已落地的 standard/strict 路由、预算和 trace 边界以第 1.1 节及当前源代码行号为准。

### 2.1 产品约束曾直接禁止并行和快速路径

优化前的 `docs/requirement-matching-target.md` 曾要求所有记录固定完成 `initial + independent + adjudication`，并把记录级串行写成不可妥协条件。本轮已改为：standard 健康路径一次抽取、失败/核心字段低置信才定向修复；strict 初步与独立复核并行，分歧/低置信才裁决。当前目标文档仍明确跨记录按候选顺序处理，跨记录有界并发留在后续阶段。

因此，线程池、数据库或 UI 不能替代已经完成的路由调整；后续若要获得批量吞吐数量级改善，还必须另行实现有界并发、背压和持久化 job manifest，但这些不属于本轮交付。

### 2.2 后端当前按质量模式选择模型调用拓扑

`src/main/requirements/semanticization-service.ts` 当前证据：

- 第 411–412 行仍按候选顺序逐条处理记录，跨记录没有有界并发；
- 第 451–469 行 standard 只执行 `initial`，核心字段低置信时才调用一次定向修复；
- 第 470–516 行 strict 对 source-only 原文并行执行 `initial`/`independent`，只在分歧或低置信时进入 `adjudication`；
- 第 849–980 行将结构校验尝试限制为两次（初次输出 + 一次定向修复），不是优化前的每阶段最多四次。

本轮因此已消除“健康记录无条件第三次裁决”的约束，但跨记录串行仍是当前实现边界。strict 的同记录并行不能误读为批量任务已支持跨记录并发。

### 2.3 推理与输出预算远大于结构化抽取需要

当前服务中：

- 第 51–57 行阶段预算已收紧为：initial `deep/standard=2400/1200`、independent `2200/1200`、adjudication `2000/1200` Token；
- 第 59–62 行定向重试预算按失败字段数缩放，最高 2,400 Token；
- 第 202–210 行上下文按提示词和输出预算动态计算，上限 24,576、下限 4,096；
- 第 49 行每个模型请求最长等待 15 分钟；
- 第 859–874 行仅 strict 发送 `think/forceThinking=true`，standard 使用关闭思考的标准路由。

最终对象只有 15 个语义字段、置信度、证据和摘要。大多数短需求不需要数千个可见输出 Token，更不应默认在所有阶段使用高成本推理。对推理模型而言，`max_completion_tokens` 还会覆盖隐藏推理 Token，过大的预算和固定 reasoning 会进一步放大尾延迟。

结构化输出仍要求逐字 evidence 文本，长原文或校验失败会增加输入和重试成本；当前通过一次定向修复、按字段数缩小预算和 `done_reason=length` 失败关闭来控制上界。证据 ID 化可进一步降低成本，但尚未实现，见第 1.1 节。

### 2.4 模型重复生成服务端已经知道的字段

`requirementType`、`productDomain`、`module` 已从数据中心明确字段读取。本轮第 64–67、647–649、718–733、1107–1121 行已将它们从模型语义字段中移除并由服务端注入，保留原始字段事实，不再要求模型重复生成。该项是本轮已落地的成本与一致性优化，不应再写成待实现建议。

### 2.5 让模型复制原文证据，制造了可避免的重试

当前实现仍要求模型为每个字段逐字复制 `evidence`，程序再检查该字符串是否出现在原文。常见失败包括空白、标点、截断或轻微改写；本轮只允许一次定向修复，最终仍失败则关闭为 `failed`，不做“完整修复 -> 字段修复 -> 证据校准”的级联重放。

证据 ID 化本轮明确未实现，以下方案只是后续阶段候选，不能写成当前交付：

推荐在请求前把原文切分为稳定证据片段：

```json
{
  "E1": "名称：开发文档对比的结果支持Excel导出",
  "E2": "描述：支持将对比结果导出为 Excel 文件"
}
```

未来可让模型只返回 `evidenceIds: ["E2"]`，服务端按 ID 解析为原文片段并保存现有 `evidence` 字符串。这样可以从机制上消除“模型改写证据”类失败，同时显著减少输出 Token；在该能力落地前，验收必须继续以逐字 `evidence` 文本校验为准。

### 2.6 供应商结构化输出能力没有统一落地

`src/main/model-client.ts` 当前行为：

- Ollama 使用 `format: JSON Schema`；
- OpenAI 使用 `response_format.json_schema` 且 `strict: true`；
- DeepSeek、Qwen、智谱、Moonshot、MiniMax 和通用兼容端点只退化到 `json_object`；
- Anthropic 只在 system 中提示“输出 JSON”，没有发送其现已支持的 `output_config.format` JSON Schema。

这会让不同供应商的 schema 成功率和重试率差异很大。特别是 Anthropic 路径没有利用官方结构化输出能力，是可以直接修正的实现缺口。

### 2.7 使用流式模式却没有消费可见增量

本轮语义化请求已在 `src/main/requirements/semanticization-service.ts:865-874` 使用 `stream: false`，UI 只展示阶段事件而不展示结构化输出的逐 Token 增量。对这种短结构化响应，非流式模式可减少协议解析和中途错误处理复杂度；后续仍应按供应商能力验证，而不能把流式状态写成当前语义化契约。

### 2.8 任务并发和运行态只存在于单进程内存

任务候选和当前任务快照仍存放在 `RequirementSemanticizationService` 内存中，语义卡片表保存记录状态和分析轨迹。`all_unready` 还会一次读取并保留全部候选，任务内存随记录数线性增长。当前设计因此只能启动一个活动任务，也没有持久化 job item、游标、租约、重试时间和 worker 状态；本轮不交付安全的跨记录有限并发、超大批量流式入队或进程重启恢复。

此外，当前任务类型仍只有 `completed`，循环结束即使有失败记录也以完成状态结束；后续可增加 `completed_with_errors` 或等价 outcome，避免把“队列已经跑完”和“全部成功”混为一谈，但这不是本轮已交付状态。

### 2.9 候选检查和 claim 存在同步 SQLite N+1

selected 模式会针对每个 UID 依次读取完整记录、内容 hash、语义状态，再通过 `getReadyRequirementSemanticCard` 重复读取并解析一次状态；真正执行前又会读取 hash，claim 内再读取状态，随后再加载一次完整记录。`getRequirementSemanticCardState` 使用 `SELECT *` 并解析完整 card/trace，而判断“是否 ready”并不需要这些大字段。

这不是截图中数百秒延迟的主因，但在 fast-path 和大批量上线后会成为明显瓶颈。应增加批量 metadata-only 候选查询、轻量 semantic source 查询，并用带 hash/signature/status 条件的 `UPDATE ... RETURNING` 或等价事务做原子 claim，避免竞态和重复反序列化。

### 2.10 审计轨迹存在全量 JSON/IPC 写放大

优化前健康记录每个 `stage_started`、`validation_passed`、`stage_completed` 都会克隆完整 task/trace 并覆盖 `analysis_trace_json`，产生明显写放大。当前实现已改为保留内存/IPC 完整事件流，只在阶段开始/完成、模型错误、分歧等有意义边界持久化（`semanticization-service.ts:1088-1094`），失败/成功终态另行 flush；完整指标平台仍未实现。

模型很慢时这不是首因，但新架构把模型耗时降下来后会限制吞吐。推荐 append-only event + 阶段 snapshot，或至少合并普通进度写、在 retry/fail/stop/complete 强制 flush。

### 2.11 测试把低效实现写成了正确性契约

优化前的 `tests/requirement-matching/semantic-card-analyzer-regression.ts` 曾把固定三次调用、无条件裁决、流式请求和串行步骤写成测试契约。当前验收应改为断言 standard/strict 路由的结果与边界：健康 standard 不调用独立复核，strict 只在分歧/低置信时裁决；所有路径都验证 Schema、UID、证据、置信度、枚举和失败关闭。测试还需要报告调用数、预算、重试、缓存和 trace，但本轮尚无完整指标平台或跨记录并发门禁。

## 3. 后续目标架构与未交付优化

本节区分“本轮已经落地的 standard/strict 路由”与后续工程方案。凡涉及 `backfill`、跨记录有界并发、持久化 job/item、证据 ID 或完整指标平台，均是后续设计，不代表当前代码已经具备。

### 3.1 质量路由而不是固定三阶段

当前 UI/服务契约只落地并暴露“标准/严格”两个质量模式；`backfill` 仍是后续内部策略候选，不得作为当前可用能力：

| 策略 | 适用场景 | 调用拓扑 |
| --- | --- | --- |
| `standard`（默认） | 日常增量、单条、普通批量 | 轻量模型 1 次；风险触发时再修复或升级 1 次 |
| `strict` | 高风险数据、抽查、发布前复核 | 两个独立分析并行；仅有分歧时执行裁决 |
| `backfill` | 大规模历史数据、无需即时完成 | 记录级批处理 API 或支持连续批处理的本地推理服务 |

标准模式的当前/目标状态机（`strong_review` 是后续可选升级，不是本轮阶段）：

```text
pending
  -> cache_hit -------------------------------> ready
  -> extracting
       -> deterministic_validation
          -> pass + low_risk -----------------> ready
          -> field_repair (最多 1 次) --------> ready / escalate
          -> strong_review (最多 1 次) -------> ready / failed
```

严格模式不应继续串行运行两个独立分析。两轮都只依赖原文，可并行启动；只有分歧字段或低质量字段进入裁决。一致且通过程序校验的结果直接合并。

### 3.2 风险门控必须使用可验证信号

不能只依赖模型自报的 `confidence`。建议风险分由以下信号组成：

1. schema 是否严格通过；
2. 当前以逐字 evidence 文本是否存在、是否覆盖核心结论为准；证据 ID 是否存在属于后续方案，尚未实现；
3. `functionalObject`、`behavior` 等核心字段是否完整；
4. `action` 等枚举与跨字段关系是否一致；
5. 原文是否只有标题、过短、过长、含大量表格/图片占位或多语言混杂；
6. 抽取结果是否与明确原始字段冲突；
7. 当前模型/领域在黄金集中的历史校准错误率；
8. 严格模式下两次独立结果的字段分歧。

模型返回的置信度可以作为一个弱特征，但 UI 若继续显示“置信度”，应显示经黄金集校准后的分数或明确标注为“模型自评”，不能把未校准的 0–1 数字当作真实正确概率。

### 3.3 缩短 schema 与生成（本轮已落地项与后续项）

首版建议：

- 从模型输出移除 `recordUid` 之外可由请求上下文可靠关联的冗余字段；若保留 UID，用它做错配保护；
- 三个明确原始字段的模型生成已由本轮服务端移除并注入；
- 将证据字符串改为短 `evidenceIds`、持久化前再解引用仍是后续方案，本轮继续使用逐字 `evidence`；
- `analysisSummary` 限制为 120–200 字，或仅在升级路径生成；
- 当前已按 standard/strict 阶段设置 1,200–2,400 Token 级预算并限制重试；是否继续压缩到 700–1,000 Token 需基于真实分布校准；
- 当前 standard 关闭思考、strict 开启思考；更细的 reasoning effort 分档仍需模型供应商能力验证；
- 温度使用 0 或供应商允许的最低值；
- 短结构化响应默认非流式；
- 本地 `num_ctx` 使用“实际提示 Token + 输出预算 + 20% 安全余量”的最小可用档位，不固定至少 8K。

输出预算必须通过基准数据确定，不能只把 4,800 机械改成一个未经验证的常量。

### 3.4 供应商能力适配层

在 `ModelClient` 上增加显式能力，而不是用 provider 名称隐式猜测：

```ts
type ModelCapabilities = {
  strictJsonSchema: boolean
  reasoningEfforts: Array<'none' | 'minimal' | 'low' | 'medium' | 'high'>
  promptCaching: 'automatic' | 'explicit' | 'none'
  batch: boolean
  usage: { cachedTokens: boolean; reasoningTokens: boolean }
  maxConcurrency?: number
}
```

适配建议：

- OpenAI：使用 strict JSON Schema；显式配置低 reasoning effort；记录 cached/reasoning token；稳定前缀在前，动态记录在后；
- Anthropic：使用 `output_config.format`；静态 system/schema 使用 prompt cache breakpoint；
- Ollama：继续使用 JSON Schema，短结构化结果非流式；设置合适的 `keep_alive` 避免每条重新装载模型；只有在内存/显存允许时提高并行；
- OpenAI-compatible：启动时做一次结构化输出能力探测，不支持 strict schema 时优先使用严格工具调用；仍不支持时才使用 JSON object + 一次本地校验；
- 本地集中部署：当历史回填规模较大且硬件允许时，可评估 vLLM 的连续批处理、结构化输出和 automatic prefix caching；桌面单机不应强制引入该运维复杂度。

### 3.5 有限并发、背压与持久队列

新增 `semanticization_jobs` 和 `semanticization_job_items`，每条 item 保存：

- job、record UID、content hash、policy/model/schema signature；
- 状态、优先级、attempt、route、next retry time；
- worker lease、heartbeat、开始/完成时间；
- 各阶段 Token、耗时、错误码和最终结果引用。

worker 通过原子 claim 获取 item，写入必须检查 hash/signature 仍匹配。并发策略：

- 在线 API 默认并发 4，根据 429、限流头、超时率和账户配额自适应到 1–8；
- Ollama 默认并发 1。只有确认模型完全驻留且有足够 RAM/VRAM 时才尝试 2；官方说明同一模型的并行请求会按并行数放大上下文内存；
- vLLM 等服务使用服务端连续批处理，客户端仍设置有界 in-flight；
- pause 停止领取新 item；graceful stop 等待当前调用结束；immediate cancel 使用 AbortSignal 取消当前请求并丢弃半成品；
- 模型请求在 stopping/cancelling 后以 timeout/rejection 结束时，必须优先把当前 item 释放为 pending/cancelled，不能走普通错误路径误标 failed；
- 429/503/网络瞬断采用指数退避加抖动，schema/证据失败只做一次定向修复，不做相同请求重放。

全量任务在逻辑上仍覆盖启动时的全部未就绪记录，但实现上应分页建立 manifest 或边扫描边入队，只保留 `O(worker + prefetch)` 的活跃内存。任务提交 ACK 的 P95 应不超过 2 秒，不能因为同步扫描和反序列化全部卡片而阻塞 UI。

### 3.6 缓存、去重与签名

保留当前 `contentHash + analyzerVersion + modelSignature` 缓存原则，并做三项修正：

1. 签名必须加入 `policyVersion`、`schemaVersion`、prompt version、reasoning effort 和结构化输出模式；
2. 当前 `requirementSemanticModelSignature()` 固定写入 `thinking: true`，会让关闭深度思考生成的卡片与开启模式共享签名，应修复；
3. 增加同一批次的 `semanticSourceHash` single-flight：完全相同的业务原文和明确字段只发起一次模型调用，其余等待并复用已验证模板。

不建议首期做“按字段增量复用”。原文局部变化可能改变多个字段语义，错误复用的质量风险高于节省收益。

### 3.7 审计与数据库写入

保留可审计过程，但不再要求展示固定三阶段。新的审计事件应是：

- `cache_hit`、`extraction_started/completed`；
- `validation_passed/failed` 与失败码；
- `route_selected` 及可解释的客观风险信号；
- `field_repair_started/completed`；
- `strong_review_started/completed`；
- `persisted`、`cancelled`、`failed`。

把 trace event 追加到事件表，或在阶段边界事务化写入；不要每次都序列化并覆盖整份不断增长的 JSON。UI 进度事件节流到平均不超过 2 次/秒，任务快照从持久化 job/item 汇总，可在应用重启后恢复。

## 4. 不同方案的取舍

| 方案 | 单条延迟 | 批量吞吐 | 质量风险 | 建议 |
| --- | --- | --- | --- | --- |
| 只缩短 prompt/Token | 小到中等改善 | 小到中等 | 低 | 必做，但不足以根治 |
| 保持三阶段，前两轮并行 | 约 1.3–1.8 倍改善 | 可叠加并发 | 低 | 无法改需求时的兼容方案 |
| 单次抽取 + 风险升级 | 约 3–8 倍改善 | 约 8–20 倍 | 需要黄金集校准 | 推荐默认方案 |
| 多记录塞进一个同步请求 | 可能减少请求数 | 对短记录有益 | 单条失败影响整批、上下文膨胀 | 不建议作为交互默认 |
| OpenAI/Anthropic 异步 Batch | 不适合即时反馈 | 高、成本通常低 50% | 完成时间不可控 | 仅历史回填/夜间任务 |
| 更换本地 vLLM 服务 | 单条未必大幅下降 | 连续批处理下高 | 运维与 GPU 门槛 | 服务器部署可选，桌面端非首期 |
| 微调/蒸馏小模型 | 高 | 高 | 需要高质量标注与持续评估 | 数据积累后的第三阶段 |

如果业务暂时坚持“每条三阶段不可变”，最低限度应执行：

1. `initial` 与 `independent` 并行；
2. 只有存在分歧/低质量字段时调用 `adjudication`（若这一条也不能改，则仍会保留固定第三次调用）；
3. 记录级在线并发 2–4；
4. 证据 ID、确定字段服务端合并、严格结构化输出、缩短预算；
5. 本地 Ollama 先确认 VRAM，再开启并行，避免上下文内存放大导致反而变慢或 OOM。

## 5. 观测与性能基准

### 5.1 必须新增的指标

每条记录至少记录：

- `queue_ms`、`ttft_ms`、`model_ms`、`validation_ms`、`persist_ms`、`wall_ms`；
- prompt、cached prompt、reasoning、visible output Token；
- provider、model、reasoning effort、policy/schema/prompt version；
- route、模型调用数、repair 次数、强模型升级原因；
- cache hit、single-flight dedupe hit；
- schema/evidence/enum/core-field/cross-field 错误码；
- 429、5xx、timeout、cancel、provider request ID；
- 吞吐（records/min）、in-flight、队列深度和 ETA。

当前 trace 已有部分 Token 和时长字段，但缺少聚合与性能门禁，不能仅依赖 UI 中“单条秒数”。

现有 `smoke-performance-regressions` 主要覆盖数据库事务、快照、通用任务取消和知识库缓存；`benchmark-requirement-matching` 测的是召回/重排而非语义卡片 AI 生成。两者都不能充当语义化端到端性能门，必须新增专用 harness，至少覆盖 1、10、100、500 条任务、冷热缓存、短中长文本、repair/timeout/length、暂停/恢复/停止和最大 in-flight。

### 5.2 黄金集

建立至少 300 条、按真实分布分层的脱敏黄金集：

- 标题-only、短描述、长描述；
- HTML、表格、列表、图片占位；
- 明确/缺失产品域、模块、需求类型；
- 多动作、否定、现状与目标混合、条件/约束/验收；
- 中英混合、缩写、相似名称、歧义记录；
- 已知历史失败与高耗时样本。

至少 20% 双人标注仲裁。黄金集不能只使用当前模型生成结果反标，否则无法发现三阶段共同偏差。

### 5.3 质量与性能验收

质量门：

- JSON/schema 通过率 `>= 99.5%`；
- 证据 ID 解析成功率 100%，不受原文支持的最终 evidence 为 0；
- action macro-F1、核心对象/行为 F1 相对当前三阶段基线下降不超过 1 个百分点；
- downstream matching 的 Recall@20/NDCG@10/正式关系准确率不得显著下降；
- 内容、模型、策略或 schema 变化后缓存 100% 正确失效；
- source-only 查询路径继续可用，不得因卡片待处理阻断匹配。

性能门：

- 任务提交 ACK P95 `<= 2s`，任务活跃内存保持 `O(worker + prefetch)`；
- 标准模式平均调用数 `<= 1.30`、P95 `<= 2`；
- fast-path `>= 80%`，强模型升级率建议 `< 15%`；
- 在线模型短记录 P50/P95 `<= 20/60s`；
- 同一硬件本地模型短记录 P50/P95 `<= 45/120s`；
- 33 条在线并发 4 批量 `<= 10min`，且无数据错配；
- 暂停后不再领取新 item；立即停止在 2 秒内进入 cancelling，当前请求中断或明确报告供应商不支持；
- 崩溃重启后 processing 租约过期并恢复为可重试，不产生重复 ready 或跨 UID 写入。

所有目标按提供者和模型分桶，不能把在线 API、本地 CPU 和不同 GPU 的数据混成一个平均值。

## 6. 分阶段实施计划

### 阶段 0：先建立可测基线（1–2 天）

1. 新增语义化真实基准脚本，不调用生产写库；
2. 汇总现有 trace 中的时长、Token、调用次数和校验错误；
3. 固化 50–100 条初始黄金集，跑当前三阶段作为基线；
4. UI 增加 records/min、ETA、平均调用数和升级率，不展示未校准“百分比准确率”。

退出条件：能够回答时间花在排队、输入、推理、可见输出、重试还是持久化。

### 阶段 1：低风险快速收益（3–5 天）

1. Anthropic 接入真正的 `output_config.format`；兼容端点增加 capability probe；
2. 改为证据 ID；确定字段不再要求模型生成；
3. 短结构化调用默认非流式；
4. 以基准数据收紧 `numPredict/numCtx/reasoning effort/timeout`；
5. schema 修复最多 1 次，只重做失败字段；
6. 修正模型签名中的实际 reasoning/policy/schema；
7. 把静态 prompt/schema 放在前、动态记录放在后，并接入供应商 prompt cache 统计。

退出条件：保持三阶段的情况下，单条 P50 至少下降 30%，schema 重试率低于 3%，质量门通过。

### 阶段 2：架构性优化（5–10 天）

1. 实现 `standard` 单次抽取 fast-path 与客观风险门；
2. 只对失败字段做一次修复，高风险记录只升级一次强模型；
3. 实现持久 job/item、租约、heartbeat、重试与恢复；
4. 在线有限并发 4，自适应限流；Ollama 默认 1；
5. 新审计事件替代固定三阶段 UI 文案；
6. 灰度 shadow 比较新旧输出，不立即覆盖当前 ready 卡片。

退出条件：平均调用数 `<= 1.30`，吞吐提升至少 5 倍，核心质量相对基线不下降超过 1 个百分点。

### 阶段 3：规模化与成本优化（后续）

1. 历史回填接入 OpenAI/Anthropic Batch；
2. 相同语义源 single-flight 与跨任务模板缓存；
3. 有服务器 GPU 时评估 vLLM 连续批处理和 prefix caching；
4. 积累高质量已裁决样本后蒸馏/微调小模型；
5. 用线上反馈定期重新校准路由阈值。

## 7. 需要修改的主要文件

| 范围 | 文件 | 主要变化 |
| --- | --- | --- |
| 产品契约 | `docs/requirement-matching-target.md` | 固定三阶段/串行改为质量路由与 SLO |
| 调度与分析 | `src/main/requirements/semanticization-service.ts` | fast-path、风险门、有限并发、证据 ID、重试策略 |
| 供应商适配 | `src/main/model-client.ts` | 能力模型、Anthropic schema、reasoning effort、cache/usage、非流式 |
| 持久化 | `src/main/database.ts` | job/item/lease/metrics/trace event 表与原子 claim |
| 类型/IPC | `src/shared/types.ts`、`src/preload/index.ts`、`src/main/index.ts` | policy、route、指标、恢复和取消契约 |
| UI | `src/renderer/src/App.tsx` | 质量模式、吞吐/ETA、升级原因、持久任务状态 |
| 回归 | `tests/requirement-matching/semantic-card-analyzer-regression.ts` | 从固定调用步骤改为质量结果、路由和并发断言 |
| 基准 | 新增 `scripts/benchmark-semanticization.ts` | 真实/回放基准、质量与延迟报告 |

## 8. 关键风险与决策

1. **必须先决定是否允许修改“三阶段/全串行”产品硬约束。** 不允许修改时只能获得有限改善。
2. **不能用模型自报 confidence 直接决定跳过复核。** 路由阈值必须来自黄金集校准和可验证信号。
3. **批量 API 不是交互加速器。** OpenAI Batch 当前完成窗口为 24 小时，适合低成本历史回填，不适合用户等待的当前任务。
4. **本地并发不是越大越好。** Ollama 会随并行请求数放大上下文内存；显存不足时请求排队甚至退化。
5. **模型/策略切换必须进入缓存签名。** 否则不同质量模式的卡片会被错误复用。
6. **先 shadow，再替换。** 新路径至少对 10%–20% 记录同时运行旧基线并比较，连续通过质量门后再扩大。
7. **数据合规需单独确认。** 在线 prompt caching 和异步 Batch 的数据处理/保留策略应按组织要求评审；不能仅因性能收益默认开启。
8. **需要明确 `ready` 的质量资格。** 推荐只有通过统一硬校验与黄金集门槛的 `standard/strict` 结果可以 ready；未经完整校验的快速预览必须保存为 `provisional`，且不得参与正式匹配。

## 9. 调研依据

- [OpenAI Latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization)：减少请求、减少输出 Token、并行化、把动态内容放到共享前缀之后，并用真实样本测试取舍。
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)：使用 strict JSON Schema 约束结构化结果。
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)：复用稳定提示前缀并观测缓存 Token。
- [OpenAI Batch API](https://platform.openai.com/docs/api-reference/batch/object?api-mode=responses)：异步批处理、当前 24 小时窗口和 50% 折扣，适合回填而非交互。
- [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)：JSON Schema、低温度和客户端校验。
- [Ollama Streaming](https://docs.ollama.com/api/streaming)：短响应和结构化输出更适合非流式。
- [Ollama FAQ](https://docs.ollama.com/faq)：`keep_alive`、并发、队列和并行上下文内存放大。
- [Claude Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)：`output_config.format` 的 schema 约束能力。
- [Claude Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)：静态前缀、cache breakpoint、TTL 和使用量观测。
- [Claude Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)：异步批处理和 50% 价格。
- [vLLM Automatic Prefix Caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/) 与 [Structured Outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/)：集中式本地推理的可选能力。
- [FrugalGPT](https://arxiv.org/abs/2305.05176) 与 [RouteLLM](https://arxiv.org/abs/2406.18665)：用级联/路由在质量约束下减少强模型调用，而不是对所有输入固定执行同样昂贵的路径。
