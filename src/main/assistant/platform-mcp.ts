import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { getAssistantRunContext } from './run-controller'

export interface PlatformCredentials {
  baseUrl: string
  username: string
  token: string
  uploadPassword: string
}

/** A per-question stdio connection. Credentials and session cookies never enter model context. */
export class PlatformMcpClient {
  private child?: ChildProcessWithoutNullStreams
  private directory?: string
  private buffer = ''
  private nextId = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private abort?: () => void

  constructor(private readonly serverPath: string, private readonly credentials: PlatformCredentials,
    private readonly signal = getAssistantRunContext()?.signal) {}

  async connect(): Promise<void> {
    if (!isAbsolute(this.serverPath) || !/\.[cm]?js$/i.test(this.serverPath) || !(await stat(this.serverPath)).isFile()) {
      throw new Error('请在平台配置中设置有效的 MCP server.js 绝对路径。')
    }
    if (this.signal?.aborted) throw this.signal.reason
    this.directory = await mkdtemp(join(tmpdir(), 'visslm-mcp-run-'))
    this.child = spawn(process.execPath, [this.serverPath], {
      cwd: dirname(this.serverPath), windowsHide: true, stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
        VISSLM_BASE_URL: this.credentials.baseUrl, VISSLM_USERNAME: this.credentials.username,
        VISSLM_PASSWORD: this.credentials.uploadPassword, VISSLM_SESSION: join(this.directory, 'session.json') }
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.resume()
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > 8_000_000) { this.fail(new Error('平台 MCP 响应超过安全大小限制。')); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        try {
          const message = JSON.parse(line)
          const pending = this.pending.get(message.id)
          if (!pending) continue
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error('平台 MCP 调用失败，请检查服务配置。'))
          else pending.resolve(message.result)
        } catch { this.fail(new Error('平台 MCP 返回了无效的 JSON-RPC 数据。')) }
      }
    })
    this.child.on('error', () => this.fail(new Error('无法启动平台 MCP 服务。')))
    this.child.on('exit', () => this.fail(new Error('平台 MCP 服务已退出。')))
    this.abort = () => this.fail(this.signal?.reason ?? new Error('平台查询已取消。'))
    this.signal?.addEventListener('abort', this.abort, { once: true })
    if (this.signal?.aborted) { this.abort(); throw this.signal.reason }
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'visslm-agent', version: '1.0.0' } })
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const listing = await this.rpc('tools/list', {})
    if (!listing?.tools?.some((tool: any) => tool.name === 'visslm_call_api')) throw new Error('MCP 缺少 visslm_call_api 工具。')
  }

  private fail(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear()
    this.child?.kill()
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.signal?.aborted) return Promise.reject(this.signal.reason)
    if (!this.child || this.child.killed || this.child.exitCode !== null) return Promise.reject(new Error('平台 MCP 未连接。'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('平台 MCP 查询超时。')), 45_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (error) this.fail(new Error('平台 MCP 通信中断。'))
      })
    })
  }

  /** Only two audited read endpoints are callable; arbitrary model-supplied API paths are not accepted. */
  async read(path: '/rest/items' | '/Admin/Virtualization_ReadMember', parameters: Record<string, string>): Promise<unknown> {
    if (!['/rest/items', '/Admin/Virtualization_ReadMember'].includes(path)) throw new Error('平台查询接口不在只读白名单中。')
    const result = await this.rpc('tools/call', {
      name: 'visslm_call_api', arguments: path === '/rest/items'
        ? { path, method: 'GET', query: { ...parameters, user: this.credentials.username, ApiToken: this.credentials.token }, full: true }
        : { path, method: 'POST', body: parameters, full: true }
    })
    if (result?.isError) throw new Error('平台读取失败，请检查平台连接与登录凭据。')
    let envelope: any
    try { envelope = JSON.parse(result.content.find((block: any) => block.type === 'text').text) }
    catch { throw new Error('平台 MCP 未返回有效的结构化响应。') }
    if (envelope.status < 200 || envelope.status >= 300 || envelope.envelope?.success === false) {
      throw new Error('平台返回查询错误，本次未获得可用证据。')
    }
    if (typeof envelope.body !== 'string' || envelope.body.includes('...[截断，共')) throw new Error('平台响应超出 MCP 返回上限，请缩小项目、类型或时间范围后重试。')
    try { return JSON.parse(envelope.body) }
    catch { throw new Error('平台返回了非 JSON 数据，请检查登录状态和查询范围。') }
  }

  async close(): Promise<void> {
    if (this.abort) this.signal?.removeEventListener('abort', this.abort)
    const child = this.child
    const exited = child && child.exitCode === null && child.signalCode === null
      ? new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 2_000).unref() })
      : Promise.resolve()
    this.fail(new Error('平台查询已结束。'))
    await exited
    // directory is solely the exact mkdtemp result owned by this connection.
    if (this.directory) await rm(this.directory, { recursive: true, force: true, maxRetries: 3 })
    this.directory = undefined
  }
}
