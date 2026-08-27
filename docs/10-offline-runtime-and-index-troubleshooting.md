# Windows 离线运行库与资产中心索引排障说明

本文面向实施、发布和运维人员，适用于包含本次运行库与索引修复的 VISSLM Agent Windows x64 安装包。重点覆盖两类问题：

1. 安装包缺少本机原生运行依赖，导致应用启动或本地向量模型初始化失败。
2. 内网采集记录的属性 key 与外网不同，导致资产中心需求索引提取不到标题、类型、产品域、模块或描述。

截图中的 “A dynamic link library (DLL) initialization routine failed.” 是运行环境故障的证据，不是新的操作指令；应按本文的运行库路径排查。

## 一、交付后的行为

### 1. 安装包内置 VC++ 运行库

完整 NSIS 安装包会把以下文件带入安装资源目录：

```text
resources\installer\vc_redist.x64.exe
```

该文件是 Microsoft Visual C++ 2015–2022 Redistributable (x64)，固定文件版本为 `14.44.35211.0`。安装包构建阶段会校验官方来源、SHA-256 和 Microsoft Authenticode；目标机器安装时不需要访问互联网。

安装器检查注册表项：

```text
HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64
```

检查 `Installed`、`Major`、`Minor`、`Bld`、`Rbld`，接受不低于 `14.44.35211.0` 的版本。已安装更高版本时不会强制降级。

若运行库缺失或版本过旧，安装器会从安装包内执行：

```text
vc_redist.x64.exe /install /quiet /norestart
```

安装器接受成功、已安装较新版本和需要重启三类结果，并再次读取注册表确认安装确实完成。需要重启时会设置重启标记；安装后校验仍不通过，安装流程会中止并提示处理，不会让未满足依赖的程序继续安装完成。

### 2. 应用启动前的运行环境自检

在 Windows 上，应用启动阶段会检查：

- Windows 版本至少为 Windows 10；
- 系统架构为 x64；
- VC++ 2015–2022 x64 运行库注册信息和最低版本；
- `onnxruntime_binding.node`、`onnxruntime.dll`；
- `DirectML.dll`、`dxcompiler.dll`、`dxil.dll` 等随包原生组件；
- ONNX Runtime native binding 是否能够实际加载。

检查失败时会显示“VISSLM Agent 运行环境不完整”，并提示重新运行完整安装包进行离线修复，然后退出应用。这样可以在批量建立索引前暴露 DLL、架构或文件被隔离等问题。

本次自检不代替平台账号、API Token、网络连通性或业务配置检查，也不通过网络下载模型；这些问题仍应在数据采集、知识库或系统配置对应流程中排查。

## 二、现场安装流程

### 前置条件

- 使用 Windows 10 或更高版本的 x64 机器。
- 使用完整的 x64 NSIS 安装包，不要只复制 `app.asar`、解压目录或被裁剪过的安装包。
- 以能够安装系统运行库的管理员权限运行安装程序；如果安装器报告权限或运行库安装失败，请让管理员重新运行。
- 先退出正在运行的 VISSLM Agent。若上一次安装提示需要重启，先重启再启动应用。

### 安装与修复

1. 运行完整安装包，按向导选择安装目录。
2. 等待安装器完成“Microsoft Visual C++ 2015–2022 x64 运行库检查”。运行库已满足最低版本时会跳过安装；缺失或过旧时会自动使用内置包静默安装。
3. 若安装器提示重启，完成系统重启后再打开 VISSLM Agent。
4. 首次启动等待“运行环境不完整”检查结束。没有弹出错误框表示启动依赖自检通过；若仍弹出错误，按下一节根据具体项目处理。
5. 运行库修复成功后，再在资产中心对需要建立索引的范围执行“仅重建索引”。不要把上一次批任务中的逐条失败记录当作新的字段映射结果。

离线环境不需要为目标机器配置临时下载地址。发布包必须在交付前已包含 `resources\installer\vc_redist.x64.exe`；如果安装器提示“未找到内置的 Microsoft Visual C++ 2015-2022 x64 运行库安装包”，应重新获取完整安装包，而不是在目标机上手工下载 DLL。

## 三、运行库问题排查

### 1. 先按应用错误框分类

| 现象或诊断文字 | 主要判断 | 处理 |
| --- | --- | --- |
| Windows 旧版本不受支持 | 系统低于 Windows 10 | 升级到 Windows 10 或更高版本。 |
| 程序架构为 `ia32`、不是 x64 | 安装包或系统架构不匹配 | 使用 VISSLM Agent x64 安装包。 |
| VC++ 运行库缺失、版本过旧、注册信息无法读取 | VC++ 未安装、版本低于 `14.44.35211.0`，或注册表访问失败 | 重新运行完整安装包；必要时以管理员权限运行并重启。 |
| 未找到 `onnxruntime_binding.node` 或 `onnxruntime.dll` | 安装包资源不完整或文件被安全软件隔离 | 检查隔离记录，恢复后重新安装完整包。不要混用其他架构 DLL。 |
| 缺少 `DirectML.dll`、`dxcompiler.dll` 或 `dxil.dll` | ONNX Runtime 随包原生组件不完整 | 修复或重新安装完整包，并检查安全软件。 |
| `A dynamic link library (DLL) initialization routine failed.`、native binding 加载失败 | 常见于 VC++/原生 DLL 初始化失败、文件隔离或架构不匹配 | 先重跑完整安装包并重启；仍失败时检查下方注册表、原生文件和安全软件。 |

