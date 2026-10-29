import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ToolDefinition, ToolRunContext } from '@ruobai/tools'
import {
  BrowserSession, findChrome, flattenAxTree, formatAxEntries, formatNetwork,
  type ConsoleEntry, type ElementTarget,
} from './cdp.ts'

export const name = 'browser-preview'
export const inject = ['tools']

export interface Config {
  /** Explicit Chrome/Chromium binary; auto-detected when omitted. */
  chromePath?: string
  /** Hosts the browser may navigate to. Defaults to loopback only. */
  allowedHosts?: string[]
  timeoutMs?: number
  /** Settle time after the load event, for fonts and transitions. */
  waitMs?: number
  width?: number
  height?: number
  /** Relative to the session workspace. */
  screenshotsDir?: string
  /**
   * Attach the PNG to the tool result for vision models.
   * `auto` only attaches when the model declares image input.
   */
  sendImages?: 'auto' | 'always' | 'never'
  /** Close a page this long after its last tool call. */
  idleMs?: number
  /** Pages kept per agent session; the least recently used is closed first. */
  maxPages?: number
}

const DEFAULT_HOSTS = ['127.0.0.1', 'localhost', '::1']
const MAX_EXPRESSION = 20_000
const MAX_IMAGE_BYTES = 3_500_000
const MAX_RESULT_CHARS = 8_000
const MAX_CONSOLE = 8
const MAX_SNAPSHOT_NODES = 1_500

const PRESETS = {
  mobile: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
} as const

interface PageView {
  width: number
  height: number
  mobile?: boolean
  colorScheme?: 'light' | 'dark'
}

interface PageEntry {
  key: string
  scope: string
  url: string
  title?: string
  session: BrowserSession
  view: PageView
  casting?: boolean
  lastUsed: number
  timer?: ReturnType<typeof setTimeout>
}

/** One frame or lifecycle note for the UI's live view of the model's page. */
export interface BrowserCastEvent {
  kind: 'open' | 'frame' | 'close'
  sessionId: string
  url: string
  title?: string
  width?: number
  height?: number
  /** Base64 JPEG for `frame`. */
  data?: string
  /** The page was just created; the panel opens itself for this one. */
  fresh?: boolean
}

/**
 * Screenshot, inspect and drive the running app.
 *
 * A page stays open between tool calls — open, snapshot, click, fill and
 * screenshot act on the same document — so a verification flow is a
 * conversation with one page instead of a fresh browser per call. Pages are
 * scoped to the agent session, close after `idleMs`, and navigation is limited
 * to loopback by default.
 */
