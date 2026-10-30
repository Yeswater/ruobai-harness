import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { WebHandler } from '@ruobai/web-server'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/** Serve a built SPA with an index.html fallback and traversal protection. */
export function createStaticHandler(distRoot: string): WebHandler {
  const root = resolve(distRoot)
  const index = join(root, 'index.html')

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return true
    }

    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (pathname.split(/[\\/]/).includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden')
      return true
    }

    const candidate = resolve(join(root, normalize(pathname)))
    const inside = candidate === root || candidate.startsWith(root + sep)
    if (!inside) {
      res.writeHead(403).end('forbidden')
      return true
    }

    const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : index
    if (!existsSync(file)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ui-app is not built. Run `pnpm build:ui`, or start with dev mode enabled.')
      return true
    }

    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    if (req.method === 'HEAD') {
      res.end()
      return true
    }
    createReadStream(file).pipe(res)
    return true
  }
}

export interface Config {
  /** ui-app directory; defaults to the sibling package. */
  root?: string
  /** Proxy Vite (HMR) instead of serving `dist`. */
  dev?: boolean
}

export const name = 'web-static'
export const inject = ['web']

export const Config: z<Config> = z.object({
  root: z.string(),
  dev: z.boolean().default(true),
})

export async function apply(ctx: Context, config: Config) {
  // A packaged desktop ships the UI beside the deployed runtime, not in the
  // repository's sibling package; the launcher points here.
  const root = config.root ?? process.env.RUOBAI_UI_ROOT ?? fileURLToPath(new URL('../../ui-app/', import.meta.url))
  const serveDist = createStaticHandler(join(root, 'dist'))

  let vite: import('vite').ViteDevServer | undefined
  let failure: unknown

  // Register the fallback before Vite finishes; early requests wait instead of
  // falling through to a 404 during startup.
  const ready = (async () => {
    if (!(config.dev ?? true)) return
    try {
      const { createServer } = await import('vite')
      const server = ctx.web.httpServer
      if (!server) throw new Error('web-server is not listening')
      const host = ctx.web.config.host ?? '127.0.0.1'
      const port = Number(new URL(ctx.web.url).port)
      vite = await createServer({
        root,
        appType: 'spa',
        logLevel: 'warn',
        server: {
          middlewareMode: true,
          hmr: {
            server,
            ...(host === '0.0.0.0' || host === '::' ? {} : { host }),
            ...(Number.isFinite(port) && port ? { clientPort: port } : {}),
          },
        },
      })
    } catch (error) {
      failure = error
      ctx.logger('web-static').error(error)
    }
  })()

  ctx.effect(() => () => {
    void vite?.close()
  }, 'web-static.vite')

  ctx.effect(() => ctx.web.setFallback(async (req, res, url) => {
    await ready
    if (failure) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ui dev server failed to start')
      return true
    }
    if (vite) {
      vite.middlewares(req, res, () => {
        if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found')
      })
      return true
    }
    return serveDist(req, res, url)
  }), 'web-static.fallback')
}

export default { name, inject, Config, apply }

export const meta = {
  title: '静态资源',
  description: '提供浏览器 UI 的静态文件。',
}
