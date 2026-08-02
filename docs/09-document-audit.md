# 09 文档交叉审计报告

> 最后分析时间：2026-08-01（Asia/Singapore）  
> 代码基线：Git `9bab57fc5166770784c1855857a6e1a8ebaa6200`；分析对象为当前工作树，工作树含未提交改动。  
> 审计范围：`docs/00-project-scan.md` 至 `docs/09-document-audit.md`、根目录 `AI_CONTEXT.md`，以及当前 `src/`、`scripts/`、配置和部署文件。  
> 审计原则：以实际调用、类型、SQL、配置和脚本为证据；静态未能证明的内容标记为“待确认”或“可能未使用”。

## 1. 审计方法和范围

本次交叉审计执行了以下检查：

- 扫描 `src/`、`scripts/`、`buildResources/`、根目录配置和现有 README。
- 对比 `src/renderer/src` 页面调用、`src/preload/index.ts` 白名单、`src/main/index.ts` handler、`src/shared/*.ts` 类型和 `src/main/database.ts` 表/读写方法。
- 对照 `docs/01-code-mapping.md`、`docs/02-requirements.md`、`docs/04-module-design.md`、`docs/05-database-design.md`、`docs/06-api-design.md` 的编号和结论。
- 检查新文档是否有分析时间、Git 版本、代码依据索引和不确定性标记。
- 执行 TypeScript、构建、项目管理领域 smoke、知识库 smoke，以及占位符和编号重复的静态检查。

本轮在保留工作树其他未提交修改的前提下，新增了项目 Excel 导出业务代码、IPC API、页面按钮和导出 smoke；审计和文档结论按当前工作树读取，未进行回滚。

## 2. 最终检查结果

| 序号 | 检查项 | 结果 | 证据/结论 |
| --- | --- | --- | --- |
| 1 | 是否存在页面没有对应需求 | 已检查，未发现主页面遗漏 | `App.tsx` 的 `dashboard/visualization/projects/data/chat/sync/push/settings` 在 `docs/02`、`docs/04` 有功能和模块说明；页面级细节仍需 UI smoke 复核 |
| 2 | 是否存在接口没有对应模块 | 已检查，未发现未归属的公开 IPC | `docs/06` 按配置、数据、同步、AI、分析、Dashboard、知识库、项目、组织、推送分组；项目 Excel 导出归入项目管理；内部 `listSyncRuns()` 和两个可能未使用接口单列 |
| 3 | 是否存在数据表没有说明 | 已检查，未发现 schema 表遗漏 | `docs/05` 覆盖 29 张业务表及 `records_fts`；schema 依据 `src/main/database.ts:452-1037`，表读写索引在文档末尾 |
| 4 | 是否存在权限标识没有说明 | 已检查，当前没有实际权限标识；已确认不建设 RBAC | `docs/00`、`docs/03`、`docs/04`、`AI_CONTEXT.md` 明确单机单用户边界；`feature.<module>` 被解释为导航开关而非权限 |
| 5 | 是否存在状态值没有定义 | 基本覆盖，开放值仍需确认 | `docs/02`、`docs/04`、`docs/05` 已整理同步、知识库、项目、需求、匹配、任务、推送等状态；外部 VISSLM 返回状态和未来新增值不受本地枚举完全约束 |
| 6 | 是否存在配置项没有解释 | 已检查，未发现主要配置遗漏 | `docs/00`、`docs/07`、`AI_CONTEXT.md` 覆盖 settings key、sync scope、feature/navigation、环境变量、资源配置；业务部署域名和 HTTPS 策略待确认 |
| 7 | 是否存在第三方服务没有说明 | 已检查，未发现已使用服务遗漏 | VISSLM、Ollama、OpenAI-compatible、Anthropic、Hugging Face、Tesseract、Electron safeStorage 均在 `docs/00`、`docs/03`、`docs/07`、`docs/08` 说明；具体生产合同不在仓库 |
| 8 | 是否存在前端调用但后端没有实现 | 静态检查未确认此类问题 | `docs/06` 对 `window.visslm`、preload 和 handler 做了交叉检查；动态字符串和构建后产物未单独证明，保留 API-GAP-004 |
| 9 | 是否存在后端接口但前端没有使用 | 已发现并单列 | `projects:discard-draft`、`analytics:field-profile-semantics` 可能未使用；`listSyncRuns()` 仅 DB 内部，见 `docs/06:280-293`、`docs/08` |
| 10 | 是否存在文档结论缺少代码依据 | 主要结论已附依据；少量推断已标记 | 各文档末尾有代码依据索引；`推测`、`待确认`、`可能未使用` 用于区分间接结论，动态运行行为仍需补充测试 |
| 11 | 是否存在不同文档之间描述冲突 | 未发现实质冲突 | 00-08 均以 Electron + SQLite + IPC 架构为基线；风险在 03/06/08/09 交叉引用而不是互相覆盖；统一使用同一 Git commit |
| 12 | 是否遗漏测试、部署和异常处理 | 已覆盖，仍有明确测试缺口 | `docs/07` 记录本地启动、构建、打包、领域/UI smoke、外部服务依赖和常见错误；缺少标准单元测试、CI 和已启动 CDP 的 UI 实测，见 `docs/08` |

## 3. 编号和元数据检查

