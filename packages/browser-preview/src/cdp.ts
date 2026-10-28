import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ConsoleEntry {
  kind: 'error' | 'warning'
  text: string
}

export interface SessionOptions {
  chromePath: string
  timeoutMs: number
  width: number
  height: number
  colorScheme?: 'light' | 'dark'
  waitMs: number
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export function findChrome(configured?: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined
  return CHROME_CANDIDATES.find(path => existsSync(path))
}

/** Minimal DevTools Protocol client: one flat session, request/response by id. */
class CdpClient {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>()

  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.addEventListener('message', (event) => this.receive(String(event.data)))
    socket.addEventListener('close', () => this.failAll(new Error('CDP connection closed')))
    socket.addEventListener('error', () => this.failAll(new Error('CDP connection failed')))
  }

  static async connect(endpoint: string, timeoutMs: number): Promise<CdpClient> {
    const socket = new WebSocket(endpoint)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('DevTools connection timed out'))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`cannot connect to ${endpoint}`))
      }, { once: true })
    })
    return new CdpClient(socket, timeoutMs)
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(method: string, handler: (params: any, sessionId?: string) => void): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(handler)
    this.listeners.set(method, set)
    return () => {
      set.delete(handler)
    }
  }

  waitFor(method: string, predicate: (params: any, sessionId?: string) => boolean, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let off = () => {}
      const timer = setTimeout(() => {
        off()
        reject(new Error(`CDP event ${method} timed out`))
      }, timeoutMs)
      off = this.on(method, (params, sessionId) => {
        if (!predicate(params, sessionId)) return
        off()
        clearTimeout(timer)
        resolve(params)
      })
    })
  }

  close() {
    this.closed = true
    try {
      this.socket.close()
    } catch {
      // already closed
    }
    this.failAll(new Error('CDP connection closed'))
  }

  private receive(raw: string) {
    let message: any
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(`${message.error.message ?? 'CDP error'}${message.error.data ? `: ${message.error.data}` : ''}`))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (typeof message.method === 'string') {
      for (const handler of this.listeners.get(message.method) ?? []) {
        handler(message.params ?? {}, message.sessionId)
      }
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

async function launchChrome(chromePath: string, timeoutMs: number) {
  const profile = mkdtempSync(join(tmpdir(), 'rbh-cdp-'))
  const child = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  let output = ''
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('headless Chrome did not report a DevTools endpoint')), Math.min(timeoutMs, 15_000))
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1]!)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`headless Chrome exited (${code}): ${output.slice(-400)}`))
    })
  }).catch((error) => {
    child.kill('SIGKILL')
    removeProfile(profile)
    throw error
  })

  return { child, endpoint, profile }
}

function textOfArgument(argument: any): string {
  if (!argument) return ''
  if ('value' in argument) return String(argument.value)
  return String(argument.description ?? argument.type ?? '')
}

/** One headless page: navigate, read the console, screenshot, evaluate. */
export class BrowserSession {
  private readonly consoleEntries: ConsoleEntry[] = []

  private constructor(
    private readonly cdp: CdpClient,
    private readonly child: ChildProcess,
    private readonly profile: string,
    private readonly targetId: string,
    private readonly sessionId: string,
    private readonly timeoutMs: number,
    private readonly waitMs: number,
  ) {}

  static async open(options: SessionOptions): Promise<BrowserSession> {
    const { child, endpoint, profile } = await launchChrome(options.chromePath, options.timeoutMs)
    let cdp: CdpClient | undefined
    try {
      cdp = await CdpClient.connect(endpoint, options.timeoutMs)
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      })
      const session = new BrowserSession(cdp, child, profile, targetId, sessionId, options.timeoutMs, options.waitMs)
      session.collectConsole()
      await cdp.send('Runtime.enable', {}, sessionId)
      await cdp.send('Log.enable', {}, sessionId)
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: options.width,
        height: options.height,
        deviceScaleFactor: 1,
        mobile: false,
      }, sessionId)
      if (options.colorScheme) {
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: options.colorScheme }],
        }, sessionId)
      }
      return session
    } catch (error) {
      cdp?.close()
      child.kill('SIGKILL')
      removeProfile(profile)
      throw error
    }
  }

  async navigate(url: string): Promise<{ title: string; url: string }> {
    const loaded = this.cdp.waitFor(
      'Page.loadEventFired',
      (_params, sessionId) => !sessionId || sessionId === this.sessionId,
      Math.min(this.timeoutMs, 10_000),
    )
    const result = await this.cdp.send<{ errorText?: string }>('Page.navigate', { url }, this.sessionId)
    if (result.errorText) throw new Error(`navigation failed: ${result.errorText}`)
    // A non-HTML response may never fire the load event; the settle wait below
    // still gives the page a chance to settle.
    await loaded.catch(() => undefined)
    await sleep(this.waitMs)
    const info = await this.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })')
    return info ?? { title: '', url }
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.cdp.send<{
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      timeout: this.timeoutMs,
    }, this.sessionId)
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown error'
      throw new Error(`page evaluation failed: ${detail}`)
    }
    return result.result?.value as T
  }

  async screenshot(fullPage: boolean): Promise<Buffer> {
    const params: Record<string, unknown> = { format: 'png', fromSurface: true }
    if (fullPage) {
      const metrics = await this.cdp.send<{
        cssContentSize?: { width: number; height: number }
        contentSize?: { width: number; height: number }
      }>('Page.getLayoutMetrics', {}, this.sessionId)
      const size = metrics.cssContentSize ?? metrics.contentSize
      if (size) {
        params.captureBeyondViewport = true
        params.clip = {
          x: 0,
          y: 0,
          width: Math.ceil(size.width),
          // A runaway page would otherwise produce a 50 MB image.
          height: Math.min(4_000, Math.ceil(size.height)),
          scale: 1,
        }
      }
    }
    const { data } = await this.cdp.send<{ data: string }>('Page.captureScreenshot', params, this.sessionId)
    return Buffer.from(data, 'base64')
  }

  consoleMessages(): ConsoleEntry[] {
    return [...this.consoleEntries]
  }

  async close(): Promise<void> {
    try {
      await this.cdp.send('Target.closeTarget', { targetId: this.targetId })
    } catch {
      // closing is best-effort
    }
    this.cdp.close()
    this.child.kill('SIGKILL')
    removeProfile(this.profile)
  }

  private collectConsole() {
    this.cdp.on('Runtime.consoleAPICalled', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const type = String(params.type ?? '')
      if (type !== 'error' && type !== 'warning' && type !== 'assert') return
      const text = (params.args ?? []).map(textOfArgument).join(' ').slice(0, 500)
      this.consoleEntries.push({ kind: type === 'warning' ? 'warning' : 'error', text })
    })
    this.cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const details = params.exceptionDetails ?? {}
      const text = String(details.exception?.description ?? details.text ?? 'uncaught exception').slice(0, 500)
      this.consoleEntries.push({ kind: 'error', text })
    })
    this.cdp.on('Log.entryAdded', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const entry = params.entry ?? {}
      if (entry.level !== 'error' && entry.level !== 'warning') return
      this.consoleEntries.push({ kind: entry.level, text: String(entry.text ?? '').slice(0, 500) })
    })
  }
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/**
 * Chrome keeps writing to its profile while it dies; an ENOTEMPTY here used to
 * surface as a failed tool call. A leftover temp profile is harmless.
 */
function removeProfile(profile: string) {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best-effort cleanup
  }
}
