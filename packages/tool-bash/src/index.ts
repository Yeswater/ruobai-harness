import { relative, resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ToolDefinition, ToolRunContext } from '@ruobai/tools'
import type {} from '@ruobai/shell'

export interface Config {
  /** Directory commands are confined to. Defaults to the process cwd. */
  root?: string
  /** Default per-command timeout. */
  timeoutMs?: number
  /** Upper bound a model may request via the tool's `timeoutMs`. */
  maxTimeoutMs?: number
  /** Bytes captured per stream before truncating. */
  maxOutputBytes?: number
}

const MAX_COMMAND_LENGTH = 32_000

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

function resolveCwd(root: string, cwd: unknown) {
  const target = resolve(root, typeof cwd === 'string' && cwd ? cwd : '.')
  if (!inside(root, target)) throw new Error(`cwd escapes the workspace: ${String(cwd)}`)
  return target
}

function commandOf(args: any) {
  const command = typeof args?.command === 'string' ? args.command.trim() : ''
  if (!command) throw new Error('command is required')
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(
      `command is longer than ${MAX_COMMAND_LENGTH} characters; split it into smaller steps, `
        + 'or use write_file/edit_file for large content',
    )
  }
  return command
}

function previewOf(command: string, cwd: string, root: string) {
  const lines = command.split('\n')
  const shown = lines.slice(0, 40).map((line, index) => index === 0 ? `$ ${line}` : `  ${line}`)
  if (lines.length > 40) shown.push('  …')
  const target = relative(root, cwd)
  return {
    summary: `${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''}${target ? ` · in ${target}` : ''}`,
    diff: shown.join('\n'),
  }
}

interface ResolvedConfig {
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
}

function bashTool(ctx: Context, fallbackRoot: string, config: ResolvedConfig): ToolDefinition {
  const rootFor = (run?: ToolRunContext) => run?.workspace ? resolve(run.workspace) : fallbackRoot

  return {
    name: 'bash',
    description: [
      'Run a shell command in the workspace and return its output.',
      'Use this to run commands, builds, tests and git; use read_file, list_dir, grep and glob to inspect workspace files instead of cat/sed/head/tail/grep/find.',
      'Keep one purpose per call: do not chain unrelated commands with && or ;.',
      'The working directory is confined to the workspace, a timeout kills the process group,',
      'output is truncated, and harness credentials are stripped from the environment.',
      'Commands run inside the OS sandbox; a sandbox denial comes back as a structured [sandbox] block.',
      'Do not retry a denial with a different command or path; report it and ask the user.',
      'For a dev server: check it is not already running, log under .ruobai/scratch, use a short wait, and stop it when done.',
      'Requires user approval.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        description: {
          type: 'string',
          description: 'Short action title shown in the transcript, e.g. "查看过程组样式" (max 8 words).',
        },
        cwd: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root.' },
        timeoutMs: { type: 'number', description: `Timeout in milliseconds (max ${config.maxTimeoutMs}).` },
      },
      required: ['command'],
    },
    requiresApproval: true,
    approvalSubject(args) {
      return { kind: 'command', value: commandOf(args) }
    },
    preview(args, run) {
      const root = rootFor(run)
      const command = commandOf(args)
      return previewOf(command, resolveCwd(root, args?.cwd), root)
    },
    /**
     * Delegates to `ctx.shell`, so switching between the sandboxed and the
     * direct executor is a `cordis.yml` edit. No executor means no execution:
     * the tool layer never spawns a shell itself.
     */
    async execute(args, toolRun: ToolRunContext) {
      const root = rootFor(toolRun)
      const command = commandOf(args)
      const cwd = resolveCwd(root, args?.cwd)
      const requested = typeof args?.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.floor(args.timeoutMs)
        : config.timeoutMs
      const timeoutMs = Math.min(Math.max(requested, 1), config.maxTimeoutMs)

      const result = await ctx.shell.run({
        command,
        cwd,
        root,
        timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        sessionId: toolRun.sessionId,
        signal: toolRun.signal,
      })
      return result.content
    },
  }
}

/** Shell execution with approval, workspace confinement, timeouts and output caps. */
export default class BashTools {
  static inject = ['tools', 'shell']

  static Config: z<Config> = z.object({
    root: z.string().default('.'),
    timeoutMs: z.number().min(1).default(120_000),
    maxTimeoutMs: z.number().min(1).default(600_000),
    maxOutputBytes: z.number().min(1).default(32_768),
  })

  constructor(ctx: Context, config: Config) {
    const root = resolve(config.root ?? '.')
    const resolved: ResolvedConfig = {
      timeoutMs: config.timeoutMs ?? 120_000,
      maxTimeoutMs: config.maxTimeoutMs ?? 600_000,
      maxOutputBytes: config.maxOutputBytes ?? 32_768,
    }

    ctx.effect(() => {
      const dispose = ctx.tools.register(bashTool(ctx, root, resolved))
      return () => dispose()
    }, 'ctx.tools.register(bash)')
  }
}

export { inside, resolveCwd }

export const meta = {
  title: 'Shell 工具',
  description: '在工作区内执行终端命令（经 ctx.shell，默认沙箱化）。',
}