### 2. 管理员现场核验

将 `$installDir` 替换为实际安装目录。以下命令只读，不会修改系统：

```powershell
reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /reg:64
reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /reg:32
```

输出应包含 `Installed`、`Major`、`Minor`、`Bld`、`Rbld`，并且版本不低于 `14.44.35211.0`。应用自身会检查两个注册表视图；现场查询两个视图是为了区分注册表视图差异和真正缺失。

```powershell
$installDir = 'C:\Program Files\VISSLM Agent'
$onnxDir = Join-Path $installDir 'resources\app.asar.unpacked\node_modules\onnxruntime-node\bin\napi-v6\win32\x64'
'onnxruntime_binding.node','onnxruntime.dll','DirectML.dll','dxcompiler.dll','dxil.dll' |
  ForEach-Object {
    $path = Join-Path $onnxDir $_
    [PSCustomObject]@{ File = $path; Exists = Test-Path -LiteralPath $path }
  }
```

若文件存在但 native load 仍失败，重点检查：

- 安全软件是否隔离或锁定了 `.node`/`.dll` 文件；
- 安装目录中的文件是否来自同一个 x64 安装包；
- 修复后是否完成了要求的系统重启；
- 是否运行的是旧快捷方式指向的另一套安装目录。

不要从互联网或另一台机器单独复制 `vcruntime`、`msvcp`、ONNX 或 DirectML DLL 来“补文件”，这会造成版本和签名不可控；应使用完整安装包修复。

### 3. 发布包构建机检查

以下命令用于发布前验证，不是目标机器离线安装步骤：

```text
npm run prepare:runtime-dependencies
npm run verify:runtime-dependencies
npm run package
```
`prepare:runtime-dependencies` 只有在源码中的官方资源缺失或校验不通过时才需要联网从 Microsoft 官方地址准备资源；目标机器安装时使用已经随包交付的文件。`verify:runtime-dependencies` 会检查内置 VC++ 文件、元数据、SHA-256、ONNX Runtime 文件和 electron-builder 的 `extraResources`/NSIS 配置。在非 Windows 构建机上无法实际执行 Authenticode，正式 Windows 发布机仍应完成 Windows 签名校验。

## 四、内网属性 key 与资产中心索引

### 1. 当前索引不再只依赖外网 key

需求业务文本提取按记录的 `nodeType` 读取平台字段定义，把物理属性 key 映射到显示名，再按显示名解析业务字段。显示名匹配采用保守的精确匹配，并保留外网历史 alias 作为兼容路径；因此内网的物理 key 可以不同，只要对应字段定义已保存且显示名一致。

当前支持的业务显示名类别如下：

| 业务内容 | 可识别的显示名 |
| --- | --- |
| 标题 | `需求标题`、`需求名称`、`标题`、`主题`、`名称` |
| 需求类型 | `需求类型`、`问题类型`、`类型` |
| 产品域 | `产品域`、`产品领域`、`所属产品`、`产品` |
| 模块 | `业务模块`、`功能模块`、`需求模块`、`所属模块`、`模块` |
| 描述 | `需求描述`、`详细描述`、`描述`、`需求内容`、`内容`、`正文` |

外网历史字段（例如 `IssueType`、`_valm_ProductDomain`、`_valm_Module`、`_valm_Description`）仍被兼容。内网记录则优先通过当前 `nodeType` 的字段定义找到真实物理 key；另一个 nodeType 的字段定义不会串用。

### 2. 内网环境的正确处理顺序

1. 确认采集记录的 `nodeType`，并确认该类型的字段定义已经成功同步并保存在数据中心的字段目录中。
2. 在记录原始字段中确认内网物理 key 确实有值；在字段目录中确认同一个 `nodeType` 下该 key 的 `displayName` 是上述业务显示名之一。
3. 先让字段定义同步完成，再查看维护预览。字段定义变化会使业务语义源 hash 和向量源 hash 失效；这是为了防止旧向量继续被误认为当前向量。
4. 执行“仅重建索引”，等待向量阶段完成。字段定义变化不会凭空修复缺失的原始采集值，也不会把旧的 `normalizedText` 当作新的业务字段。
5. 用资产中心记录详情或匹配明细确认标题、类型、产品域、模块、描述已经进入匹配文本；富文本描述中的 HTML 标签不会作为原始标签参与索引。

