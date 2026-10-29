import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ConsoleKind = 'log' | 'info' | 'warning' | 'error' | 'debug'

export interface ConsoleEntry {
  kind: ConsoleKind
  text: string
}

export interface NetworkEntry {
  id: string
  url: string
  method: string
  type: string
  status?: number
  mimeType?: string
  failed?: string
  at: number
}

/** One accessibility node, flattened: what the agent reads to pick a target. */
export interface AxEntry {
  uid: string
  role: string
  name: string
  value?: string
  states: string[]
  depth: number
}

export interface SessionOptions {
  chromePath: string
  timeoutMs: number
  width: number
  height: number
  mobile?: boolean
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

/** One headless page: navigate, read the console, screenshot, evaluate, interact. */
export class BrowserSession {
  private readonly consoleEntries: ConsoleEntry[] = []
  private readonly requests = new Map<string, NetworkEntry>()
  private currentUrl = 'about:blank'
  private width: number
  private height: number
  private colorScheme?: 'light' | 'dark'
  private casting = false
  private offScreencast?: () => void

  private constructor(
    private readonly cdp: CdpClient,
    private readonly child: ChildProcess,
    private readonly profile: string,
    private readonly targetId: string,
    private readonly sessionId: string,
    private readonly timeoutMs: number,
    private readonly waitMs: number,
    view: { width: number; height: number; colorScheme?: 'light' | 'dark' },
  ) {
    this.width = view.width
    this.height = view.height
    this.colorScheme = view.colorScheme
  }

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
      const session = new BrowserSession(cdp, child, profile, targetId, sessionId, options.timeoutMs, options.waitMs, options)
      session.collectConsole()
      session.collectNetwork()
      await cdp.send('Runtime.enable', {}, sessionId)
      await cdp.send('Log.enable', {}, sessionId)
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('DOM.enable', {}, sessionId)
      await cdp.send('Network.enable', {}, sessionId)
      await cdp.send('Accessibility.enable', {}, sessionId)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: options.width,
        height: options.height,
        deviceScaleFactor: 1,
        mobile: options.mobile === true,
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
    this.currentUrl = url
    const info = await this.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })')
    this.currentUrl = info?.url ?? url
    return info ?? { title: '', url }
  }

  async reload(): Promise<{ title: string; url: string }> {
    await this.cdp.send('Page.reload', {}, this.sessionId)
    await sleep(this.waitMs)
    const info = await this.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })')
    this.currentUrl = info?.url ?? this.currentUrl
    return info ?? { title: '', url: this.currentUrl }
  }

  url() {
    return this.currentUrl
  }

  view() {
    return { width: this.width, height: this.height, colorScheme: this.colorScheme }
  }

  async resize(view: { width: number; height: number; mobile?: boolean; colorScheme?: 'light' | 'dark' }) {
    this.width = view.width
    this.height = view.height
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: view.width,
      height: view.height,
      deviceScaleFactor: 1,
      mobile: view.mobile === true,
    }, this.sessionId)
    if (view.colorScheme) {
      this.colorScheme = view.colorScheme
      await this.cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: view.colorScheme }],
      }, this.sessionId)
    }
    await sleep(this.waitMs)
  }

  /** Accessibility tree with stable uids; click and fill take those uids. */
  async snapshot(maxNodes: number): Promise<{ entries: AxEntry[]; truncated: boolean }> {
    const { nodes } = await this.cdp.send<{ nodes: RawAxNode[] }>('Accessibility.getFullAXTree', {}, this.sessionId)
    return flattenAxTree(nodes, maxNodes)
  }

  async click(target: ElementTarget): Promise<void> {
    const objectId = await this.resolveObject(target)
    const box = await this.cdp.send<{ result?: { value?: { x: number; y: number; width: number; height: number } } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function () {
          this.scrollIntoView({ block: 'center', inline: 'center' })
          const r = this.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }
        }`,
        returnByValue: true,
      },
      this.sessionId,
    )
    const point = box.result?.value
    if (!point) throw new Error('the target element is not visible')
    const buttons = { left: 1, middle: 4, right: 2 } as const
    const button = target.button ?? 'left'
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, button: 'none',
    }, this.sessionId)
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button,
        buttons: buttons[button],
        clickCount: 1,
      }, this.sessionId)
    }
    await sleep(this.waitMs)
  }

  async fill(target: ElementTarget, value: string): Promise<void> {
    const objectId = await this.resolveObject(target)
    const result = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (value) {
        const el = this
        el.focus()
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
          : el instanceof HTMLInputElement ? HTMLInputElement.prototype
          : null
        if (el.isContentEditable) el.textContent = value
        else if (proto) {
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (setter) setter.call(el, value)
          else el.value = value
        } else {
          throw new Error('the target element cannot hold text')
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }`,
      arguments: [{ value }],
      returnByValue: true,
    }, this.sessionId)
    if (!result.result?.value) throw new Error('the target element cannot hold text')
    await sleep(this.waitMs)
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

  consoleMessages(clear = false): ConsoleEntry[] {
    const entries = [...this.consoleEntries]
    if (clear) this.consoleEntries.length = 0
    return entries
  }

  /** Live JPEG frames for the UI panel; the model's page becomes watchable. */
  async startScreencast(onFrame: (frame: { data: string; width: number; height: number }) => void): Promise<void> {
    if (this.casting) return
    this.casting = true
    this.offScreencast = this.cdp.on('Page.screencastFrame', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      // Not acking stops the stream after a few frames.
      void this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, this.sessionId)
        .catch(() => undefined)
      const meta = params.metadata ?? {}
      onFrame({
        data: String(params.data ?? ''),
        width: Number(meta.deviceWidth) || this.width,
        height: Number(meta.deviceHeight) || this.height,
      })
    })
    try {
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: Math.min(1_600, Math.max(320, this.width)),
        maxHeight: Math.min(1_000, Math.max(240, this.height)),
        everyNthFrame: 2,
      }, this.sessionId)
    } catch {
      this.casting = false
      this.offScreencast?.()
      this.offScreencast = undefined
    }
  }

  async stopScreencast(): Promise<void> {
    if (!this.casting) return
    this.casting = false
    this.offScreencast?.()
    this.offScreencast = undefined
    await this.cdp.send('Page.stopScreencast', {}, this.sessionId).catch(() => undefined)
  }

  networkEntries(): NetworkEntry[] {
    return [...this.requests.values()]
  }

  async responseBody(requestId: string): Promise<{ body: string; base64: boolean; mimeType?: string }> {
    const entry = this.requests.get(requestId)
    if (!entry) throw new Error(`unknown request: ${requestId}`)
    const result = await this.cdp.send<{ body: string; base64Encoded?: boolean }>(
      'Network.getResponseBody', { requestId }, this.sessionId,
    )
    return { body: result.body, base64: Boolean(result.base64Encoded), ...(entry.mimeType ? { mimeType: entry.mimeType } : {}) }
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

  private async resolveObject(target: ElementTarget): Promise<string> {
    if (target.uid) {
      const backendNodeId = Number(target.uid.replace(/^n/, ''))
      if (!Number.isInteger(backendNodeId) || !target.uid.startsWith('n')) {
        throw new Error(`unknown uid: ${target.uid}`)
      }
      const { object } = await this.cdp.send<{ object: { objectId: string } }>(
        'DOM.resolveNode', { backendNodeId }, this.sessionId,
      )
      if (!object?.objectId) throw new Error(`uid ${target.uid} is no longer in the page`)
      return object.objectId
    }
    const selector = String(target.selector ?? '').trim()
    if (!selector) throw new Error('pass uid (from browser_snapshot) or selector')
    const { result } = await this.cdp.send<{ result?: { objectId?: string; subtype?: string } }>('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    }, this.sessionId)
    if (!result?.objectId) throw new Error(`no element matches selector: ${selector}`)
    return result.objectId
  }

  private collectConsole() {
    this.cdp.on('Runtime.consoleAPICalled', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const type = String(params.type ?? '')
      const kind: ConsoleKind = type === 'warning' ? 'warning'
        : type === 'error' || type === 'assert' ? 'error'
        : type === 'debug' ? 'debug'
        : type === 'info' ? 'info'
        : 'log'
      const text = (params.args ?? []).map(textOfArgument).join(' ').slice(0, 500)
      this.pushConsole({ kind, text })
    })
    this.cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const details = params.exceptionDetails ?? {}
      const text = String(details.exception?.description ?? details.text ?? 'uncaught exception').slice(0, 500)
      this.pushConsole({ kind: 'error', text })
    })
    this.cdp.on('Log.entryAdded', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const entry = params.entry ?? {}
      const level = String(entry.level ?? '')
      if (level !== 'error' && level !== 'warning' && level !== 'info' && level !== 'debug') return
      this.pushConsole({ kind: level as ConsoleKind, text: String(entry.text ?? '').slice(0, 500) })
    })
  }

  private pushConsole(entry: ConsoleEntry) {
    this.consoleEntries.push(entry)
    if (this.consoleEntries.length > 200) this.consoleEntries.splice(0, this.consoleEntries.length - 200)
  }

  private collectNetwork() {
    this.cdp.on('Network.requestWillBeSent', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const request = params.request ?? {}
      this.requests.set(String(params.requestId), {
        id: String(params.requestId),
        url: String(request.url ?? ''),
        method: String(request.method ?? 'GET'),
        type: String(params.type ?? ''),
        at: Date.now(),
      })
      if (this.requests.size > 200) {
        const oldest = this.requests.keys().next().value
        if (oldest) this.requests.delete(oldest)
      }
    })
    this.cdp.on('Network.responseReceived', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const entry = this.requests.get(String(params.requestId))
      if (!entry) return
      entry.status = Number(params.response?.status ?? 0)
      entry.mimeType = params.response?.mimeType
    })
    this.cdp.on('Network.loadingFailed', (params, sessionId) => {
      if (sessionId && sessionId !== this.sessionId) return
      const entry = this.requests.get(String(params.requestId))
      if (!entry) return
      entry.failed = String(params.errorText ?? 'failed')
    })
  }
}

