import { pathToFileURL } from 'node:url'
import { Context } from '@ruobai/cordis'
import Loader from '@ruobai/cordis-plugin-loader'
import ConsoleExporter from '@ruobai/cordis-plugin-logger-console'

export interface BootOptions {
  /** Config path handed to Include; relative paths resolve against `cwd`. */
  configPath?: string
  /** Base URL for config and plugin resolution. Defaults to `process.cwd()`. */
  cwd?: string
}

export interface Harness {
  ctx: Context
  /** Unload every plugin the loader mounted, then settle. */
  dispose(): Promise<void>
}

/**
 * Boot a harness: one root Context, the Loader service, and an Include subtree
 * backed by `cordis.yml`. Everything above this line is the framework; the
 * application itself is entirely the config tree.
 */
export async function boot(options: BootOptions = {}): Promise<Harness> {
  const cwd = options.cwd ?? process.cwd()
  const configPath = options.configPath ?? 'cordis.yml'

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(cwd).href + '/'

  // Mounted before the loader so startup logs from config plugins are kept.
  await ctx.plugin(ConsoleExporter)

  const loader = ctx.plugin(Loader)
  await loader

  await ctx.loader.create({
    name: '@ruobai/cordis-plugin-include',
    config: { path: configPath },
  })
  await ctx.loader.await()

  return { ctx, dispose: () => loader.dispose() }
}
