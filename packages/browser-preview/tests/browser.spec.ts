import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import BrowserPreview, { assertAllowedUrl, BrowserPreviewService, type BrowserCastEvent } from '@ruobai/browser-preview'
import Preview from '@ruobai/preview'
import { Context } from '@ruobai/cordis'
import ToolRegistry from '@ruobai/tools'
import { findChrome, flattenAxTree, formatNetwork } from '../src/cdp.ts'

const cleanups: Array<() => Promise<void> | void> = []
const chrome = findChrome()

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('browser preview: url policy', () => {
  it('only allows http(s) on the configured hosts', () => {
    expect(assertAllowedUrl('http://127.0.0.1:4310', ['127.0.0.1']).port).toBe('4310')
    expect(assertAllowedUrl('http://[::1]:4310', ['::1']).hostname).toBe('[::1]')
    expect(() => assertAllowedUrl('http://example.com', ['127.0.0.1'])).toThrow(/not allowed/)
    expect(() => assertAllowedUrl('file:///etc/passwd', ['127.0.0.1'])).toThrow(/http\(s\)/)
    expect(() => assertAllowedUrl('not a url', ['127.0.0.1'])).toThrow(/invalid url/)
  })
})

describe('browser preview: snapshot and network shaping', () => {
  it('flattens the accessibility tree into uid lines', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'fixture' }, backendDOMNodeId: 1 },
      { nodeId: '2', parentId: '1', role: { value: 'generic' }, ignored: true },
      { nodeId: '3', parentId: '2', role: { value: 'button' }, name: { value: '增加' }, backendDOMNodeId: 42 },
      {
        nodeId: '4',
        parentId: '1',
        role: { value: 'textbox' },
        name: { value: '名字' },
        value: { value: '张三' },
        backendDOMNodeId: 7,
        properties: [{ name: 'disabled', value: { value: true } }],
      },
      { nodeId: '5', parentId: '1', role: { value: 'InlineTextBox' }, name: { value: 'noise' } },
    ]
    const { entries, truncated } = flattenAxTree(nodes as never)
    expect(truncated).toBe(false)
    expect(entries).toEqual([
      { uid: 'n1', role: 'RootWebArea', name: 'fixture', states: [], depth: 0 },
      { uid: 'n42', role: 'button', name: '增加', states: [], depth: 1 },
      { uid: 'n7', role: 'textbox', name: '名字', value: '张三', states: ['disabled'], depth: 1 },
    ])
  })

  it('lists failed requests only when asked', () => {
    const entries = [
      { id: '1', url: 'http://x/api/data', method: 'GET', type: 'Fetch', status: 200, at: 1 },
      { id: '2', url: 'http://x/api/fail', method: 'GET', type: 'Fetch', status: 500, at: 2 },
      { id: '3', url: 'http://x/api/abort', method: 'GET', type: 'Fetch', failed: 'net::ERR_ABORTED', at: 3 },
    ]
    expect(formatNetwork(entries)).toContain('1 GET 200 Fetch http://x/api/data')
    const failed = formatNetwork(entries, 'failed')
    expect(failed).toContain('2 GET 500 Fetch http://x/api/fail')
    expect(failed).toContain('FAILED net::ERR_ABORTED')
    expect(failed).not.toContain('/api/data')
  })
})