export class BrowserPreviewService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pages = new Map<string, PageEntry>()
  private readonly current = new Map<string, string>()

  constructor(
    private readonly config: {
      timeoutMs: number
      waitMs: number
      width: number
      height: number
      idleMs: number
      maxPages: number
      screenshotsDir?: string
    },
    readonly chromePath: string | undefined,
    private readonly broadcast?: (event: BrowserCastEvent) => void,
  ) {}

  /** One browser at a time; concurrent calls would spawn several Chromes. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * The page for this call: the one already open at `url`, else the session's
   * current page when no url is given. Opens and navigates a new page when
   * needed, and applies a changed viewport.
   */
  async acquire(
    run: ToolRunContext | undefined,
    rawUrl: string | undefined,
    view: PageView | undefined,
    options: { reload?: boolean } = {},
  ): Promise<PageEntry> {
    const scope = run?.sessionId ?? ''
    const url = rawUrl ? rawUrl : undefined
    const key = url ? `${scope}\n${url}` : this.current.get(scope)
    if (!key) throw new Error('no page is open yet: pass url on the first call')
    let entry = this.pages.get(key)
    let fresh = false
    if (!entry) {
      if (!url) throw new Error('the page is gone: pass url to open it again')
      entry = await this.openPage(key, scope, url, view ?? this.defaultView())
      fresh = true
    } else {
      if (options.reload) {
        const info = await entry.session.navigate(entry.url)
        this.updateUrl(entry, info.url, info.title)
      }
      // Only an explicit size changes the viewport; a plain call must not undo
      // a resize requested earlier in the flow.
      if (view) await this.applyView(entry, view)
    }
    const previous = this.current.get(scope)
    if (previous && previous !== entry.key) {
      const other = this.pages.get(previous)
      if (other) await this.stopCast(other)
    }
    this.current.set(scope, entry.key)
    if (!entry.casting) await this.startCast(entry)
    if (fresh || previous !== entry.key) this.announceOpen(entry, fresh)
    this.touch(entry)
    return entry
  }

  private defaultView(): PageView {
    return { width: this.config.width, height: this.config.height }
  }

  async close(run: ToolRunContext | undefined, options: { url?: string; all?: boolean } = {}): Promise<number> {
    const scope = run?.sessionId ?? ''
    const keys = [...this.pages.keys()].filter((key) => {
      if (!key.startsWith(`${scope}\n`)) return false
      if (options.all) return true
      if (options.url) return key === `${scope}\n${options.url}`
      return key === this.current.get(scope)
    })
    for (const key of keys) await this.closeEntry(key)
    if (!this.pages.has(this.current.get(scope) ?? '')) this.current.delete(scope)
    return keys.length
  }

  async closeAll(): Promise<void> {
    for (const key of [...this.pages.keys()]) await this.closeEntry(key)
    this.current.clear()
  }

  pageInfo(entry: PageEntry): string {
    const { width, height, colorScheme } = entry.view
    return `${entry.url} · ${width}x${height}${colorScheme ? ` · ${colorScheme}` : ''}`
  }

  private async openPage(key: string, scope: string, url: string, view: PageView): Promise<PageEntry> {
    if (!this.chromePath) {
      throw new Error(
        'headless Chrome was not found. Install Chrome/Chromium or set browser-preview.chromePath in cordis.yml.',
      )
    }
    const session = await BrowserSession.open({
      chromePath: this.chromePath,
      timeoutMs: this.config.timeoutMs,
      waitMs: this.config.waitMs,
      width: view.width,
      height: view.height,
      mobile: view.mobile === true,
      ...(view.colorScheme ? { colorScheme: view.colorScheme } : {}),
    })
    let title: string | undefined
    try {
      title = (await session.navigate(url)).title || undefined
    } catch (error) {
      await session.close()
      throw error
    }
    const entry: PageEntry = { key, scope, url, ...(title ? { title } : {}), session, view: { ...view }, lastUsed: Date.now() }
    this.pages.set(key, entry)
    this.evict(scope, key)
    return entry
  }

  private async startCast(entry: PageEntry) {
    entry.casting = true
    await entry.session.startScreencast((frame) => {
      this.broadcast?.({
        kind: 'frame',
        sessionId: entry.scope,
        url: entry.url,
        ...(entry.title ? { title: entry.title } : {}),
        width: frame.width,
        height: frame.height,
        data: frame.data,
      })
    })
  }

  private async stopCast(entry: PageEntry) {
    if (!entry.casting) return
    entry.casting = false
    await entry.session.stopScreencast()
  }

  private announceOpen(entry: PageEntry, fresh: boolean) {
    this.broadcast?.({
      kind: 'open',
      sessionId: entry.scope,
      url: entry.url,
      ...(entry.title ? { title: entry.title } : {}),
      width: entry.view.width,
      height: entry.view.height,
      ...(fresh ? { fresh: true } : {}),
    })
  }

  /** The URL a page navigated to on its own (a click, a redirect). */
  updateUrl(entry: PageEntry, url: string, title?: string) {
    if (url && url !== entry.url) {
      entry.url = url
      this.announceOpen(entry, false)
    } else if (title !== undefined && title !== entry.title) {
      entry.title = title
      this.announceOpen(entry, false)
    }
  }

  private async applyView(entry: PageEntry, view: PageView) {
    const next = entry.view
    const changed = next.width !== view.width || next.height !== view.height
      || next.mobile !== view.mobile
      || (view.colorScheme !== undefined && view.colorScheme !== next.colorScheme)
    if (!changed) return
    entry.view = { ...view }
    await entry.session.resize(view)
  }

  private touch(entry: PageEntry) {
    entry.lastUsed = Date.now()
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      // A page may have been replaced at this key in the meantime.
      if (this.pages.get(entry.key) === entry) void this.closeEntry(entry.key)
    }, this.config.idleMs)
    entry.timer.unref?.()
  }

  private evict(scope: string, keep: string) {
    const own = [...this.pages.values()]
      .filter(entry => entry.key.startsWith(`${scope}\n`) && entry.key !== keep)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    while (this.pages.size > 0 && this.countFor(scope) > this.config.maxPages && own.length) {
      const oldest = own.shift()
      if (oldest) void this.closeEntry(oldest.key)
    }
  }

  private countFor(scope: string) {
    let count = 0
    for (const key of this.pages.keys()) if (key.startsWith(`${scope}\n`)) count += 1
    return count
  }

  private async closeEntry(key: string) {
    const entry = this.pages.get(key)
    if (!entry) return
    this.pages.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    for (const [scope, current] of this.current) if (current === key) this.current.delete(scope)
    await this.stopCast(entry)
    await entry.session.close()
    this.broadcast?.({ kind: 'close', sessionId: entry.scope, url: entry.url })
  }

  screenshotDir(run?: ToolRunContext): string {
    const root = run?.workspace ? resolve(run.workspace) : process.cwd()
    const dir = resolve(root, this.config.screenshotsDir ?? '.ruobai/screenshots')
    if (!inside(root, dir)) throw new Error('screenshotsDir escapes the workspace')
    return dir
  }
}

