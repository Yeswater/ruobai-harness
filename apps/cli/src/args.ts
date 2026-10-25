export interface CliOptions {
  /** Path handed to the loader; relative paths resolve against the cwd. */
  configPath: string
  /** Overrides the web server port (0 picks a free port). */
  port?: number
  help: boolean
}

export const USAGE = 'Usage: pnpm dev [config.yml] [--port <port>]'

/**
 * `pnpm dev --port 4400`, `pnpm dev --port=4400` and a positional config path
 * all work; `--` is accepted so `pnpm dev -- --port 4400` reaches the script.
 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { configPath: 'cordis.yml', help: false }
  let configSeen = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--port') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--port needs a value')
      options.port = parsePort(value)
      index += 1
      continue
    }
    if (arg.startsWith('--port=')) {
      options.port = parsePort(arg.slice('--port='.length))
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    if (configSeen) throw new Error(`unexpected argument: ${arg}`)
    options.configPath = arg
    configSeen = true
  }

  return options
}

function parsePort(raw: string) {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid port: ${raw} (expected an integer from 0 to 65535)`)
  }
  return port
}
