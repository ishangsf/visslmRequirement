# 08 已知问题、风险与技术债

> 最后分析时间：2026-08-01（Asia/Singapore）  
> 代码基线：Git `9bab57fc5166770784c1855857a6e1a8ebaa6200`；分析对象为当前工作树，工作树含未提交改动。  
> 严重程度：高表示可能造成数据泄露、错误回写、不可恢复数据损失或阻断核心流程；中表示明显的可靠性、维护性或契约风险；低表示局部体验/治理问题。  
> 本清单记录代码审计发现，不等同于已确认的生产事故。

## 1. 明确缺陷与前后端不一致

| 编号 | 问题描述 | 影响范围 | 严重程度 | 代码位置 | 建议方案 | 需业务确认 |
| --- | --- | --- | --- | --- | --- | --- |
| BUG-001 | 没有集中式错误码；IPC 既有 `ok=false` 结果，也有直接 rejection，renderer 只能依赖文本或逐页处理 | 所有页面的错误提示、自动重试和监控 | 中 | `src/main/index.ts:122-846`、`src/shared/types.ts`、`docs/06-api-design.md` | 定义稳定错误码和统一错误 envelope，保留用户可读 message | 否，接口兼容策略需确认 |
| API-001 | `projects:discard-draft` 已在 preload/handler 实现，但静态扫描未发现 renderer 调用 | 项目草稿清理 | 低 | `src/preload/index.ts:176`、`src/main/index.ts:731-733` | 增加明确 UI 入口或删除未使用 API；先补行为测试 | 是 |
| API-002 | `analytics:field-profile-semantics` 已暴露并可写字段语义，但未发现 renderer 编辑入口 | 字段显示名、角色、敏感级别维护 | 中 | `src/preload/index.ts:104-107`、`src/main/index.ts:269-273` | 明确这是预留接口还是应提供编辑 UI；补调用链和 smoke | 是 |
| API-003 | `AppDatabase.listSyncRuns()` 只存在数据库内部，未通过 IPC/preload 暴露 | 同步历史查看 | 低 | `src/main/database.ts:4966-4979` | 若产品需要同步历史，补齐 API/UI；否则标记内部保留 | 是 |
| API-004 | 静态扫描未确认 renderer 调用但 handler 缺失的方法；动态字符串调用和构建产物未单独验证 | IPC 契约 | 中 | `src/renderer/src`、`src/preload/index.ts`、`src/main/index.ts` | 在 CI 解析 `window.visslm`、preload 和 handler 名称，建立自动契约检查 | 否 |

## 2. 数据一致性风险

| 编号 | 问题描述 | 影响范围 | 严重程度 | 代码位置 | 建议方案 | 需业务确认 |
| --- | --- | --- | --- | --- | --- | --- |
| DATA-001 | `pm_project_documents.is_current` 的“每个项目只有一个当前文档”主要依赖服务层，没有数据库唯一索引 | 技术协议当前版本、需求来源和预览 | 高 | `src/main/database.ts` 项目文档 schema；`src/main/project-management.ts` 文档关联逻辑 | 使用部分唯一索引或事务更新旧版本，再增加并发测试 | 是，需要确认当前协议定义 |
| DATA-002 | `pm_cost_entries.asset_record_uid`、`responsible_participant_id` 等可选关联没有完整外键保护，删除后可能留下悬空 ID | 成本台账、资产和责任人 | 中 | `src/main/database.ts` `pm_cost_entries` schema；`src/main/project-management.ts:594-603` | 增加 FK/删除策略或明确这是历史快照字段；读写时校验并告警 | 是 |
| DATA-003 | `records` 删除会级联知识分块、向量以及项目资产关联；数据删除接口会同时影响检索和项目匹配 | 数据中心、知识库、项目管理 | 高 | `src/main/database.ts` records/knowledge/PM FK；`src/main/index.ts:617-621` | 删除前展示影响范围，增加软删除/回收站或可恢复备份 | 是 |
| DATA-004 | `AppDatabase.migrate()` 是集中式幂等 SQL，没有独立 migration 版本和回滚脚本；现有数据库升级依赖代码路径 | 升级、回滚、跨版本数据 | 中 | `src/main/database.ts:452-1037` | 引入 schema version、增量 migration、备份和升级 smoke | 否 |
| DATA-005 | `sync_runs` 会记录同步状态，但 `listSyncRuns()` 没有 UI 暴露；运行历史可写不可见 | 运维判断同步是否成功 | 低 | `src/main/database.ts:4966-4979`、`src/main/index.ts:170-180` | 暴露分页/详情接口，或清晰定义仅审计内部用途 | 是 |

## 3. 安全风险

