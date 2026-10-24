import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'
import * as WebStatic from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('web static', () => {
  it('serves built assets with an SPA fallback and blocks traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-ui-'))
    await mkdir(join(root, 'dist', 'assets'), { recursive: true })
    await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><div id="root">ok</div>')
    await writeFile(join(root, 'dist', 'assets', 'app.js'), 'console.log("app")')

    const harness = await createHarness()
    cleanups.push(() => rm(root, { recursive: true, force: true }), () => harness.dispose())

    const fiber = harness.ctx.plugin(WebStatic, { root, dev: false })
    await fiber
    cleanups.push(() => fiber.dispose())

    const index = await fetch(`${harness.ctx.web.url}/sessions/unknown`)
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('id="root"')

    const asset = await fetch(`${harness.ctx.web.url}/assets/app.js`)
    expect(asset.headers.get('content-type')).toContain('text/javascript')

    const traversal = await fetch(`${harness.ctx.web.url}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    expect(traversal.status).toBe(403)
  })
})
