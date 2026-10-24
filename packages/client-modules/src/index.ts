import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@ruobai/cordis'
import { build } from 'esbuild'
import { sendJson } from '@ruobai/web-server'
import type {} from '@ruobai/cordis-plugin-loader'

export const name = 'client-modules'
export const inject = ['web', 'loader']

interface Discovered {
  id: string
  name: string
  entry: string
}

const bundles = new Map<string, { mtime: number; code: string }>()

/**
 * Serves client halves of plugins declared via `"rbu": { "client": "..." }`
 * in package.json. Bundles are built on demand with esbuild and cached by
 * mtime; React is injected from the host runtime at `globalThis.__RBU__`.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    exact: '/api/client-plugins',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return true
      }
      try {
        const plugins = await discover(ctx)
        sendJson(res, 200, {
          plugins: plugins.map(plugin => ({
            id: plugin.id,
            url: `/plugins/${encodeURIComponent(plugin.id)}/client.js`,
          })),
        })
      } catch (error) {
        ctx.logger('client-modules').error(error)
        sendJson(res, 500, { error: 'failed to discover client plugins' })
      }
      return true
    },
  }), 'client-modules.manifest')

  ctx.effect(() => ctx.web.register({
    prefix: '/plugins',
    handler: async (req, res, url) => {
      const match = /^\/plugins\/([^/]+)\/client\.js$/.exec(url.pathname)
      if (!match) return false
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' })
        return true
      }

      try {
        const id = decodeURIComponent(match[1]!)
        const plugin = (await discover(ctx)).find(item => item.id === id)
        if (!plugin) {
          sendJson(res, 404, { error: 'client plugin not found' })
          return true
        }
        const code = await bundle(plugin.entry)
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(code)
      } catch (error) {
        ctx.logger('client-modules').error(error)
        sendJson(res, 500, { error: 'failed to build client plugin' })
      }
      return true
    },
  }), 'client-modules.bundle')
}

export default { name, inject, apply }

async function discover(ctx: Context): Promise<Discovered[]> {
  const found: Discovered[] = []
  for (const entry of ctx.loader.entries()) {
    const options = entry.options
    if (!options?.name || options.disabled) continue
    if (options.name.startsWith('.') || options.name.startsWith('/')) continue
    const client = await clientEntry(options.name)
    if (client) found.push({ id: options.id, name: options.name, entry: client })
  }
  return found
}

const require = createRequire(import.meta.url)

async function clientEntry(name: string): Promise<string | undefined> {
  let resolved: string
  try {
    resolved = require.resolve(name)
  } catch {
    return
  }

  let dir = dirname(resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved)
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (manifest.name === name) {
        const client = manifest.rbu?.client
        return typeof client === 'string' ? resolve(dir, client) : undefined
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

async function bundle(entry: string): Promise<string> {
  const info = await stat(entry)
  const cached = bundles.get(entry)
  if (cached && cached.mtime === info.mtimeMs) return cached.code

  const shim = fileURLToPath(new URL('../shim.js', import.meta.url))
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    inject: [shim],
    // The repo root tsconfig uses the automatic runtime for the app; client
    // bundles must use the classic runtime so the injected React shim works.
    tsconfigRaw: {
      compilerOptions: {
        jsx: 'react',
        jsxFactory: 'React.createElement',
        jsxFragmentFactory: 'React.Fragment',
      },
    },
    logLevel: 'silent',
    legalComments: 'none',
  })

  const code = result.outputFiles[0]?.text ?? 'export default () => {}'
  bundles.set(entry, { mtime: info.mtimeMs, code })
  return code
}

export const meta = {
  title: '客户端模块',
  description: '打包并加载客户端插件。',
}