如果字段定义目录中显示名正确、记录原始 key 也有值，但预览仍显示向量待建立，应执行重建索引；这是“索引未完成”而不是 key 写死。如果物理 key 有值但字段目录没有对应 display name，先修复字段定义同步或目录数据，再重建索引。

### 3. 如何区分字段映射问题和本机运行库问题

| 观察点 | 字段映射/数据问题 | 本机运行库问题 |
| --- | --- | --- |
| 应用启动 | 通常可以正常打开 | 启动前出现运行环境错误框，或 native binding 初始化失败 |
| 记录原始数据 | 内网 key 有值，但字段目录缺失/显示名不匹配 | 与 key 是否内网无关，重点是原生文件或注册库 |
| 匹配文本 | 缺少对应业务段落，或只剩记录名称 | 应用可能无法进入索引阶段；向量任务被前置终止 |
| 批任务表现 | 修复字段目录后预览显示待重建，重建可继续 | 一批记录一次性失败，通常不应再出现每条记录一条相同 DLL 错误 |
| 首要动作 | 核对 `nodeType`、物理 key、`displayName`，再重建索引 | 运行完整安装包修复 VC++/ONNX 组件，必要时重启 |

因此，截图中大量相同的 DLL 初始化错误应先按本机运行库问题处理；只有应用能正常启动且索引完成后仍缺少内网字段，才进入字段映射排查。

## 五、索引维护失败时的预期状态

对于“仅重建索引”和“优化”操作，系统会在逐条处理记录前先检查 embedding 运行时。若检查失败：

- 任务状态为 `failed`，而不是把同一个基础设施异常复制到每条记录；
- `current=0`、`succeeded=0`、`failed=0`，失败明细为空；
- 任务中的记录项保持 `pending`；
- 已存在的旧向量不被删除或覆盖；
- 修复运行库后可重新发起索引任务。

这意味着任务失败不等于原始资产丢失，也不等于旧向量已经被破坏。若故障发生在运行时检查通过之后的单条记录处理阶段，才可能出现 `completed_with_errors` 和具体失败记录；这应与“所有记录同一 DLL 错误”区分。

### 推荐恢复流程

1. 记录任务错误框中的完整诊断文字和安装目录。
2. 先完成 VC++/ONNX 运行库修复及必要重启。
3. 启动应用，确认不再出现运行环境错误框。
4. 若问题同时涉及内网字段，确认字段目录与 `nodeType` 映射，再查看维护预览。
5. 重新执行“仅重建索引”，完成后抽查内网记录的匹配文本和搜索结果。

不要在运行库仍未通过自检时反复点击“重试失败项”；基础设施故障应先修复一次，再重新建立索引。

## 六、离线交付注意事项

- 交付物必须是完整的 Windows x64 安装包，不能删掉 `resources\installer\vc_redist.x64.exe` 或 `app.asar.unpacked` 下的 ONNX 原生文件。
- 内网目标机不需要访问 Microsoft 下载地址；发布团队应在有网络的构建机准备并校验官方安装包，然后将其作为安装资源封装。
- 安全软件策略应允许安装器执行内置 `vc_redist.x64.exe`，并允许安装目录中的 `.node`/`.dll` 原生组件加载；如被隔离，先处理隔离记录再重装。
- 不要用 x86 安装包、其他应用目录的 DLL 或手工下载的运行库替换 x64 资源。
- 字段定义同步依赖当前平台配置和采集流程；VC++ 离线修复只能解决本机原生依赖，不能补造内网字段定义或记录属性值。
- 重建索引前建议按现场变更流程备份本地数据库和资源目录；索引修复应通过应用维护入口执行，不要直接删除 SQLite 向量表。

## 实现与验证依据

本说明对应以下已交付实现：

- `build/installer.nsh`：NSIS 安装阶段的 VC++ 注册表检查、离线静默安装和安装后复核。
- `src/main/runtime-dependencies.ts`：启动阶段 Windows、VC++、ONNX 文件和 native load 诊断。
- `scripts/prepare-runtime-dependencies.mjs`、`scripts/verify-runtime-dependencies.mjs`：发布资源准备与只读校验。
- `src/main/requirements/requirement-match-card.ts`：按字段显示名构建需求匹配原文，并兼容历史 alias。
- `src/main/database.ts`：按 `nodeType` 提供字段显示名，字段定义变化参与语义/向量源 hash。
- `src/main/record-maintenance.ts`、`src/main/knowledge.ts`：embedding 运行时前置检查和索引批任务的失败边界。

发布前至少执行：

```text
npm run typecheck
npm run verify:runtime-dependencies
npx tsx ./tests/runtime-dependencies.ts
npx tsx ./tests/requirement-field-mapping.ts
npm run test:record-maintenance
npm run package
```
