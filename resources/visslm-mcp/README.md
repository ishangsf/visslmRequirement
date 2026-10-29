# VISSLM MCP Server

把 VISSLM（VisionALM，`alm.war`，Spring MVC，`http://<server>:8888/alm`）的 **4258 个 HTTP 接口** 接入 MCP（Model Context Protocol），供 AI 客户端（ZCode / Claude Desktop / Cursor 等）直接检索与调用。

- **零依赖**：纯 Node.js（≥18）实现 MCP stdio 协议，无需 `npm install`、无需编译。
- **内置 API 目录**：`data/api.json` 来自对 `alm.war` 全部 237 个 Controller 的字节码反编译提取，并与前端 `static/app` 源码 1903 处调用做了交叉验证（详见 [../../docs/API.md](../../docs/API.md)）。
- **自动登录**：内置前端同款加密规则（见下），支持凭据环境变量、会话持久化、会话过期自动重登录。

## 目录结构

```
visslm-mcp/
├── server.js          # MCP stdio 入口（JSON-RPC 2.0，MCP 2025-06-18）
├── lib/
│   ├── catalog.js     # API 目录检索（模块/控制器/端点/搜索）
│   ├── client.js      # VISSLM HTTP 客户端（登录加密、Cookie 会话、调用/上传/下载）
│   └── tools.js       # 11 个 MCP 工具定义与实现
├── data/api.json      # 4258 个端点的机器可读目录
├── test/
│   ├── mock-server.js # 模拟 VISSLM（校验登录加密、会话、三种响应封装）
│   └── e2e.js         # 端到端集成测试（13 项，全部通过）
└── package.json
```

## 配置

### ZCode / Claude Desktop / Cursor 等通用 MCP 客户端

项目根目录已提供 [.mcp.json](../../.mcp.json)，也可复制以下内容到客户端的 MCP 配置：

```json
{
  "mcpServers": {
    "visslm": {
      "command": "node",
      "args": ["D:/Ai/visslmcode38/visslm/mcp/visslm-mcp/server.js"],
      "env": {
        "VISSLM_BASE_URL": "http://localhost:8888/alm",
        "VISSLM_USERNAME": "your_name",
        "VISSLM_PASSWORD": "your_password"
      }
    }
  }
}
```

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `VISSLM_BASE_URL` | VISSLM 服务地址（`/alm` 结尾，或自动补齐） | `http://localhost:8888/alm` |
| `VISSLM_USERNAME` | 登录用户名（可选；也可运行时用 `visslm_login` 工具传入） | 空 |
| `VISSLM_PASSWORD` | 登录密码明文（传输时按前端同款规则加密，不落盘明文以外位置） | 空 |
| `VISSLM_SESSION` | 会话文件路径 | MCP 目录下 `.visslm-session.json` |

会话（`JSESSIONID`）持久化在会话文件中，MCP 重启后无需重新登录；服务端会话过期时若配置了凭据则自动重登录。

## 工具清单（11 个）

| 工具 | 说明 |
| --- | --- |
| `visslm_status` | 查看服务地址、登录状态、当前用户、目录规模 |
| `visslm_login` | 登录（参数或环境变量提供凭据），建立会话 |
| `visslm_logout` | 调用 `/alm/Account/LogOff` 并清除本地会话 |
| `visslm_list_modules` | 列出 12 个功能模块（ALM核心/SSF/DevOps/资产/报表/开放REST…） |
| `visslm_list_controllers` | 列出模块下全部 Controller（路由前缀、端点数） |
| `visslm_list_endpoints` | 列出某 Controller 的端点（方法/路径/参数/返回），支持关键字过滤 |
| `visslm_search_api` | 全目录关键字搜索端点 |
| `visslm_get_endpoint` | 按路径查看端点完整定义（参数表、返回封装） |
| `visslm_call_api` | 调用任意接口（自动带会话、过期自动重登录；query/body 参数；大响应截断或存文件） |
| `visslm_download` | 下载文件类接口（导出 Excel/Word、附件）到本地 |
| `visslm_upload` | multipart 上传本地文件（富文本图片、附件等） |

典型工作流：`visslm_status` → `visslm_login` → `visslm_search_api`/`visslm_get_endpoint` 找接口 → `visslm_call_api` 执行。

## 认证与响应约定（逆向自前端源码，mock 测试已验证）

- **登录**：`POST /alm/User/UPLogOn`，表单字段：
  - `uname` = `6位随机hex + base64(encodeURI(用户名))去'=' + 6位随机hex(大写)`
  - `upassword` = `* + MD5(UPPER(用户名) + ":VISSLM:" + UPPER(MD5(密码明文)))`
  - `rememberPwd` = `false`
- **会话**：Redis Session，客户端持 `JSESSIONID` Cookie；`GET /alm/User/GetNickname` 可保活/探测。
- **响应封装**（三种，`visslm_call_api` 结果中标注 `envelope`）：
  - `ResultHelper`：`{ErrorCode:int(0=成功), ErrorMsg, Data}` —— ALM 核心业务
  - `JsonResult`：`{code:string, msg, data}` —— SSF/DevOps 部分 REST
  - `ReturnT`：`{code:int(200=成功), msg, data}` —— 资产管理

## 离线安装

MCP 运行**不需要联网**：纯 Node 内置模块（`fs`/`crypto`/`fetch`/`readline`），无任何 npm 包，`data/api.json` 目录内置。部署包 `visslmcode38` 已自带 Node 安装程序，离线机器上：

1. **拷贝目录**：把 `visslm\mcp\visslm-mcp\` 整个目录拷到目标机（纯文件复制，无构建步骤）。
2. **安装 Node**：双击部署包内 `node-v22.22.3-x64.msi`（已有 Node ≥ 18 可跳过），验证 `node --version`。
3. **注册 MCP**：按上文「配置」一节，把 `.mcp.json`（或对应客户端配置文件）中 `args` 的 `server.js` 路径改为目标机上的绝对路径，`VISSLM_BASE_URL` 指向目标机能访问的 VISSLM 地址（默认 `http://localhost:8888/alm`，即 Tomcat 与 MCP 同机）。
4. **离线自检**（可选，全程不联网）：
   ```bash
   node --check <路径>/server.js        # 语法自检
   node <路径>/test/mock-server.js 18888   # 终端1：内置模拟服务
   node <路径>/test/e2e.js              # 终端2：13 项断言应全部 PASS
   ```
5. 重启 MCP 客户端（如 ZCode Desktop），调用 `visslm_status` 确认连通。

注意：`VISSLM_USERNAME/PASSWORD` 也可以不预置，运行时在对话里通过 `visslm_login` 工具传入。

## 本地测试（无需真实服务器）

```bash
node test/mock-server.js 18888   # 终端1：模拟 VISSLM
node test/e2e.js                 # 终端2：13 项端到端断言
```

覆盖：MCP 握手/工具清单、登录加密规则校验、会话持久化、未登录自动重登录、GET/POST 调用、下载、上传、错误凭据提示、搜索、端点详情、登出。

## 连接真实 VISSLM

1. 按 `部署说明.docx` 启动 Tomcat + `alm.war`（依赖远程数据库/Redis）。
2. 修改 `.mcp.json` 中 `VISSLM_BASE_URL` 为实际地址，填入用户名/密码（或留空，运行时用 `visslm_login` 传入）。
3. 重启 MCP 客户端，调用 `visslm_status` 确认 `sessionValid: "有效"`。