| 编号 | 问题描述 | 影响范围 | 严重程度 | 代码位置 | 建议方案 | 需业务确认 |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | 默认 VISSLM 地址使用 HTTP；若生产配置未改为 HTTPS，Token 传输可能被窃听 | 平台认证和同步/推送 | 高 | `src/main/settings.ts:17`、`src/main/visslm.ts:148-217` | 生产强制 HTTPS、证书校验和地址白名单；UI 对 HTTP 给出显著警告 | 是 |
| SEC-002 | 在线模型上下文外发没有统一字段脱敏/分级层；项目协议上传有显式确认，但普通问答/大屏数据范围由调用方决定 | 业务数据、协议、记录字段 | 高 | `src/main/model-client.ts`、`src/main/ollama.ts`、`src/main/project-management.ts:191-194` | 统一数据外发策略、字段分级、审批/审计和默认拒绝规则 | 是 |
| SEC-003 | 推送预览、推送结果和日志可能包含完整业务请求体/响应内容 | 日志、截图、导出和诊断 | 中 | `src/main/visslm.ts:517-670`、`src/shared/types.ts` | 日志默认摘要化，敏感字段脱敏，完整 payload 仅临时显示并受明确的本机确认流程控制 | 是 |
| SEC-004 | 已确认按单机单用户运行，不提供登录、RBAC、操作者身份区分或组织级数据范围；本机用户可调用所有已暴露功能 | 所有本地数据、推送、删除和导出 | 低（已接受边界） | `src/main/index.ts`、`src/preload/index.ts`、`docs/03-system-architecture.md` | 在产品边界、安装说明和数据保护策略中保持单机单用户表述；未来若改为共享/多用户再另立权限方案 | 否 |
| SEC-005 | safeStorage 只保证当前系统用户可解密，数据库备份本身可能包含密文配置和完整业务数据 | 备份、迁移和离线存储 | 中 | `src/main/settings.ts:198-220`、`README.md` | 明确备份加密、导出脱敏和密钥迁移策略；不要把数据库作为无保护交换文件 | 是 |
| SEC-006 | 外部模型 provider 地址和平台地址由设置保存，未见组织级域名白名单或代理策略 | 请求劫持、误发到非预期服务 | 中 | `src/main/settings.ts`、`src/main/model-client.ts` | 增加地址校验/白名单/HTTPS 约束，记录最终目标服务 | 是 |

## 4. 性能与可靠性风险

| 编号 | 问题描述 | 影响范围 | 严重程度 | 代码位置 | 建议方案 | 需业务确认 |
| --- | --- | --- | --- | --- | --- | --- |
| PERF-001 | SQLite、网络、embedding、OCR、模型和项目长任务都在主进程；同步 DatabaseSync 和大文件处理可能阻塞窗口 | 大数据同步、知识库、协议解析和 UI 响应 | 高 | `src/main/index.ts` 服务装配；`src/main/database.ts`；`src/main/knowledge.ts` | 将重任务移入 worker/子进程，提供取消、队列和资源上限 | 是，需要确认数据规模和响应目标 |
| PERF-002 | 向量检索在应用侧遍历候选并计算相似度，SQLite 是单文件；数据增长后耗时和内存线性上升 | 知识搜索、项目匹配、AI 问答 | 中 | `src/main/knowledge.ts:730-775`、`src/main/project-management.ts:990-1085` | 增加候选预过滤、向量索引/分片或专用检索引擎，并定义规模基准 | 是 |
| PERF-003 | PDF 预览通过 IPC 返回 `contentBase64`，虽然 handler 有 50 MB 限制，仍会产生大内存复制 | 知识库预览、项目协议预览 | 中 | `src/main/index.ts:627-642`、`src/shared/types.ts` | 使用临时文件/流式协议或分页预览，避免把大文件完整放入 IPC | 否 |
| PERF-004 | 附件以 Base64 文件和数据库元数据保存，推送/导出可能重复构造大 payload | 同步、资产中心、推送和备份 | 中 | `src/main/visslm.ts:460-505`、`src/main/database.ts` | 明确单附件/总附件上限，采用流式或内容引用，压测导出 | 是 |
| REL-001 | 长任务仅部分依赖状态字段和内存中的 running 集合；应用退出不会继续执行，也没有全局任务队列 | 同步、协议分析、匹配和索引 | 中 | `src/main/visslm.ts`、`src/main/project-management.ts`、`src/main/index.ts:892-902` | 持久化任务状态、启动恢复、取消和重试策略，避免重复执行 | 是 |
| REL-002 | 外部请求的重试、限流、幂等和断点续传没有形成统一策略；推送按记录逐条执行 | 同步/推送失败恢复和重复写入 | 中 | `src/main/visslm.ts:148-217,517-670` | 引入请求策略、幂等键、退避和可恢复批次；明确平台端幂等契约 | 是 |

## 5. 重复代码、过度耦合和可维护性