export interface ElementTarget {
  uid?: string
  selector?: string
  button?: 'left' | 'middle' | 'right'
}

interface RawAxNode {
  nodeId: string
  parentId?: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: unknown }
  backendDOMNodeId?: number
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
}

const STATE_NAMES = new Set(['disabled', 'checked', 'expanded', 'selected', 'focused', 'required'])

/** Depth-first flatten of the accessibility tree, keeping only what is usable. */
export function flattenAxTree(nodes: RawAxNode[], maxNodes = 1_500): { entries: AxEntry[]; truncated: boolean } {
  const byId = new Map<string, RawAxNode>()
  const children = new Map<string, RawAxNode[]>()
  for (const node of nodes) byId.set(node.nodeId, node)
  for (const node of nodes) {
    if (!node.parentId) continue
    const list = children.get(node.parentId) ?? []
    list.push(node)
    children.set(node.parentId, list)
  }
  const roots = nodes.filter(node => !node.parentId || !byId.has(node.parentId))
  const entries: AxEntry[] = []
  let truncated = false

  const visit = (node: RawAxNode, depth: number) => {
    if (entries.length >= maxNodes) {
      truncated = true
      return
    }
    const role = String(node.role?.value ?? '')
    const name = String(node.name?.value ?? '')
    const ignored = node.ignored === true
    const uid = node.backendDOMNodeId ? `n${node.backendDOMNodeId}` : undefined
    if (!ignored && role && role !== 'none' && role !== 'generic' && role !== 'InlineTextBox') {
      const value = node.value?.value
      const states = (node.properties ?? [])
        .filter(property => property.name && STATE_NAMES.has(property.name) && property.value?.value === true)
        .map(property => property.name!)
      if (name || value !== undefined || STATES_WITHOUT_NAME.has(role) || role === 'RootWebArea') {
        entries.push({
          uid: uid ?? `ax${node.nodeId}`,
          role,
          name: name.slice(0, 160),
          ...(value !== undefined && value !== '' ? { value: String(value).slice(0, 160) } : {}),
          states,
          depth,
        })
      }
    }
    for (const child of children.get(node.nodeId) ?? []) {
      visit(child, ignored ? depth : depth + 1)
    }
  }

  for (const root of roots) visit(root, 0)
  return { entries, truncated }
}

