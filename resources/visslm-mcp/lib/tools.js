'use strict';
/* MCP 工具定义与实现 */
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');

const TRUNCATE_DEFAULT = 16000;   // 响应超过则截断（保护上下文）
const TRUNCATE_MAX = 400000;

function j(x) { return JSON.stringify(x, null, 1); }

function text(s) { return { content: [{ type: 'text', text: String(s) }] }; }
function errText(msg, extra) {
  const t = { error: String(msg && msg.message || msg), ...(extra || {}) };
  return { content: [{ type: 'text', text: j(t) }], isError: true };
}

/** 概括三种响应封装，返回紧凑对象 */
function summarizeEnvelope(json) {
  if (json === null || typeof json !== 'object') return null;
  if (typeof json.ErrorCode === 'number') {
    return { envelope: 'ResultHelper', success: json.ErrorCode === 0, ErrorCode: json.ErrorCode, ErrorMsg: json.ErrorMsg };
  }
  if ('code' in json && ('msg' in json || 'data' in json)) {
    const numeric = typeof json.code === 'number' || /^\d+$/.test(String(json.code));
    return { envelope: numeric ? 'ReturnT' : 'JsonResult', success: numeric ? Number(json.code) === 200 || Number(json.code) === 0 : true, code: json.code, msg: json.msg };
  }
  return null;
}