| 编号 | 问题描述 | 影响范围 | 严重程度 | 代码位置 | 建议方案 | 需业务确认 |
| --- | --- | --- | --- | --- | --- | --- |
| MAINT-001 | `AppDatabase` 同时承担 schema、迁移、DAO、领域查询、派生映射和导入导出 | 所有模块，修改容易引入跨模块回归 | 中 | `src/main/database.ts` | 按 data/knowledge/dashboard/project 等边界拆分 repository，保留事务和迁移入口 | 否 |
| MAINT-002 | `App.tsx` 和 `ProjectManagementPage.tsx` 承担大量导航、页面、表单、抽屉和业务状态 | 前端迭代、测试隔离和 UI 回归 | 中 | `src/renderer/src/App.tsx`、`src/renderer/src/project-management/ProjectManagementPage.tsx` | 按页面/领域拆分组件和 hooks，统一错误/加载状态 | 否 |
| MAINT-003 | 表格列宽、拖拽、键盘和缓存存在多套实现；项目管理部分仍有页面内自定义表格 | UI 一致性、可访问性和维护成本 | 中 | `src/renderer/src/App.tsx`、`src/renderer/src/project-management/ProjectManagementPage.tsx`、`src/renderer/src/styles.css`、`agents.md` | 提取统一 `ResizableTable` 适配层，缓存键含版本并覆盖所有业务列 | 否 |
| MAINT-004 | IPC 通道名、共享类型、handler 和页面调用没有代码生成或统一注册表 | 新增/重命名接口容易漏改 | 中 | `src/main/index.ts`、`src/preload/index.ts`、`src/shared/types.ts` | 建立契约清单或生成 preload/handler 类型，CI 做双向检查 | 否 |
| MAINT-005 | 错误语义和用户提示主要由中文字符串传递，难以稳定国际化、监控和自动化处理 | 所有错误处理 | 中 | `src/main/*.ts` 多处 `throw new Error`、`src/shared/types.ts` | 错误码、用户消息、诊断详情三层分离 | 否 |

## 6. 测试不足

| 编号 | 问题描述 | 影响范围 | 严重程度 | 代码位置 | 建议方案 | 需业务确认 |
| --- | --- | --- | --- | --- | --- | --- |
| TEST-001 | 未发现 Jest/Vitest/Playwright 配置，测试以 smoke/脚本为主，单元覆盖边界和异常不完整 | 数据库迁移、服务异常、UI 边界 | 中 | `package.json`、`scripts/` | 引入与代码规模匹配的单元/集成框架，至少覆盖 migration、契约和核心状态机 | 否 |
| TEST-002 | UI smoke 依赖外部已启动 Electron/CDP、窗口尺寸和本地数据状态，环境可重复性有限 | 页面回归和发布门禁 | 中 | `scripts/smoke-*.mjs`、`README.md` | 统一启动器、临时 userData、固定 fixture 和 CI artifacts | 否 |
| TEST-003 | 真实 VISSLM/在线模型链路需要外部服务和凭据，默认验证不能覆盖生产契约 | 同步、推送、模型调用 | 中 | `scripts/smoke-app.mjs`、`src/main/visslm.ts`、`src/main/model-client.ts` | 增加可控 mock server 和契约 fixture，再单独做受控联调 | 是 |
| TEST-004 | 没有在代码中发现对“当前协议唯一性、关联悬空、删除级联、应用退出恢复”等组合场景的统一回归 | 项目管理与数据生命周期 | 中 | `scripts/smoke-project-management.ts`、`src/main/database.ts` | 将风险表中的数据场景固化为测试 | 否 |

## 7. 硬编码、无效代码与废弃迹象

| 编号 | 问题描述 | 影响范围 | 严重程度 | 代码位置 | 建议方案 | 需业务确认 |
| --- | --- | --- | --- | --- | --- | --- |
| CODE-001 | 平台默认 URL、模型 URL、模型名、窗口尺寸、预览/批量上限等在代码中固定 | 不同环境部署和容量调整 | 中 | `src/main/settings.ts:17-18`、`src/main/index.ts:80-86`、`src/main/knowledge.ts` | 将环境相关值集中配置并记录版本；保留安全默认值 | 是 |
| CODE-002 | `projects:discard-draft`、字段语义保存接口可能是预留或残留实现 | 维护人员误以为功能完整 | 低 | `src/preload/index.ts:104-107,176`、`src/main/index.ts:269-273,731-733` | 增加调用、加入“预留”注释/文档，或清理 | 是 |
| CODE-003 | 根目录存在 `out/`、`release/`、`tmp/`、`$appData/` 等产物/运行目录；当前忽略规则未覆盖所有现存目录 | 误提交、敏感数据污染和仓库噪声 | 中 | 根目录文件清单、`.gitignore` | 确认目录用途，补充 `.gitignore` 或清理非源码产物；清理前先备份并确认 | 是 |

