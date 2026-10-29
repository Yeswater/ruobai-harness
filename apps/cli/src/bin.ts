#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot } from './boot.ts'
import { parseArgs, USAGE, type CliOptions } from './args.ts'

let options: CliOptions
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`[ruobai-harness] ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
  process.exit(1)
}

if (options.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

// A separate config file may not read PORT, but the shipped cordis.yml does.
if (options.port !== undefined) process.env.PORT = String(options.port)

// Resolve the config before switching directories: `--workspace` changes the
// cwd so plugin roots (`process.cwd()` in cordis.yml) point at the workspace,
// while the application definition still comes from the harness checkout.
const configPath = pathToFileURL(resolve(options.configPath)).href

if (options.workspace) {
  const workspace = resolve(options.workspace)
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    process.stderr.write(`[ruobai-harness] not a directory: ${workspace}\n`)
    process.exit(1)
  }
  process.chdir(workspace)
}

const harness = await boot({ configPath })

const web = harness.ctx.get('web', false) as { url?: string } | undefined
if (web?.url) process.stdout.write(`[ruobai-harness] ui: ${web.url}\n`)

let closing = false
async function shutdown(signal: string) {
  if (closing) return
  closing = true
  await harness.dispose()
  process.stdout.write(`[ruobai-harness] ${signal}: stopped\n`)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.stdout.write('[ruobai-harness] started\n')