export function apply(ctx: Context, config: Config) {
  const service = new BrowserPreviewService({
    timeoutMs: config.timeoutMs ?? 20_000,
    waitMs: config.waitMs ?? 400,
    width: config.width ?? 1_280,
    height: config.height ?? 800,
    idleMs: config.idleMs ?? 120_000,
    maxPages: config.maxPages ?? 4,
    ...(config.screenshotsDir ? { screenshotsDir: config.screenshotsDir } : {}),
  }, findChrome(config.chromePath), (event) => {
    // The right-hand panel mirrors the page the model is driving.
    const ui = ctx.get('ui', false) as { broadcast?(channel: string, data: unknown): void } | undefined
    ui?.broadcast?.('browser', event)
  })

  const allowedHosts = config.allowedHosts?.length ? config.allowedHosts : DEFAULT_HOSTS
  const definitions = [
    openTool(ctx, service, allowedHosts, config),
    snapshotTool(service, allowedHosts, config),
    clickTool(service, allowedHosts, config),
    fillTool(service, allowedHosts, config),
    consoleTool(service, allowedHosts, config),
    networkTool(service, allowedHosts, config),
    resizeTool(service, allowedHosts, config),
    closeTool(service, allowedHosts, config),
    screenshotTool(ctx, service, allowedHosts, config),
    evalTool(service, allowedHosts, config),
  ]

  ctx.effect(() => {
    const disposers = definitions.map(definition => ctx.tools.register(definition))
    return () => {
      disposers.forEach(dispose => dispose())
      void service.closeAll()
    }
  }, 'ctx.tools.register(browser)')
}

export default { name, inject, apply }

const PAGE_URL = {
  type: 'string',
  description: 'http(s) URL on an allowed host. Omit after the first call to reuse the current page.',
} as const

const VIEW_PARAMS = {
  width: { type: 'number', description: 'Viewport width in CSS pixels; default 1280.' },
  height: { type: 'number', description: 'Viewport height in CSS pixels; default 800.' },
  colorScheme: { type: 'string', enum: ['light', 'dark'], description: 'Emulate prefers-color-scheme.' },
} as const

function viewOf(args: any, config: Config): PageView | undefined {
  const explicit = args?.width !== undefined || args?.height !== undefined || args?.colorScheme !== undefined
  if (!explicit) return undefined
  return {
    width: bounded(args?.width, config.width ?? 1_280, 200, 3_840),
    height: bounded(args?.height, config.height ?? 800, 200, 2_400),
    ...(args?.colorScheme === 'dark' ? { colorScheme: 'dark' as const } : {}),
    ...(args?.colorScheme === 'light' ? { colorScheme: 'light' as const } : {}),
  }
}

