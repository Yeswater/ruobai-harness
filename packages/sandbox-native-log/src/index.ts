import { spawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@ruobai/cordis'
import { parseLogRecord, type DenialService } from '@ruobai/sandbox-denial'

export interface Config {
  /** Unified-log predicate; only the Sandbox sender carries deny records. */
  predicate?: string
  /** Disable when the host denies log access; denials then degrade to stderr. */
  enabled?: boolean
  /** Path to the `log` binary. */
  logBin?: string
}

const LOG_BIN = '/usr/bin/log'

/**
 * Denial attribution probe.
 *
 * `sandbox-exec` gives the child nothing but "Operation not permitted"; the
 * operation and target only exist in the kernel's unified log. Without this
 * plugin denials still get classified, but with `confidence: 'low'`, which
 * makes escalation ask a human instead of auto-relaxing.
 *
 * The `log stream` child is itself a resource: killing it on unload is part of
 * the plugin's disposer, not an afterthought.
 */
export default class NativeLogProbe {
  static inject = ['denial']

  constructor(ctx: Context, config: Config = {}) {
    if (config.enabled === false || process.platform !== 'darwin') return

    const denial = ctx.get('denial') as DenialService
    const predicate = config.predicate ?? 'sender == "Sandbox"'
    const bin = config.logBin ?? LOG_BIN

    ctx.effect(() => {
      let child: ChildProcess | undefined
      let buffer = ''
      try {
        child = spawn(bin, ['stream', '--style', 'compact', '--level', 'error', '--predicate', predicate], {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch (error) {
        ctx.logger('sandbox').warn('log probe unavailable: %s', String(error))
        return () => undefined
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          const record = parseLogRecord(line)
          // The log is a system-wide broadcast: unattributed records (logd,
          // ecosystemd) must be dropped, which `classify` does by pid.
          if (record) denial.ingest(record)
          index = buffer.indexOf('\n')
        }
        if (buffer.length > 8_192) buffer = ''
      })
      child.on('error', (error) => {
        ctx.logger('sandbox').warn('log probe failed: %s', error.message)
      })

      return async () => {
        const running = child
        child = undefined
        if (!running) return
        running.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          if (running.exitCode !== null || running.signalCode !== null) return resolve()
          const timer = setTimeout(resolve, 500)
          running.once('close', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        running.stdout?.destroy()
      }
    }, 'sandbox.native-log')
  }
}

export const meta = {
  title: 'Seatbelt 日志探针',
  description: '从统一日志归因 Sandbox 拒绝（operation / target / pid）。',
}
