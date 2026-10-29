# 全字段图片处理验证

用户要求：图片处理不能仅覆盖 `_valm_Description`；其他返回字段含图片时同样采集、转换和传递。图片缺失不能阻止记录创建。

实现范围：

- 递归扫描原始字段、嵌套对象和数组中的富文本 `src` / `srcset`，以及独立图片路径、图片 Data URI。
- 每条记录的一次采集中按来源去重下载，按字段路径和出现位置保存引用，普通字段值保持不变。
- 重新采集时尝试补齐旧记录尚未转换的图片；更新记录只清理不再使用的引用，保留未返回字段中的图片。
- 资源包同步支持各字段中的图片；缺失图片按尽力保留记录的方式处理。推送继续沿用图片失败占位、记录照常创建的规则。

通过的专项与回归验证（退出码均为 0）：

```text
npx tsx tests/all-field-image-sync-regression.ts
npx tsx tests/all-field-image-pack-regression.ts
npx tsx tests/push-image-preflight-regression.ts
npx tsx tests/sync-failure-regression.ts
npm run smoke:image-collection
npm run smoke:itemid-dedup
npm run smoke:rich-push
npm run smoke:visslm-pack
npm run smoke:project-management
npm run test:record-maintenance
npm run typecheck
npm run build
```

全字段采集专项确认 9 处引用分别保存，重复来源仅下载一次，缺失图片保留记录；第二次采集保留未返回字段引用并清理已移除字段引用。资源包专项确认 4 个图片资源导出、导入后的字节一致，嵌套字段与独立令牌引用保留，旧版本非描述字段的原始图片地址仍可导入。

验收状态：`ACCEPTED_WITH_RISKS`。本地专项、回归和构建通过；未连接真实业务平台验证，未进行 Electron 手工视觉测试（本次未修改 UI）。旧记录需在更新后重新采集以获取缺少的图片，缺失的源图片无法凭空恢复。此变更已打包为本地 v1.5.3 安装包，包内版本、代码一致性、模型校验和隔离启动检查通过，尚未上传在线更新渠道。
