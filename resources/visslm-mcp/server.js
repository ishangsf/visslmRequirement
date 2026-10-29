#!/usr/bin/env node
'use strict';
/* VISSLM MCP Server（零依赖，stdio 传输，MCP 2025-06-18 协议）
 *
 * 环境变量：
 *   VISSLM_BASE_URL    服务地址，默认 http://localhost:8888/alm
 *   VISSLM_USERNAME    登录用户名（可选）
 *   VISSLM_PASSWORD    登录密码（可选）
 *   VISSLM_SESSION     会话文件路径（可选，默认 .visslm-session.json）
 */
const readline = require('readline');
const { VisslmClient } = require('./lib/client');
const { schemas, makeHandlers } = require('./lib/tools');

const SERVER_INFO = { name: 'visslm-mcp', version: '1.0.0' };
const PROTOCOL_VERSION = '2025-06-18';

const client = new VisslmClient({
  sessionFile: process.env.VISSLM_SESSION || undefined,
});
const handlers = makeHandlers(client);

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function rpcResult(id, result) { write({ jsonrpc: '2.0', id, result }); }
function rpcError(id, code, message, data) {
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' && /^20\d\d-/.test(params.protocolVersion)
          ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          logging: {},
        },
        serverInfo: SERVER_INFO,
        instructions:
          'VISSLM (VisionALM) 服务器的 MCP 网关。先 visslm_login（或预置环境变量凭据）建立会话，' +
          '用 visslm_list_modules / visslm_search_api / visslm_get_endpoint 检索 4258 个接口，' +
          '再用 visslm_call_api / visslm_download / visslm_upload 操作业务数据。' +
          '响应遵循 {ErrorCode,ErrorMsg,Data} / {code,msg,data} 封装。',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: schemas };
    case 'tools/call': {
      const name = params.name;
      const args = params.arguments || {};
      const h = handlers[name];
      if (!h) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
      try {
        return await h(args);
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(e.message || e) }) }], isError: true };
      }
    }
    case 'resources/list':
      return { resources: [] };
    case 'prompts/list':
      return { prompts: [] };
    case 'logging/setLevel':
      return {};
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
  }
}

let inFlight = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && inFlight === 0) process.exit(0);
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  inFlight += 1;
  try {
    if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method === 'notifications/roots/list_changed') return;
    const result = await dispatch(method, params || {});
    if (!isNotification) rpcResult(id, result);
  } catch (e) {
    if (isNotification) return;
    rpcError(id, e.rpcCode || -32603, e.message, e.data);
  } finally {
    inFlight -= 1;
    maybeExit();
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch (_) {
      rpcError(null, -32700, 'Parse error'); return;
    }
    if (Array.isArray(msg)) { msg.forEach(handleMessage); return; } // batch
    handleMessage(msg);
  });
  rl.on('close', () => { stdinClosed = true; maybeExit(); });
  process.on('SIGINT', () => process.exit(0));
  process.stderr.write(`[visslm-mcp] ready: baseUrl=${client.baseUrl}\n`);
}

main();
