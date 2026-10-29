# 推送用户映射与固定参数

入口：数据推送 → 推送配置 → 数据新建参数，下方的「用户登录名映射」和「额外固定参数」。若导航未开启数据推送，可在系统配置中启用该功能。

## 用户映射

1. 先配置字段名映射，例如 `RAO → Devs`。
2. 在「需要转换的目标字段 Key」选择或输入 `Devs`，支持多个字段。
3. 添加多组源平台登录名与内网登录名/能力名，例如 `alice.ext → alice.internal`、`bob.ext → bob.internal`。
4. 选择待推送记录，点击「测试预览」，在请求日志中展开请求检查最终消息体。

用户映射只作用于指定的目标字段，按完整登录名精确匹配、区分大小写，不会替换描述等其他文本中的同名内容。字段 Key 中的点号属于完整属性名，不表示嵌套路径。支持单个登录名、登录名数组，以及英文/中文逗号、分号或换行分隔的多用户文本。对象形式的用户值需要先确认结构，当前会提示错误。

例如源数据 `RAO: "alice.ext;bob.ext"` 在推送时变为 `Devs: "alice.internal;bob.internal"`，本地源数据不变。空值和记录中缺失的字段不做转换。

未匹配用户默认阻止整批推送，提示记录、字段和缺失的登录名；整个批次完成映射检查后才开始发送。可显式选择「保留原值继续推送」。空白映射、重复源登录名和未指定转换字段都会报错。

## 固定参数

每条待推送记录均应用相同的固定参数：

| 位置 | 参数 Key | 值类型 | 固定值 | 效果 |
| --- | --- | --- | --- | --- |
| 请求体 | Source | 文本 | 内网导入 | 写入字符串 |
| 请求体 | Priority | JSON | 3 | 写入数字 |
| 请求体 | Enabled | JSON | true | 写入布尔值 |
| URL 参数 | workflow | 文本 | internal | 添加查询参数 |

请求体支持文本或 JSON（数字、布尔值、数组、对象、null，也可为 JSON 字符串）。文本保留原样，允许空字符串；URL 参数只支持文本，由请求客户端统一编码。

请求体固定值覆盖同名映射字段，作为最终值不再做用户映射。固定参数不能写入 `_valm_Uid`、`_valm_NodeType`、`_valm_ItemID`，不能覆盖 URL 中的认证参数或节点/项目/位置参数。同一位置不能重复配置相同 Key。

## 保存与验证

两组配置与既有推送草稿一起保存在当前设备的应用配置中，切换页面或重启后恢复；不会写回源记录。新增表格沿用统一可调整列，支持拖拽、左右方向键和宽度恢复。

预览和实际推送共用同一转换逻辑，预览不发送请求。实际推送还会按既有逻辑处理富文本图片，因此图片 URL 可能在上传后变化。

验证命令：

```powershell
npm run typecheck
npx tsx tests/push-value-transforms-regression.ts
npx tsx tests/push-config-draft-regression.ts
npx tsx tests/push-image-preflight-regression.ts
npm run smoke:rich-push
npm run smoke:project-management
npx electron-vite build
node scripts/smoke-push-values-ui.mjs
```

UI smoke 使用临时独立配置和测试数据，仅调用推送预览，覆盖配置编辑/刷新恢复、列宽拖拽/键盘/恢复、深浅主题及桌面窗口尺寸；截图与检查结果保存在 `artifacts/push-values-ui/`。
