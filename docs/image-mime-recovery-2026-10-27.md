# 导出缺图提示：PNG 被误标为 JPEG

## 实际证据

2026-10-27 只读检查当前安装应用的数据库：27 条记录、2 个二进制资源、5 条图片记录，其中 2 条 ready、3 条 unresolved，与截图数量一致。当前安装包版本为 1.5.2。

| 记录 | UID | 图片数 | 下载响应字节数 |
| --- | --- | --- | --- |
| PDF表单导出卡死 | 185602 | 2 | 24,047,465；26,740,663 |
| 定制字段显示问题 | 182894 | 1 | 25,844,006 |

三条失败记录的诊断均为 HTTP 200、Content-Type image/jpeg，前 16 字节为 `89504e470d0a1a0a0000000d49484452`（PNG 签名及 IHDR）。旧下载逻辑只按响应 MIME 校验，因此 PNG 响应在 JPEG 分支被拒绝，未保存到本地资源目录。导出随后跳过这些 unresolved 记录，使用了不准确的“无法恢复”提示。

这与之前 JPEG EOI 后尾随字节的问题不同；全字段图片采集调整也未改变这一校验分支。日志可确认格式不匹配，尚不能凭文件头确认真实源文件的完整性。

## 修改

- 对 PNG、JPEG、GIF、WebP、BMP 根据实际字节识别格式，再执行现有结构校验，以识别结果保存 MIME；不修改原始字节。
- 下载与内嵌图片使用相同的识别流程；仍拒绝截断图片、伪装的 HTML 和非成功 HTTP 响应。
- 导出缺图提示改为“本地尚无可用图片文件，请重新采集后再导出”，不再断言不可恢复。

## 验证

以下检查全部通过：

```text
npx tsx tests/image-mime-recovery-regression.ts
npm run typecheck
npm run smoke:image-collection
npm run smoke:visslm-pack
npm run smoke:data-export-filter
npm run smoke:project-management
npx tsx tests/all-field-image-sync-regression.ts
npx tsx tests/all-field-image-pack-regression.ts
```

专项验证涵盖：PNG 被标为 JPEG、通用二进制 MIME、JPEG 被标为 PNG、内嵌图片误标、无效图片重试、403 不重试、原记录修改时间不变时重新采集补图、旧失败标记清除、去重、资源包导出与导入后的 MIME 和字节一致。

本次修复已打包为本地 v1.5.4 安装包：`release/VISSLM-Agent-Setup-1.5.4.exe`。包内代码一致性、模型校验和隔离启动检查通过，详见 [v1.5.4 发布说明](release-v1.5.4.md)。未执行安装或修改用户业务数据库。真实三张图片需要安装包含此修复的版本后重新采集，再导出验证。