function truncateText(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[截断，共 ${s.length} 字符，可用 full:true 或保存到文件查看全部]`;
}

function paramLine(p) {
  const where = p.in && p.in !== 'query' ? `(${p.in})` : '';
  const req = p.required === false ? '?' : '';
  const dflt = p.default != null ? `=${p.default}` : '';
  return `${p.name}${req}${where}:${p.type}${dflt}`;
}

function endpointBrief(e) {
  const ps = (e.params || []).map(paramLine).join('; ') || '—';
  return `${(e.http || 'ANY').padEnd(12)} ${e.path}   [${ps}] -> ${e.returns || ''}`;
}

// ---------------- tool schemas ----------------
const schemas = [
  {
    name: 'visslm_status',
    title: '查看连接状态',
    description: '查看 VISSLM 服务地址、登录状态、当前用户、会话文件位置。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'visslm_login',
    title: '登录 VISSLM',
    description: '登录 VISSLM 服务，获取会话 Cookie（JSESSIONID）。凭据可用参数或环境变量 VISSLM_USERNAME/VISSLM_PASSWORD 提供。调用任何业务接口前若未登录会自动尝试用已保存凭据登录。',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: '用户名（可选，默认取环境变量）' },
        password: { type: 'string', description: '密码明文（可选，默认取环境变量；传输时按前端同款 MD5 规则加密）' },
      },
    },
  },
  {
    name: 'visslm_logout',
    title: '退出登录',
    description: '调用 /alm/Account/LogOff 并清除本地会话。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'visslm_list_modules',
    title: '列出功能模块',
    description: '列出 VISSLM API 的功能模块（平台通用/ALM核心/SSF/DevOps/资产/报表/开放REST服务等）及其 Controller 数、端点数。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'visslm_list_controllers',
    title: '列出控制器',
    description: '列出指定模块（或不限模块）下的全部 Controller，含路由前缀与端点数。',
    inputSchema: {
      type: 'object',
      properties: { module: { type: 'string', description: '模块名，来自 visslm_list_modules；缺省列出全部' } },
    },
  },
  {
    name: 'visslm_list_endpoints',
    title: '列出控制器端点',
    description: '列出某个 Controller 的全部端点（HTTP 方法、路径、参数、返回），可按关键字过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        controller: { type: 'string', description: 'Controller 名称（如 MainData、Admin、User），带不带 Controller 后缀均可' },
        keyword: { type: 'string', description: '可选，过滤 action/路径关键字' },
      },
      required: ['controller'],
    },
  },
  {
    name: 'visslm_search_api',
    title: '搜索接口',
    description: '在全部 4258 个端点中按关键字搜索（匹配路径/action/控制器名/模块名），返回端点清单。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键字，如 Baseline、GetDocList、devops' },
        limit: { type: 'number', description: '返回条数上限，默认 50' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'visslm_get_endpoint',
    title: '查看接口详情',
    description: '按路径查看一个端点的完整定义（参数表、类型、返回封装）。路径如 /alm/MainData/GetDocList 或 MainData/GetDocList。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '接口路径' } },
      required: ['path'],
    },
  },
  {
    name: 'visslm_call_api',
    title: '调用接口',
    description: '调用任意 VISSLM HTTP 接口（自动携带会话 Cookie，会话过期自动重登录）。query 为查询参数对象；body 为表单/JSON 请求体对象；默认响应超过 16KB 截断，full:true 取 400KB，saveTo 可存文件。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '接口路径，如 /alm/MainData/GetDocList 或 MainData/GetDocList' },
        method: { type: 'string', description: 'HTTP 方法，默认 GET' },
        query: { type: 'object', description: 'URL 查询参数 {name:value}' },
        body: { type: 'object', description: '请求体；默认以表单提交，若 Content-Type 指定 application/json 则以 JSON 提交' },
        headers: { type: 'object', description: '附加请求头' },
        full: { type: 'boolean', description: '返回更大数据量（默认 false）' },
        saveTo: { type: 'string', description: '将完整响应体保存到该文件路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'visslm_download',
    title: '下载文件',
    description: '下载 VISSLM 的文件类接口（导出 Excel/Word/附件下载等）到本地文件，返回保存路径与大小。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '下载接口路径' },
        saveTo: { type: 'string', description: '保存到的本地文件路径' },
        query: { type: 'object', description: 'URL 查询参数' },
      },
      required: ['path', 'saveTo'],
    },
  },
  {
    name: 'visslm_upload',
    title: '上传文件',
    description: '以 multipart/form-data 上传本地文件到 VISSLM 上传接口（如 FileCenterImg/UploadRichImg、附件上传等）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '上传接口路径' },
        filePath: { type: 'string', description: '本地文件路径' },
        field: { type: 'string', description: '文件字段名，默认 file' },
        fields: { type: 'object', description: '附加表单字段，如 {proId:"1"}' },
        query: { type: 'object', description: 'URL 查询参数' },
      },
      required: ['path', 'filePath'],
    },
  },
];

// ---------------- handlers ----------------
function makeHandlers(client) {
  return {
    visslm_status: async () => {
      let probe = null;
      if (client.loggedIn) {
        try {
          const r = await client.request('User/GetNickname', { query: { username: client.username } });
          probe = r.json ? '有效' : `未知（HTTP ${r.status}）`;
        } catch (e) { probe = '探测失败: ' + e.message; }
      }
      return text(j({
        baseUrl: client.baseUrl,
        loggedIn: client.loggedIn,
        sessionValid: probe,
        user: client.user,
        loginAt: client.loginAt,
        sessionFile: client.sessionFile,
        envCredentials: Boolean(process.env.VISSLM_USERNAME || client.username),
        apiCatalog: { file: 'data/api.json', ...catalogCount() },
      }));
    },

    visslm_login: async (a) => {
      try {
        const r = await client.login(a.username, a.password);
        return text(j({ ok: true, user: r.user, cookies: r.cookies, sessionFile: client.sessionFile }));
      } catch (e) {
        return errText(e.message, { code: e.code, detail: e.detail });
      }
    },

    visslm_logout: async () => text(j(await client.logout())),

    visslm_list_modules: async () => text(j(catalog.modules())),

    visslm_list_controllers: async (a) => {
      const list = catalog.controllers(a.module);
      if (!list.length) return errText(`模块不存在: ${a.module}`, { modules: catalog.modules().map(m => m.module) });
      return text(j(list));
    },

    visslm_list_endpoints: async (a) => {
      const r = catalog.endpoints(a.controller, a.keyword);
      if (!r) return errText(`Controller 不存在: ${a.controller}（可用 visslm_list_controllers 查看全部）`);
      const lines = r.endpoints.map(endpointBrief);
      return text(j({ controller: r.controller.class, base: r.controller.base, count: r.endpoints.length, endpoints: lines }));
    },

    visslm_search_api: async (a) => {
      const list = catalog.search(a.keyword, Math.min(a.limit || 50, 200));
      const lines = list.map(e => `${e.http.padEnd(12)} ${e.path}   [${(e.params || []).map(paramLine).join('; ') || '—'}] -> ${e.returns || ''}  (${e.controller})`);
      return text(j({ keyword: a.keyword, count: list.length, endpoints: lines }));
    },

    visslm_get_endpoint: async (a) => {
      const hit = catalog.findExact(a.path);
      if (!hit) {
        const guess = catalog.search(a.path, 10);
        return errText(`未找到端点: ${a.path}`, { similar: guess.map(e => e.path) });
      }
      return text(j({
        controller: hit.controller.class,
        module: hit.controller.module,
        endpoint: hit.endpoint,
        responseEnvelopes: catalog.load().meta.response_envelopes,
      }));
    },

    visslm_call_api: async (a) => {
      try {
        const r = await client.authedRequest({
          path: a.path,
          method: a.method || 'GET',
          query: a.query,
          body: a.body,
          headers: a.headers,
        });
        if (client.isLogonPageResult(r)) {
          return errText('未登录或会话已过期（服务端返回登录页）。请先调用 visslm_login。');
        }
        if (a.saveTo) {
          const out = path.resolve(a.saveTo);
          fs.writeFileSync(out, r.buffer || Buffer.from(r.text || '', 'utf-8'));
        }
        const bodyText = r.text !== undefined ? r.text : `<二进制响应 ${r.buffer ? r.buffer.length : 0} 字节，可用 visslm_download 保存>`;
        const max = a.full ? TRUNCATE_MAX : TRUNCATE_DEFAULT;
        return text(j({
          status: r.status,
          contentType: r.contentType,
          url: r.url,
          envelope: summarizeEnvelope(r.json),
          body: truncateText(bodyText, max),
          ...(a.saveTo ? { savedTo: path.resolve(a.saveTo) } : {}),
        }));
      } catch (e) {
        return errText(e, { path: a.path });
      }
    },

    visslm_download: async (a) => {
      try {
        const r = await client.authedRequest({ path: a.path, method: 'GET', query: a.query, raw: true });
        if (client.isLogonPageResult(r)) return errText('未登录或会话已过期，请先 visslm_login');
        const out = path.resolve(a.saveTo);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, r.buffer);
        return text(j({ ok: true, savedTo: out, bytes: r.buffer.length, contentType: r.contentType, url: r.url }));
      } catch (e) { return errText(e, { path: a.path }); }
    },

    visslm_upload: async (a) => {
      try {
        const fp = path.resolve(a.filePath);
        if (!fs.existsSync(fp)) return errText(`文件不存在: ${fp}`);
        const buf = fs.readFileSync(fp);
        const form = new FormData();
        form.append(a.field || 'file', new Blob([buf]), path.basename(fp));
        for (const [k, v] of Object.entries(a.fields || {})) form.append(k, String(v));
        const r = await client.authedRequest({
          path: a.path,
          method: 'POST',
          query: a.query,
          form,
        });
        return text(j({ status: r.status, envelope: summarizeEnvelope(r.json), body: truncateText(r.text || '', TRUNCATE_DEFAULT) }));
      } catch (e) { return errText(e, { path: a.path }); }
    },
  };
}

function catalogCount() {
  const cat = catalog.load();
  return {
    modules: new Set(cat.controllers.map(c => c.module)).size,
    controllers: cat.controllers.length,
    endpoints: cat.controllers.reduce((n, c) => n + c.endpoints.length, 0),
  };
}

module.exports = { schemas, makeHandlers, summarizeEnvelope };
