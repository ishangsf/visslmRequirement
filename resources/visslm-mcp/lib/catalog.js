'use strict';
/* API 目录：加载并检索 data/api.json（由 alm.war 控制器反编译生成） */
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'api.json');

let _catalog = null;
function load() {
  if (!_catalog) {
    _catalog = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }
  return _catalog;
}

function normPath(u) {
  let s = String(u || '').trim();
  s = s.split('?')[0];
  while (s.indexOf('//') >= 0) s = s.replace(/\/\//g, '/');
  if (s[0] !== '/') s = '/' + s;
  return s.toLowerCase();
}

/** 完整 URL（小写）-> 端点索引 */
function buildIndex() {
  const cat = load();
  const byPath = new Map(); // normPath('/alm/Controller/Action') -> entry
  const controllers = [];
  for (const c of cat.controllers) {
    controllers.push(c);
    for (const e of c.endpoints) {
      const p = normPath(e.path);
      const entry = { controller: c, endpoint: e, full: p };
      if (!byPath.has(p)) byPath.set(p, entry);
    }
  }
  return { cat, byPath, controllers };
}

function modules() {
  const cat = load();
  const map = new Map();
  for (const c of cat.controllers) {
    const m = c.module || '其他';
    if (!map.has(m)) map.set(m, { module: m, controllers: 0, endpoints: 0 });
    const s = map.get(m);
    s.controllers += 1;
    s.endpoints += c.endpoints.length;
  }
  return [...map.values()].sort((a, b) => b.endpoints - a.endpoints);
}

function controllers(moduleName) {
  const cat = load();
  return cat.controllers
    .filter(c => !moduleName || (c.module || '其他') === moduleName)
    .map(c => ({
      name: c.class.split('.').pop(),
      class: c.class,
      module: c.module || '其他',
      base: c.base,
      endpointCount: c.endpoints.length,
    }));
}

/** 列出某 Controller 的端点，可按关键字过滤 action */
function endpoints(controllerName, keyword) {
  const cat = load();
  const key = String(controllerName || '').toLowerCase().replace(/controller$/i, '');
  let best = null;
  for (const c of cat.controllers) {
    const simple = c.class.split('.').pop().toLowerCase().replace(/controller$/, '');
    if (simple === key || c.class.toLowerCase() === String(controllerName).toLowerCase()) { best = c; break; }
    if (!best && simple.includes(key)) best = c;
  }
  if (!best) return null;
  let eps = best.endpoints;
  if (keyword) {
    const kw = keyword.toLowerCase();
    eps = eps.filter(e => e.action.toLowerCase().includes(kw) || e.path.toLowerCase().includes(kw));
  }
  return { controller: best, endpoints: eps };
}

/** 全文搜索端点：匹配路径 / action / 控制器名 / 模块名 */
function search(keyword, limit = 50) {
  const cat = load();
  const kw = String(keyword || '').toLowerCase().trim();
  if (!kw) return [];
  const out = [];
  for (const c of cat.controllers) {
    const cName = c.class.split('.').pop();
    const cHit = cName.toLowerCase().includes(kw) || (c.module || '').toLowerCase().includes(kw);
    for (const e of c.endpoints) {
      const eHit = e.action.toLowerCase().includes(kw) || e.path.toLowerCase().includes(kw);
      if (cHit || eHit) {
        out.push({
          controller: cName,
          class: c.class,
          module: c.module || '其他',
          action: e.action,
          http: e.http,
          path: e.path,
          params: e.params,
          returns: e.returns,
        });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** 按完整路径精确取端点详情（支持 /alm/... 或 Controller/Action） */
function findExact(pathStr) {
  const { byPath } = buildIndex();
  let p = normPath(pathStr);
  if (!p.startsWith('/alm/')) p = '/alm/' + p.replace(/^\//, '');
  return byPath.get(p) || null;
}

module.exports = { load, modules, controllers, endpoints, search, findExact, normPath };
