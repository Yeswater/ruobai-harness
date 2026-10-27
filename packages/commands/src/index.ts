import { Service, type Context } from '@ruobai/cordis'
import type {} from '@ruobai/session'

export interface CommandInvocation {
  sessionId: string
  /** Command name without the leading slash. */
  name: string
  /** Everything after the name, trimmed. */
  args: string
  raw: string
}

export interface CommandDefinition {
  /** Lowercase slug, matched against `/name`. */
  name: string
  description: string
  usage?: string
  run(invocation: CommandInvocation): Promise<string> | string
}

declare module '@ruobai/cordis' {
  interface Context {
    commands: CommandService
  }

  interface Events {
    'command/invoke'(sessionId: string, name: string): void
  }
}

const COMMAND = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/

/**
 * User-invoked slash commands.
 *
 * Commands are a maintenance gesture: the agent runs one and ends the turn
 * without a model call. They are not tools — nothing the model emits can reach
 * a command, and every command runs on the host side with the user's intent.
 */
export class CommandService extends Service {
  static inject = ['sessions']

  private readonly commands = new Map<string, CommandDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  register(definition: CommandDefinition): () => void {
    const name = definition.name.toLowerCase()
    if (this.commands.has(name)) throw new Error(`command "/${name}" is already registered`)
    const registered = { ...definition, name }
    this.commands.set(name, registered)
    return () => {
      if (this.commands.get(name) !== registered) return
      this.commands.delete(name)
    }
  }

  get(name: string) {
    return this.commands.get(name.toLowerCase())
  }

  list() {
    return [...this.commands.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Parse the latest user message; run it when it names a registered command. */
  async dispatch(sessionId: string): Promise<boolean> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return false
    const lastUser = [...record.events].reverse().find(event =>
      event.type === 'message/user' && !event.data?.source?.kind)
    if (!lastUser) return false
    const raw = String(lastUser.data?.text ?? '').trim()
    const match = COMMAND.exec(raw)
    if (!match) return false
    const command = this.get(match[1]!)
    if (!command) return false

    const invocation: CommandInvocation = {
      sessionId,
      name: command.name,
      args: (match[2] ?? '').trim(),
      raw,
    }
    this.ctx.emit('command/invoke', sessionId, command.name)
    let message: string
    try {
      message = (await command.run(invocation)).trim()
    } catch (error) {
      message = `/${command.name} 失败：${error instanceof Error ? error.message : String(error)}`
    }
    this.ctx.sessions.append(sessionId, 'turn/notice', {
      kind: 'command',
      command: command.name,
      ...(message ? { message } : {}),
    })
    return true
  }
}

export default CommandService

export const meta = {
  title: '命令',
  description: '注册并分发用户输入的斜杠命令。',
}
