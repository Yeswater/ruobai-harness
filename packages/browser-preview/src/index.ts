import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ToolDefinition, ToolRunContext } from '@ruobai/tools'
import { BrowserSession, findChrome, type ConsoleEntry } from './cdp.ts'

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
}

const DEFAULT_HOSTS = ['127.0.0.1', 'localhost', '::1']
const MAX_EXPRESSION = 20_000
const MAX_RESULT_CHARS = 8_000
const MAX_CONSOLE = 8

/**
 * Screenshot and DOM measurement for the running app.
 *
 * Each call launches its own headless Chrome with an isolated profile and
 * closes it afterwards; navigation is limited to loopback by default, so this
 * observes the local UI without opening a network egress path.
 */
export class BrowserPreviewService {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly config: {
      timeoutMs: number
      waitMs: number
      width: number
      height: number
      screenshotsDir?: string
    },
    readonly chromePath: string | undefined,
  ) {}

  /** One browser at a time; concurrent calls would spawn several Chromes. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  open(options: {
    width?: number
    height?: number
    colorScheme?: 'light' | 'dark'
  }): Promise<BrowserSession> {
    if (!this.chromePath) {
      throw new Error(
        'headless Chrome was not found. Install Chrome/Chromium or set browser-preview.chromePath in cordis.yml.',
      )
    }
    return BrowserSession.open({
      chromePath: this.chromePath,
      timeoutMs: this.config.timeoutMs,
      waitMs: this.config.waitMs,
      width: bounded(options.width, this.config.width, 200, 3_840),
      height: bounded(options.height, this.config.height, 200, 2_400),
      ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
    })
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
    ...(config.screenshotsDir ? { screenshotsDir: config.screenshotsDir } : {}),
  }, findChrome(config.chromePath))

  const allowedHosts = config.allowedHosts?.length ? config.allowedHosts : DEFAULT_HOSTS
  const definitions = [screenshotTool(service, allowedHosts, config), evalTool(service, allowedHosts, config)]

  ctx.effect(() => {
    const disposers = definitions.map(definition => ctx.tools.register(definition))
    return () => disposers.forEach(dispose => dispose())
  }, 'ctx.tools.register(browser)')
}

export default { name, inject, apply }

function screenshotTool(
  service: BrowserPreviewService,
  allowedHosts: string[],
  config: Config,
): ToolDefinition {
  return {
    name: 'browser_screenshot',
    description: [
      'Render a local URL in headless Chrome and save a PNG under .ruobai/screenshots/.',
      'Returns the path, page title, size and console errors/warnings.',
      'Only loopback hosts are allowed unless browser-preview.allowedHosts lists more.',
      'Use it to verify visual changes in light/dark mode and at different widths.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL, e.g. http://127.0.0.1:4310' },
        width: { type: 'number', description: 'Viewport width in CSS pixels; default 1280.' },
        height: { type: 'number', description: 'Viewport height in CSS pixels; default 800.' },
        colorScheme: { type: 'string', enum: ['light', 'dark'], description: 'Emulate prefers-color-scheme.' },
        fullPage: { type: 'boolean', description: 'Capture the whole page (height capped at 4000px).' },
      },
      required: ['url'],
    },
    async execute(args, run) {
      const url = assertAllowedUrl(args?.url, allowedHosts)
      const width = bounded(args?.width, config.width ?? 1_280, 200, 3_840)
      const height = bounded(args?.height, config.height ?? 800, 200, 2_400)
      return service.exclusive(async () => {
        const session = await service.open({
          width,
          height,
          ...(args?.colorScheme === 'dark' ? { colorScheme: 'dark' as const } : {}),
          ...(args?.colorScheme === 'light' ? { colorScheme: 'light' as const } : {}),
        })
        try {
          const page = await session.navigate(url.toString())
          const png = await session.screenshot(args?.fullPage === true)
          const dir = service.screenshotDir(run)
          await mkdir(dir, { recursive: true })
          const file = resolve(dir, `${timestamp()}-${slug(url)}.png`)
          await writeFile(file, png)
          const root = run?.workspace ? resolve(run.workspace) : process.cwd()
          const shown = relative(root, file).split('\\').join('/')
          return [
            `Screenshot: ${shown} (${width}x${height}${args?.colorScheme ? `, ${args.colorScheme}` : ''})`,
            `Title: ${page.title || '(none)'}`,
            `URL: ${page.url}`,
            ...consoleLines(session.consoleMessages()),
          ].join('\n')
        } finally {
          await session.close()
        }
      })
    },
  }
}

function evalTool(service: BrowserPreviewService, allowedHosts: string[], config: Config): ToolDefinition {
  return {
    name: 'browser_eval',
    description: [
      'Open a local URL in headless Chrome and evaluate one JavaScript expression in the page.',
      'Returns the JSON value plus console errors; use it for computed styles, element sizes,',
      'scrollWidth overflow checks and prefers-color-scheme assertions.',
      'Only loopback hosts are allowed unless browser-preview.allowedHosts lists more.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL, e.g. http://127.0.0.1:4310' },
        expression: {
          type: 'string',
          description: 'Expression evaluated after load; wrap multi-step work in an IIFE. Max 20k characters.',
        },
        width: { type: 'number', description: 'Viewport width in CSS pixels; default 1280.' },
        height: { type: 'number', description: 'Viewport height in CSS pixels; default 800.' },
        colorScheme: { type: 'string', enum: ['light', 'dark'], description: 'Emulate prefers-color-scheme.' },
      },
      required: ['url', 'expression'],
    },
    async execute(args, run) {
      const url = assertAllowedUrl(args?.url, allowedHosts)
      const expression = String(args?.expression ?? '').trim()
      if (!expression) throw new Error('expression is required')
      if (expression.length > MAX_EXPRESSION) throw new Error(`expression is longer than ${MAX_EXPRESSION} characters`)

      const width = bounded(args?.width, config.width ?? 1_280, 200, 3_840)
      const height = bounded(args?.height, config.height ?? 800, 200, 2_400)
      return service.exclusive(async () => {
        const session = await service.open({
          width,
          height,
          ...(args?.colorScheme === 'dark' ? { colorScheme: 'dark' as const } : {}),
          ...(args?.colorScheme === 'light' ? { colorScheme: 'light' as const } : {}),
        })
        try {
          const page = await session.navigate(url.toString())
          const value = await session.evaluate(expression)
          const rendered = stringify(value)
          return [
            rendered.length > MAX_RESULT_CHARS
              ? `${rendered.slice(0, MAX_RESULT_CHARS)}\n… result truncated (${rendered.length} chars)`
              : rendered,
            '',
            `[page: ${page.title || '(untitled)'} · ${page.url} · ${width}x${height}`
              + `${args?.colorScheme ? ` · ${args.colorScheme}` : ''}]`,
            ...consoleLines(session.consoleMessages()),
          ].join('\n')
        } finally {
          await session.close()
        }
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

function consoleLines(entries: ConsoleEntry[]): string[] {
  if (!entries.length) return ['Console: clean']
  const errors = entries.filter(entry => entry.kind === 'error').length
  const warnings = entries.length - errors
  return [
    `Console: ${errors} error(s), ${warnings} warning(s)`,
    ...entries.slice(0, MAX_CONSOLE).map(entry => `- ${entry.kind}: ${entry.text.replace(/\s+/g, ' ')}`),
    ...(entries.length > MAX_CONSOLE ? [`… ${entries.length - MAX_CONSOLE} more`] : []),
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
  description: '用无头 Chrome 截图并读取页面样式，用于验收视觉改动。',
}