const STATES_WITHOUT_NAME = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'switch', 'tab', 'menuitem',
])

/** One line per entry: `uid=... role "name" value="..." [states]`. */
export function formatAxEntries(entries: AxEntry[], truncated: boolean): string {
  const lines = entries.map((entry) => {
    const indent = '  '.repeat(entry.depth)
    const name = entry.name ? ` "${entry.name}"` : ''
    const value = entry.value ? ` value="${entry.value}"` : ''
    const states = entry.states.length ? ` [${entry.states.join(', ')}]` : ''
    return `${indent}uid=${entry.uid} ${entry.role}${name}${value}${states}`
  })
  if (truncated) lines.push('… snapshot truncated; narrow the page or pass a smaller maxNodes')
  return lines.join('\n')
}

/** One line per request: method, status, type, url. */
export function formatNetwork(entries: NetworkEntry[], filter: 'all' | 'failed' = 'all'): string {
  const list = filter === 'failed'
    ? entries.filter(entry => entry.failed || (entry.status ?? 0) >= 400)
    : entries
  if (!list.length) return filter === 'failed' ? 'No failed requests.' : 'No requests recorded.'
  return list.map((entry) => {
    const status = entry.failed ? `FAILED ${entry.failed}` : String(entry.status ?? 'pending')
    return `${entry.id} ${entry.method} ${status} ${entry.type || '-'} ${entry.url}`
  }).join('\n')
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