describe.skipIf(!chrome)('browser preview: headless Chrome', () => {
  async function fixture(extra: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'rbh-browser-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/api/data')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
  <head>
    <title>fixture</title>
    <style>:root { --brand: #c96442; } body { margin: 0; background: #f7f7f5; }</style>
  </head>
  <body>
    <h1 id="title">hello</h1>
    <button id="inc">增加</button><span id="count">0</span>
    <label>名字 <input id="name"></label>
    <script>
      console.error('fixture boom')
      console.log('fixture log')
      document.querySelector('#inc').addEventListener('click', () => {
        const el = document.querySelector('#count')
        el.textContent = String(Number(el.textContent) + 1)
      })
      fetch('/api/data').then(r => r.json()).then(d => console.log('data', d.ok))
    </script>
  </body>
</html>`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

    const ctx = new Context()
    const tools = ctx.plugin(ToolRegistry)
    await tools
    const plugin = ctx.plugin(BrowserPreview, { width: 640, height: 480, waitMs: 50, sendImages: 'always', ...extra })
    await plugin
    cleanups.push(() => plugin.dispose(), () => tools.dispose())
    return { ctx, root, url }
  }

  it('evaluates an expression with an emulated colour scheme', async () => {
    const { ctx, root, url } = await fixture()
    const result = await ctx.tools.invoke('browser_eval', {
      url,
      colorScheme: 'dark',
      expression: `({
        title: document.title,
        brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
        width: innerWidth,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
      })`,
    }, { workspace: root })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('"title": "fixture"')
    expect(result.content).toContain('"brand": "#c96442"')
    expect(result.content).toContain('"width": 640')
    expect(result.content).toContain('"dark": true')
    // Console errors are part of the report: a clean screenshot can still have
    // a broken page.
    expect(result.content).toContain('Console: 1 error(s)')
    expect(result.content).toContain('fixture boom')
  }, 30_000)

  it('can opt out of attaching the image', async () => {
    const { ctx, root, url } = await fixture({ sendImages: 'never' })
    const result = await ctx.tools.invoke('browser_screenshot', { url }, { workspace: root })
    expect(result.isError).toBe(false)
    expect(result.images).toBeUndefined()
    expect(result.content).toContain('not attached')
  }, 30_000)

  it('writes a PNG and rejects non-loopback hosts', async () => {
    const { ctx, root, url } = await fixture()
    const result = await ctx.tools.invoke('browser_screenshot', { url, colorScheme: 'light' }, { workspace: root })
    expect(result.isError).toBe(false)

    const shown = /Screenshot: (\S+)/.exec(result.content)?.[1]
    expect(shown).toMatch(/^\.ruobai\/screenshots\/.+\.png$/)
    const png = await readFile(join(root, shown!))
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(result.content).toContain('Title: fixture')
    expect(result.images?.[0]).toMatchObject({ mimeType: 'image/png' })
    expect(Buffer.from(result.images![0]!.data, 'base64').subarray(1, 4).toString()).toBe('PNG')

    const denied = await ctx.tools.invoke('browser_screenshot', { url: 'http://example.com' }, { workspace: root })
    expect(denied.isError).toBe(true)
    expect(denied.content).toContain('not allowed')
  }, 30_000)

  it('keeps one page across calls: snapshot, click, fill, console, network, resize', async () => {
    const { ctx, root, url } = await fixture()
    const open = await ctx.tools.invoke('browser_open', { url }, { workspace: root })
    expect(open.isError).toBe(false)
    expect(open.content).toContain('page:')

    const snapshot = await ctx.tools.invoke('browser_snapshot', {}, { workspace: root })
    expect(snapshot.isError).toBe(false)
    const uid = /uid=(\S+) button "增加"/.exec(snapshot.content)?.[1]
    expect(uid).toMatch(/^n\d+$/)
    const inputUid = /uid=(\S+) textbox "名字"/.exec(snapshot.content)?.[1]
    expect(inputUid).toMatch(/^n\d+$/)

    const clicked = await ctx.tools.invoke('browser_click', { uid }, { workspace: root })
    expect(clicked.isError).toBe(false)
    expect(clicked.content).toContain('Clicked')
    const count = await ctx.tools.invoke('browser_eval', {
      expression: `document.querySelector('#count').textContent`,
    }, { workspace: root })
    expect(count.content).toContain('"1"')

    const filled = await ctx.tools.invoke('browser_fill', { uid: inputUid, value: '张三' }, { workspace: root })
    expect(filled.isError).toBe(false)
    const value = await ctx.tools.invoke('browser_eval', {
      expression: `document.querySelector('#name').value`,
    }, { workspace: root })
    expect(value.content).toContain('"张三"')

    const network = await ctx.tools.invoke('browser_network', {}, { workspace: root })
    expect(network.isError).toBe(false)
    expect(network.content).toContain('/api/data')
    expect(network.content).toMatch(/200/)

    const console = await ctx.tools.invoke('browser_console', {}, { workspace: root })
    expect(console.isError).toBe(false)
    expect(console.content).toContain('fixture log')
    expect(console.content).toContain('fixture boom')

    const resized = await ctx.tools.invoke('browser_resize', { preset: 'mobile' }, { workspace: root })
    expect(resized.isError).toBe(false)
    expect(resized.content).toContain('375x812')

    const closed = await ctx.tools.invoke('browser_close', {}, { workspace: root })
    expect(closed.isError).toBe(false)
    expect(closed.content).toContain('Closed 1 page(s).')
  }, 45_000)

  it('opens the page of a running preview configuration by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-browser-preview-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, '.ruobai'), { recursive: true })
    const script = "const http=require('node:http');const port=Number(process.env.PORT||0);"
      + "http.createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html'});"
      + "s.end('<title>preview-fixture</title><h1>up</h1>')}).listen(port,'127.0.0.1')"
    await writeFile(join(root, '.ruobai/launch.json'), JSON.stringify({
      version: '0.0.1',
      configurations: [{ name: 'app', runtimeExecutable: process.execPath, runtimeArgs: ['-e', script], port: 0 }],
    }))

    const ctx = new Context()
    const tools = ctx.plugin(ToolRegistry)
    await tools
    const preview = ctx.plugin(Preview, { root, startTimeoutMs: 10_000 })
    await preview
    const browser = ctx.plugin(BrowserPreview, { width: 320, height: 240, waitMs: 50, sendImages: 'never' })
    await browser
    cleanups.push(() => browser.dispose(), () => preview.dispose(), () => tools.dispose())

    const state = await ctx.preview.start('app')
    expect(state.status).toBe('running')
    const result = await ctx.tools.invoke('browser_open', { preview: 'app' }, { workspace: root })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('preview-fixture')

    const stopped = await ctx.tools.invoke('browser_open', { preview: 'missing' }, { workspace: root })
    expect(stopped.isError).toBe(true)
    expect(stopped.content).toContain('unknown preview configuration')
  }, 30_000)

  it('broadcasts the page it drives: open, frames and close', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      // A repainting page: the screencast only emits on compositor frames.
      res.end('<!doctype html><title>cast</title>'
        + '<style>@keyframes m{from{opacity:.3}to{opacity:1}}'
        + 'div{animation:m 200ms infinite alternate;width:60px;height:60px;background:#c96442}</style>'
        + '<body><h1>cast</h1><div></div></body>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

    const events: BrowserCastEvent[] = []
    const service = new BrowserPreviewService({
      timeoutMs: 15_000,
      waitMs: 50,
      width: 320,
      height: 240,
      idleMs: 60_000,
      maxPages: 2,
    }, chrome, event => events.push(event))
    cleanups.push(() => service.closeAll())

    const entry = await service.acquire(undefined, url, { width: 320, height: 240 })
    expect(events[0]).toMatchObject({ kind: 'open', url, fresh: true, sessionId: '' })
    const deadline = Date.now() + 5_000
    while (!events.some(event => event.kind === 'frame') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const frame = events.find(event => event.kind === 'frame')
    expect(frame?.data?.length).toBeGreaterThan(100)
    expect(frame?.url).toBe(url)
    expect(entry.session.url()).toBe(url)

    await service.closeAll()
    expect(events.at(-1)).toMatchObject({ kind: 'close', url })
  }, 30_000)
})