function openTool(ctx: Context, service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_open',
    description: [
      'Open a local URL in headless Chrome and keep the page open for later browser_* calls',
      'in this session. Pass reload to navigate it again. `preview` takes a launch.json',
      'configuration name whose server is already running (start it from the 预览 panel);',
      'this reads the URL only, it never starts a command. Only loopback hosts are allowed',
      'unless browser-preview.allowedHosts lists more.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL, e.g. http://127.0.0.1:4310' },
        preview: { type: 'string', description: 'launch.json configuration name; use instead of url.' },
        reload: { type: 'boolean', description: 'Navigate a page that is already open.' },
        ...VIEW_PARAMS,
      },
    },
    async execute(args, run) {
      const url = args?.url
        ? assertAllowedUrl(args.url, allowedHosts)
        : await previewUrl(ctx, args?.preview, allowedHosts)
      return service.exclusive(async () => {
        const entry = await service.acquire(run, url.toString(), viewOf(args, config), { reload: args?.reload === true })
        const page = await entry.session.evaluate<{ title: string }>('({ title: document.title })')
        return [
          `[page: ${page?.title || '(untitled)'} · ${service.pageInfo(entry)}]`,
          ...consoleLines(entry.session.consoleMessages()),
        ].join('\n')
      })
    },
  }
}

/** A running preview server's URL, read-only: starting it stays a user click. */
async function previewUrl(ctx: Context, raw: unknown, allowedHosts: string[]): Promise<URL> {
  const name = String(raw ?? '').trim()
  if (!name) throw new Error('pass url, or preview with a launch.json configuration name')
  const preview = ctx.get('preview', false) as
    | { snapshot(): Promise<{ states: Array<{ name: string; status: string; url?: string }> }> }
    | undefined
  if (!preview) throw new Error('the preview plugin is not loaded, so preview names cannot be resolved')
  const { states } = await preview.snapshot()
  const state = states.find(item => item.name === name)
  if (!state) throw new Error(`unknown preview configuration: ${name}`)
  if (state.status !== 'running' || !state.url) {
    throw new Error(`preview "${name}" is not running; start it from the 预览 panel first`)
  }
  return assertAllowedUrl(state.url, allowedHosts)
}

function snapshotTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_snapshot',
    description: [
      'Accessibility snapshot of the open page: one line per node with a uid, role, name and state.',
      'Pass a uid to browser_click / browser_fill to act on that node. This is the reliable way',
      'to find controls; CSS selectors work too but are not listed here.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        maxNodes: { type: 'number', description: 'Node cap; default 1500.' },
        ...VIEW_PARAMS,
      },
    },
    async execute(args, run) {
      const url = optionalUrl(args?.url, allowedHosts)
      return service.exclusive(async () => {
        const entry = await service.acquire(run, url, viewOf(args, config))
        const max = Math.min(4_000, Math.max(50, Math.floor(Number(args?.maxNodes) || MAX_SNAPSHOT_NODES)))
        const { entries, truncated } = await entry.session.snapshot(max)
        return `${formatAxEntries(entries, truncated)}\n\n[page: ${entry.session.url()} · ${service.pageInfo(entry)}]`
      })
    },
  }
}

function clickTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_click',
    description: [
      'Click an element in the open page by uid from browser_snapshot, or by CSS selector.',
      'The page keeps its state for the next call, so click then snapshot/screenshot to verify.',
    ].join(' '),
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        uid: { type: 'string', description: 'uid from browser_snapshot, e.g. n42.' },
        selector: { type: 'string', description: 'CSS selector; use when the snapshot has no uid.' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Default left.' },
        ...VIEW_PARAMS,
      },
    },
    async execute(args, run) {
      const target = elementTarget(args)
      const url = optionalUrl(args?.url, allowedHosts)
      return service.exclusive(async () => {
        const entry = await service.acquire(run, url, viewOf(args, config))
        await entry.session.click(target)
        const page = await entry.session.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })')
        service.updateUrl(entry, page.url, page.title)
        return [
          `Clicked ${target.uid ?? target.selector}.`,
          `[page: ${page.title || '(untitled)'} · ${page.url}]`,
          ...consoleLines(entry.session.consoleMessages()),
        ].join('\n')
      })
    },
  }
}

function fillTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_fill',
    description: [
      'Set the value of an input, textarea, select or contenteditable element in the open page,',
      'by uid from browser_snapshot or by CSS selector; input and change events are dispatched.',
    ].join(' '),
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        uid: { type: 'string', description: 'uid from browser_snapshot.' },
        selector: { type: 'string', description: 'CSS selector.' },
        value: { type: 'string', description: 'Text to put in the element.' },
        ...VIEW_PARAMS,
      },
      required: ['value'],
    },
    async execute(args, run) {
      const target = elementTarget(args)
      const url = optionalUrl(args?.url, allowedHosts)
      return service.exclusive(async () => {
        const entry = await service.acquire(run, url, viewOf(args, config))
        await entry.session.fill(target, String(args?.value ?? ''))
        return [
          `Filled ${target.uid ?? target.selector}.`,
          `[page: ${entry.session.url()} · ${service.pageInfo(entry)}]`,
          ...consoleLines(entry.session.consoleMessages()),
        ].join('\n')
      })
    },
  }
}

function consoleTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_console',
    description: [
      'Console messages recorded by the open page since it loaded: log, info, debug, warning,',
      'error and uncaught exceptions. Pass clear to start a fresh recording window.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        level: { type: 'string', enum: ['all', 'error', 'warn'], description: 'Default all.' },
        clear: { type: 'boolean', description: 'Drop what was recorded after returning it.' },
        ...VIEW_PARAMS,
      },
    },
    async execute(args, run) {
      const url = optionalUrl(args?.url, allowedHosts)
      return service.exclusive(async () => {
        const entry = await service.acquire(run, url, viewOf(args, config))
        const entries = entry.session.consoleMessages(args?.clear === true)
        const level = args?.level === 'error' ? 'error' : args?.level === 'warn' ? 'warning' : 'all'
        const list = level === 'all' ? entries : entries.filter(item => item.kind === level)
        const lines = list.slice(-100).map(item => `${item.kind}: ${item.text.replace(/\s+/g, ' ')}`)
        return [
          list.length ? lines.join('\n') : 'Console is clean.',
          `[page: ${entry.session.url()}]`,
        ].join('\n')
      })
    },
  }
}

function networkTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_network',
    description: [
      'Requests the open page has made. Lists method, status, type and URL, optionally only',
      'failed ones; pass a requestId to read its response body.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        filter: { type: 'string', enum: ['all', 'failed'], description: 'Default all.' },
        requestId: { type: 'string', description: 'Read this request’s response body instead of listing.' },
        ...VIEW_PARAMS,
      },
    },
    async execute(args, run) {
      const url = optionalUrl(args?.url, allowedHosts)
      return service.exclusive(async () => {
        const entry = await service.acquire(run, url, viewOf(args, config))
        if (args?.requestId) {
          const body = await entry.session.responseBody(String(args.requestId))
          const text = body.base64
            ? `[binary ${body.mimeType ?? 'response'}, ${body.body.length} base64 chars]`
            : body.body.slice(0, MAX_RESULT_CHARS) + (body.body.length > MAX_RESULT_CHARS ? '\n… truncated' : '')
          return `${text}\n[page: ${entry.session.url()}]`
        }
        const entries = entry.session.networkEntries()
        return `${formatNetwork(entries, args?.filter === 'failed' ? 'failed' : 'all')}\n[page: ${entry.session.url()}]`
      })
    },
  }
}

function resizeTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_resize',
    description: [
      'Resize the open page: mobile (375x812), tablet (768x1024), desktop (the configured size),',
      'or explicit width/height; colorScheme re-emulates prefers-color-scheme. The page reloads',
      'nothing — call browser_open with reload to re-run load-time gates.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop'] },
        ...VIEW_PARAMS,
      },
    },
    async execute(args, run) {
      const url = optionalUrl(args?.url, allowedHosts)
      const size = presetOf(args?.preset, config)
      return service.exclusive(async () => {
        const entry = await service.acquire(run, url, size)
        const info = await entry.session.evaluate<{ innerWidth: number; innerHeight: number }>(
          '({ innerWidth, innerHeight })',
        )
        return [
          `Resized to ${info?.innerWidth ?? size.width}x${info?.innerHeight ?? size.height}.`,
          `[page: ${entry.session.url()} · ${service.pageInfo(entry)}]`,
        ].join('\n')
      })
    },
  }
}

function closeTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_close',
    description: 'Close the open page (or every page of this session with all) and free its Chrome process.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        all: { type: 'boolean', description: 'Close every page opened in this session.' },
      },
    },
    async execute(args, run) {
      const url = optionalUrl(args?.url, allowedHosts)
      return service.exclusive(async () => {
        const closed = await service.close(run, { ...(url ? { url } : {}), ...(args?.all === true ? { all: true } : {}) })
        return closed ? `Closed ${closed} page(s).` : 'No page was open.'
      })
    },
  }
}

function screenshotTool(
  ctx: Context,
  service: BrowserPreviewService,
  allowedHosts: string[],
  config: Config,
): ToolDefinition {
  return {
    name: 'browser_screenshot',
    description: [
      'Screenshot the open page (or open url first) and save a PNG under .ruobai/screenshots/.',
      'Returns the path, page title, size and console errors/warnings;',
      'vision-capable models also receive the PNG itself (includeImage: false opts out).',
      'The page keeps its state between calls, so click/fill before screenshotting a flow.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        reload: { type: 'boolean', description: 'Navigate before capturing.' },
        fullPage: { type: 'boolean', description: 'Capture the whole page (height capped at 4000px).' },
        includeImage: {
          type: 'boolean',
          description: 'Attach the PNG to the result for vision models. Default true.',
        },
        ...VIEW_PARAMS,
      },
    },
    async execute(args, run) {
      const url = optionalUrl(args?.url, allowedHosts)
      const view = viewOf(args, config)
      return service.exclusive(async () => {
        const entry = await service.acquire(run, url, view, { reload: args?.reload === true })
        const page = await entry.session.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })')
        const png = await entry.session.screenshot(args?.fullPage === true)
        const dir = service.screenshotDir(run)
        await mkdir(dir, { recursive: true })
        const file = resolve(dir, `${timestamp()}-${slug(new URL(page.url))}.png`)
        await writeFile(file, png)
        const root = run?.workspace ? resolve(run.workspace) : process.cwd()
        const shown = relative(root, file).split('\\').join('/')
        const mode = config.sendImages ?? 'auto'
        const support = ctx.tools.imageSupport(run?.sessionId)
        const attach = args?.includeImage !== false && mode !== 'never'
          && (mode === 'always' || support === 'yes')
        const oversized = png.byteLength > MAX_IMAGE_BYTES
        const lines = [
          `Screenshot: ${shown} (${entry.view.width}x${entry.view.height}${entry.view.colorScheme ? `, ${entry.view.colorScheme}` : ''})`,
          `Title: ${page.title || '(none)'}`,
          `URL: ${page.url}`,
          ...consoleLines(entry.session.consoleMessages()),
        ]
        if (attach && !oversized) {
          lines.push('Image attached to this tool result.')
          return {
            text: lines.join('\n'),
            images: [{ mimeType: 'image/png', data: png.toString('base64'), name: shown }],
          }
        }
        if (attach && oversized) {
          lines.push(`Image is ${(png.byteLength / 1_048_576).toFixed(1)} MB, above the ${MAX_IMAGE_BYTES / 1_048_576} MB limit; not attached.`)
        } else if (args?.includeImage === false || mode === 'never') {
          lines.push('Image not attached (disabled).')
        } else {
          const who = run?.sessionId
            ? (() => {
                const meta = ctx.sessions.get(run.sessionId!)?.meta
                return meta?.provider ? `${meta.provider}/${meta.model ?? '?'}` : '当前模型'
              })()
            : '当前模型'
          lines.push(
            `${who} 未声明图片输入，PNG 只保存到磁盘。`
              + '要让我直接看到页面，请在 设置 → 模型 → 输入类型 勾选“图片”，或换用支持视觉的模型；'
              + '也可以继续用 browser_eval 读取几何与计算样式。',
          )
        }
        return lines.join('\n')
      })
    },
  }
}

function evalTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_eval',
    description: [
      'Evaluate one JavaScript expression in the open page and return the JSON value.',
      'Use it for computed styles, element sizes, scrollWidth overflow checks and',
      'prefers-color-scheme assertions. It runs in the page the other browser_* tools use,',
      'so interaction state is visible to it.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: PAGE_URL,
        expression: {
          type: 'string',
          description: 'Expression evaluated after load; wrap multi-step work in an IIFE. Max 20k characters.',
        },
        reload: { type: 'boolean', description: 'Navigate before evaluating.' },
        ...VIEW_PARAMS,
      },
      required: ['expression'],
    },
    async execute(args, run) {
      const url = optionalUrl(args?.url, allowedHosts)
      const expression = String(args?.expression ?? '').trim()
      if (!expression) throw new Error('expression is required')
      if (expression.length > MAX_EXPRESSION) throw new Error(`expression is longer than ${MAX_EXPRESSION} characters`)

      return service.exclusive(async () => {
        const entry = await service.acquire(run, url, viewOf(args, config), { reload: args?.reload === true })
        const value = await entry.session.evaluate(expression)
        const rendered = stringify(value)
        return [
          rendered.length > MAX_RESULT_CHARS
            ? `${rendered.slice(0, MAX_RESULT_CHARS)}\n… result truncated (${rendered.length} chars)`
            : rendered,
          '',
          `[page: ${entry.session.url()} · ${service.pageInfo(entry)}]`,
          ...consoleLines(entry.session.consoleMessages()),
        ].join('\n')
      })
    },
  }
}

export function assertAllowedUrl(raw: unknown, allowedHosts: string[]): URL {
  const text = String(raw ?? '').trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`invalid url: ${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http(s) urls are supported')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!allowedHosts.includes(host)) {
    throw new Error(`host "${host}" is not allowed; add it to browser-preview.allowedHosts in cordis.yml`)
  }
  return url
}

function optionalUrl(raw: unknown, allowedHosts: string[]): string | undefined {
  return raw === undefined || raw === null || String(raw).trim() === ''
    ? undefined
    : assertAllowedUrl(raw, allowedHosts).toString()
}

function elementTarget(args: any): ElementTarget {
  const uid = typeof args?.uid === 'string' && args.uid.trim() ? args.uid.trim() : undefined
  const selector = typeof args?.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined
  if (!uid && !selector) throw new Error('pass uid (from browser_snapshot) or selector')
  const button = args?.button === 'middle' || args?.button === 'right' ? args.button : undefined
  return { ...(uid ? { uid } : {}), ...(selector ? { selector } : {}), ...(button ? { button } : {}) }
}

function presetOf(preset: unknown, config: Config): PageView {
  if (preset === 'mobile') return { ...PRESETS.mobile }
  if (preset === 'tablet') return { ...PRESETS.tablet }
  return { width: config.width ?? 1_280, height: config.height ?? 800 }
}

function consoleLines(entries: ConsoleEntry[]): string[] {
  const problems = entries.filter(entry => entry.kind === 'error' || entry.kind === 'warning')
  if (!problems.length) return ['Console: clean']
  const errors = problems.filter(entry => entry.kind === 'error').length
  const warnings = problems.length - errors
  return [
    `Console: ${errors} error(s), ${warnings} warning(s)`,
    ...problems.slice(-MAX_CONSOLE).map(entry => `- ${entry.kind}: ${entry.text.replace(/\s+/g, ' ')}`),
    ...(problems.length > MAX_CONSOLE ? [`… ${problems.length - MAX_CONSOLE} more`] : []),
  ]
}

function stringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function slug(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).at(-1) ?? 'index'
  const cleaned = last.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return cleaned || 'index'
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

export const meta = {
  title: '浏览器预览',
  description: '用无头 Chrome 打开本地页面，截图、读取无障碍树并可点击/输入。',
}