## 8. 配置与部署风险

| 编号 | 问题描述 | 影响范围 | 严重程度 | 代码位置 | 建议方案 | 需业务确认 |
| --- | --- | --- | --- | --- | --- | --- |
| CONFIG-001 | `sync.scope` 只接受版本 2，旧版本或损坏配置直接返回 null；没有迁移提示 | 升级后采集配置丢失/回退 | 中 | `src/main/settings.ts:163-194` | 为配置增加增量迁移、错误提示和备份恢复 | 否 |
| CONFIG-002 | embedding/OCR 资源在打包前下载，发布依赖外部源和固定 revision；镜像/离线构建流程未在代码中实现 | 构建可重复性和离线发布 | 中 | `scripts/prepare-local-resources.mjs`、`package.json:60-97` | 在受控制品库缓存并校验 hash，记录资源 SBOM 和许可证 | 是 |
| DEPLOY-001 | electron-builder 未配置 Windows 代码签名证书 | 安装信任、SmartScreen 和企业分发 | 中 | `package.json:60-97`、`README.md` | 接入签名证书、时间戳和发布验证 | 是 |
| DEPLOY-002 | `package.json` 未声明 Node/Electron/Windows 最低运行环境 | 安装前失败或 `node:sqlite` 不兼容 | 中 | `package.json`、`README.md` | 增加 engines/发布检查并锁定构建机版本 | 是 |
| DEPLOY-003 | 当前没有自动更新、回滚、集中日志或数据库升级编排 | 多版本客户端运维 | 低 | `package.json`、`src/main/index.ts` | 明确发布运维策略；若需要，补更新和迁移机制 | 是 |

## 9. 待确认业务问题

| 编号 | 待确认事项 | 相关实现依据 | 未确认的后果 |
| --- | --- | --- | --- |
| BA-001 | VISSLM 生产 API 的正式地址、HTTPS、认证、分页、错误 JSON 和幂等契约是什么？ | `src/main/visslm.ts` 只有客户端实现，仓库无平台接口规范 | 影响同步、推送、安全和兼容性 |
| BA-002 | 风险系数、交付提醒、成本、人力估算、需求状态的业务计算公式和审批规则是什么？ | 字段和服务校验已存在，但组织规则未在代码中完整表达 | 可能把技术默认值误当业务规则 |
| BA-003 | 在线模型可以接收哪些项目协议、记录字段和知识库内容？是否必须字段脱敏/审批？ | 协议上传有 `allowExternalProcessing`，普通 Agent 路径没有统一策略 | 可能造成合规或数据泄露 |
| BA-004 | 数据删除是否允许级联删除知识索引、匹配结果和项目资产关联？是否需要回收站？ | SQLite FK 和 `data:delete` 当前支持级联路径 | 决定数据恢复和用户确认流程 |
| BA-005 | 是否需要应用退出后的任务继续执行、任务取消、断点恢复、跨设备备份？ | 当前长任务在主进程内运行，退出时关闭 DB | 决定队列、持久化任务和备份架构 |
| BA-006 | 表格统一列宽、项目管理 UI 和匹配详情约束是否要作为发布门禁覆盖所有现有页面？ | 根目录 `agents.md` 已规定，但现有实现仍有多套表格 | 决定 UI 重构范围和验收成本 |

## 10. 代码依据索引

- `docs/03-system-architecture.md:14-16`：架构风险、性能和扩展性分析。
- `docs/05-database-design.md`：29 张业务表、FTS5、外键和字段语义。
- `docs/06-api-design.md:280-319`：IPC 缺口、契约和错误语义。
- `src/main/index.ts`：窗口安全选项、IPC handler、删除/导出/任务装配。
- `src/main/settings.ts`：默认配置、safeStorage、同步配置版本。
- `src/main/database.ts`：SQLite schema、迁移、级联、FTS 和业务读写。
- `src/main/visslm.ts`：平台 HTTP、附件、同步、推送和日志。
- `src/main/knowledge.ts`：解析、OCR、embedding、向量检索和资源限制。
- `src/main/model-client.ts`、`src/main/ollama.ts`：本地/在线模型和上下文外发。
- `src/main/project-management.ts`：协议、审核、发布、匹配、成本和计划规则。
- `src/preload/index.ts`、`src/shared/*.ts`：IPC 白名单及其类型契约。
- `src/renderer/src/App.tsx`、`src/renderer/src/project-management/ProjectManagementPage.tsx`：页面调用、表格和详情交互。
- `package.json`、`.gitignore`、`scripts/`、`README.md`：测试、构建、资源和发布风险。
- `agents.md`：当前工作台 UI 与提交前验收约束。
