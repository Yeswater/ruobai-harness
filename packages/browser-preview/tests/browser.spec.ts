import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import BrowserPreview, { assertAllowedUrl } from '@ruobai/browser-preview'
import { Context } from '@ruobai/cordis'
import ToolRegistry from '@ruobai/tools'
import { findChrome } from '../src/cdp.ts'

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

describe.skipIf(!chrome)('browser preview: headless Chrome', () => {
  async function fixture(extra: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'rbh-browser-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
<html>
  <head>
    <title>fixture</title>
    <style>:root { --brand: #c96442; } body { margin: 0; background: #f7f7f5; }</style>
  </head>
  <body>
    <h1 id="title">hello</h1>
    <script>console.error('fixture boom')</script>
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
})
