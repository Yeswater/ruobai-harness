#!/usr/bin/env node
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

const harness = await boot({ configPath: options.configPath })

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
