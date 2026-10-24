import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import Loader from '@ruobai/cordis-plugin-loader'
import WebServer from '@ruobai/web-server'
import ClientModules from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('client modules', () => {
  it('discovers and bundles a plugin client half', async () => {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

    const loader = ctx.plugin(Loader)
    await loader
    cleanups.push(() => loader.dispose())

    const id = await ctx.loader.create({ name: '@ruobai/plugin-welcome' })
    await ctx.loader.await()

    const web = ctx.plugin(WebServer, { port: 0 })
    await web
    cleanups.push(() => web.dispose())

    const modules = ctx.plugin(ClientModules)
    await modules
    cleanups.push(() => modules.dispose())

    const manifestResponse = await fetch(`${ctx.web.url}/api/client-plugins`)
    const manifestText = await manifestResponse.text()
    expect(manifestText).toContain('"plugins"')
    const manifest = JSON.parse(manifestText) as {
      plugins: Array<{ id: string; url: string }>
    }
    expect(manifest.plugins).toEqual([{ id, url: `/plugins/${encodeURIComponent(id)}/client.js` }])

    const response = await fetch(`${ctx.web.url}/plugins/${encodeURIComponent(id)}/client.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    const code = await response.text()
    expect(code).toContain('client plugin')
    expect(code).toContain('__RBU__')
  })
})