- `FR-*` 功能需求编号位于 `docs/02-requirements.md`，按模块前缀区分。
- `BR-*` 业务规则编号位于 `docs/02-requirements.md`，需求/模块/推送等规则保持前缀区分。
- `API-*` 接口编号和 `API-GAP-*` 缺口编号位于 `docs/06-api-design.md`。
- `M-*` 模块编号位于 `docs/00`、`docs/02`、`docs/04`。
- `DB-RISK-*` 数据库风险编号位于 `docs/05-database-design.md`；审计/技术债编号位于 `docs/08`。
- 对文档表格中的编号进行了重复检查，未发现同一编号被重复定义。
- `docs/00-09` 和 `AI_CONTEXT.md` 均包含最后分析时间和 Git commit；`docs/01-06` 的版本表述已统一为当前基线。
- 未发现旧版 API 行号占位符、待补标记或其他未完成标记。

## 4. 已执行验证

| 命令 | 结果 | 关键输出/说明 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | `tsc --noEmit` 退出码 0 |
| `npm run build` | 通过 | main/preload/renderer 均构建成功；生成 `out/main/index.js`、`out/preload/index.cjs` 和 renderer 资源 |
| `npm run smoke:project-management` | 通过 | `ok: true`；领域 smoke 返回 `requirementCount=1`、`topMatch=95` |
| `npm run smoke:project-export` | 通过 | 实际生成并重新读取 `.xlsx`；检查 9 个工作表和项目名称关键字段 |
| `npm run knowledge:smoke` | 通过 | 最终输出 `knowledge smoke passed`、退出码 0；过程中有 PDF `standardFontDataUrl` warning，需要后续决定是否消除 |
| 文档占位符扫描 | 通过 | 未发现未完成标记或旧 API 行号占位引用 |
| 文档编号重复扫描 | 通过 | 未发现重复定义编号 |
| `smoke:project-management-ui` | 未执行 | 需要先启动带 CDP 端口的 Electron；本轮已通过 typecheck/build/领域及 Excel 导出 smoke，未启动 CDP UI |
| `npm run package`/真实外部联调 | 未执行 | 会下载资源、生成安装包或访问外部平台/模型，需要发布环境和测试租户确认 |

## 5. 文档结论中的剩余缺口

以下内容不能仅由当前仓库确认，不能作为确定需求交给后续实现：

1. VISSLM 生产接口的正式 HTTPS、认证、分页、错误、限流、幂等和版本契约。
2. 在线模型可接收的数据范围、字段脱敏、审批和保留期限。
3. 项目风险、成本、工期、需求状态和匹配阈值的业务公式与审批规则。
4. 数据删除的回收站/恢复要求，以及知识库/图片/匹配结果的级联保留策略。
5. 长任务在退出、休眠、断网后的恢复、取消、断点续传和重试要求。
6. 数据库 schema version、发布签名、自动更新、CI、分支和提交规范。
7. `projects:discard-draft`、`analytics:field-profile-semantics` 是否为待开发 UI 还是应删除的预留 API。

详细问题编号见 `docs/08-known-issues.md` 的 `BA-*`、`API-*`、`DATA-*`、`SEC-*` 和 `DEPLOY-*`。

## 6. 维护要求

后续代码变更后，至少更新受影响的代码映射、需求、模块、数据库、API 和风险文档；不要直接把本审计报告当成永久事实。建议在 CI 中加入：

- preload/handler/renderer 的 IPC 双向契约检查；
- schema migration 和旧数据库升级 smoke；
- API、状态枚举、配置 key 和表清单的静态一致性检查；
- 无真实凭据/数据库/模型资源进入提交的扫描；
- 项目管理与关键 UI smoke 的固定 userData/fixture 启动器。

## 7. 代码依据索引

- `src/main/index.ts:80-119,122-846,848-902`：窗口安全选项、IPC handler、导出、删除和服务生命周期。
- `src/preload/index.ts:54-245`：renderer API 白名单和事件订阅。
- `src/main/database.ts:452-1037,1578-3538,3540-4525,4936-5200`：schema、项目/知识/分析/日志读写、同步和导入导出。
- `src/main/settings.ts:17-220`：配置、safeStorage、功能开关和同步配置。
- `src/main/visslm.ts:148-877`：平台 HTTP、同步、附件和推送。
- `src/main/knowledge.ts:1-984`：解析、OCR、embedding、索引和向量检索。
- `src/main/project-management.ts:99-1198`：协议解析、需求审核/发布、匹配、成本、参与人和计划。
- `src/main/project-export.ts`：项目快照到 Excel 工作簿的字段映射和工作表定义。
- `src/main/model-client.ts`、`src/main/ollama.ts`：模型服务和 Agent 上下文。
- `src/renderer/src/App.tsx`、`src/renderer/src/dashboard/`、`src/renderer/src/project-management/`：页面入口和主要调用。
- `src/shared/types.ts`、`src/shared/project-types.ts`、`src/shared/query-spec.ts`、`src/shared/dashboard.ts`：共享契约和状态。
- `scripts/smoke-project-export.ts`：Excel 导出回读验证。
- `package.json`、`electron.vite.config.ts`、`README.md`、`scripts/`：依赖、构建、部署和测试。
- `agents.md`：后续开发的主题、表格、浮层、响应式和提交前验收约束。
