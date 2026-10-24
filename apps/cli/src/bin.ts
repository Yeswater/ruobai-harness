#!/usr/bin/env node
import { boot } from './boot.ts'

const harness = await boot({ configPath: process.argv[2] ?? 'cordis.yml' })

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
