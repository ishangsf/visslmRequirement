'use strict';
/* VISSLM HTTP 客户端：会话 Cookie 管理、登录加密、通用调用 / 上传 / 下载
 *
 * 认证约定（从前端 static/app 源码逆向确认）：
 *  - POST /alm/User/UPLogOn，表单 uname / upassword / rememberPwd
 *  - uname     = 6位随机hex + base64(encodeURI(用户名)) 去掉'=' + 6位随机hex(大写)
 *  - upassword = "*" + MD5(UPPER(用户名) + ":VISSLM:" + UPPER(MD5(明文)))
 *  - 服务端 Redis 会话，客户端持 JSESSIONID Cookie
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_VERSION = 1;

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

function randHex6() {
  // 与前端一致：((1+Math.random())*0x1000000|0).toString(16).substr(1,6)
  return ((1 + Math.random()) * 0x1000000 | 0).toString(16).slice(1, 7);
}

function encodeUname(name) {
  const enc = encodeURI(String(name)); // 全 ASCII（中文被百分号编码）
  const b64 = Buffer.from(enc, 'binary').toString('base64').replace(/=/g, '');
  return randHex6() + b64 + randHex6().toUpperCase();
}

function encryptPassword(pwd, userName) {
  return '*' + md5(String(userName).toUpperCase() + ':VISSLM:' + md5(String(pwd)).toUpperCase());
}

class VisslmClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || process.env.VISSLM_BASE_URL || 'http://localhost:8888/alm')
      .replace(/\/+$/, '');
    if (!/\/alm$/.test(this.baseUrl)) this.baseUrl += '/alm';
    this.username = opts.username || process.env.VISSLM_USERNAME || '';
    this.password = opts.password || process.env.VISSLM_PASSWORD || '';
    this.sessionFile = opts.sessionFile || path.join(__dirname, '..', '.visslm-session.json');
    this.cookies = new Map(); // name -> value
    this.user = null;
    this.loginAt = null;
    this._loadSession();
  }

  // ---------- session ----------
  _loadSession() {
    try {
      const s = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
      if (s.version === SESSION_VERSION && s.cookies) {
        for (const [k, v] of Object.entries(s.cookies)) this.cookies.set(k, v);
        this.user = s.user || null;
        this.loginAt = s.loginAt || null;
      }
    } catch (_) { /* no session yet */ }
  }

  _saveSession() {
    try {
      fs.writeFileSync(this.sessionFile, JSON.stringify({
        version: SESSION_VERSION,
        baseUrl: this.baseUrl,
        cookies: Object.fromEntries(this.cookies),
        user: this.user,
        loginAt: this.loginAt,
      }, null, 1));
    } catch (_) { /* best effort */ }
  }

  _clearSession() {
    this.cookies.clear();
    this.user = null;
    this.loginAt = null;
    try { fs.unlinkSync(this.sessionFile); } catch (_) {}
  }

  get loggedIn() { return this.cookies.has('JSESSIONID'); }

  // ---------- http core ----------
  _cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _absorbCookies(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const line of raw) {
      const [pair] = String(line).split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value && value !== '') this.cookies.set(name, value);
      }
    }
  }

  _resolveUrl(p) {
    let s = String(p || '').trim();
    if (/^https?:\/\//i.test(s)) return s;
    s = s.split('?')[0];
    while (s.indexOf('//') >= 0) s = s.replace(/\/\//g, '/');
    if (s.toLowerCase().startsWith('/alm/')) return this.baseUrl.replace(/\/alm$/i, '') + s;
    if (s.toLowerCase() === '/alm') return this.baseUrl;
    return this.baseUrl + '/' + s.replace(/^\//, '');
  }

  /**
   * 发起请求。返回 {status, contentType, url, text?, buffer?, json?, redirectedToLogon}
   */
  async request(p, { method = 'GET', query, body, form, headers = {}, timeoutMs = 120000, raw = false } = {}) {
    const url = new URL(this._resolveUrl(p));
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const h = {
      'X-Requested-With': 'XMLHttpRequest',
      ...headers,
    };
    // 清除显式置 null 的头（如 multipart 需让 fetch 自动生成 boundary）
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const ck = this._cookieHeader();
    if (ck) h['Cookie'] = ck;

    let payload;
    if (form) {
      payload = form; // FormData：fetch 自动设置 multipart boundary
    } else if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        payload = body;
        if (!h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      } else if (h['Content-Type'] && String(h['Content-Type']).includes('application/json')) {
        payload = JSON.stringify(body);
      } else {
        // 默认按表单提交（与前端 $.ajax 一致）
        payload = new URLSearchParams(
          Object.entries(body).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
        ).toString();
        h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: method.toUpperCase(),
        headers: h,
        body: payload,
        redirect: 'manual', // 手动处理，便于识别“会话过期被重定向到登录页”
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(`请求失败 ${method} ${url.toString()}: ${e.message}（请检查 VISSLM_BASE_URL 是否可达）`);
    } finally {
      clearTimeout(timer);
    }
    this._absorbCookies(res);

    // 30x：跟随一次（登录过期常被 302 到 /alm/User/LogOn）
    let finalUrl = url.toString();
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) {
        const next = new URL(loc, url).toString();
        const res2 = await fetch(next, { method: 'GET', headers: { ...h, Cookie: this._cookieHeader() }, redirect: 'follow' });
        this._absorbCookies(res2);
        finalUrl = res2.url || next;
        res = res2;
      }
    } else {
      finalUrl = res.url || finalUrl;
    }

    const contentType = res.headers.get('content-type') || '';
    const redirectedToLogon = /\/User\/LogOn/i.test(finalUrl) || /\/User\/UPLogOn/i.test(finalUrl);
    if (raw || !/text|json|xml|javascript/i.test(contentType)) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, contentType, url: finalUrl, buffer, redirectedToLogon };
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, contentType, url: finalUrl, text, json, redirectedToLogon };
  }

  isLogonPageResult(r) {
    return r.redirectedToLogon || (r.status === 401) ||
      (r.status === 200 && r.text && !r.json && /logon|login/i.test(r.url));
  }

  // ---------- 登录 ----------
  async login(username, password) {
    const u = username || this.username;
    const p = password || this.password;
    if (!u || !p) {
      const err = new Error('缺少用户名/密码：请在工具参数或环境变量 VISSLM_USERNAME / VISSLM_PASSWORD 中提供');
      err.code = 'NO_CREDENTIALS';
      throw err;
    }
    this.username = u; this.password = p;
    const r = await this.request('User/UPLogOn', {
      method: 'POST',
      body: { uname: encodeUname(u), upassword: encryptPassword(p, u), rememberPwd: 'false' },
    });
    if (r.json && r.json.ErrorCode === 0) {
      this.user = r.json.Data || null;
      this.loginAt = new Date().toISOString();
      this._saveSession();
      return { ok: true, user: this.user, cookies: [...this.cookies.keys()] };
    }
    const msg = (r.json && (r.json.ErrorMsg || r.json.msg)) ||
      (r.redirectedToLogon ? '登录失败：服务端重定向回登录页，请检查用户名/密码' : `登录失败：HTTP ${r.status}`);
    const err = new Error(msg);
    err.code = 'LOGIN_FAILED';
    err.detail = r.json || r.text && String(r.text).slice(0, 500);
    throw err;
  }

  async logout() {
    try { await this.request('Account/LogOff', { method: 'GET' }); } catch (_) {}
    this._clearSession();
    return { ok: true };
  }

  /** 带自动重登录的请求：会话失效时自动 login 一次并重试 */
  async authedRequest(opts) {
    let r = await this.request(opts.path, opts);
    if (this.isLogonPageResult(r) && (this.username && this.password || process.env.VISSLM_USERNAME)) {
      await this.login();
      r = await this.request(opts.path, opts);
    }
    return r;
  }
}

module.exports = { VisslmClient, encodeUname, encryptPassword };
