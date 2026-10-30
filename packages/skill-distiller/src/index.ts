import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { SessionEvent } from '@ruobai/session'
import type {} from '@ruobai/session'

export interface Config {
  /** Off by default: distillation spends background time on every long session. */
  enabled?: boolean
  /** Quiet time after the last event before a draft is produced. */
  idleMs?: number
  /** Fewest user turns worth of work before a draft is worth producing. */
  minTurns?: number
  /** Minimum gap between two drafts for the same session. */
  minIntervalMs?: number
  /** Draft directory, relative to the workspace. Never a skill root. */
  draftsRoot?: string
  /** Cap per day across all sessions; 0 disables the cap. */
  dailyDrafts?: number
}

export const name = 'skill-distiller'
export const inject = ['sessions']

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  idleMs: z.number().min(1).default(600_000),
  minTurns: z.number().min(1).default(2),
  minIntervalMs: z.number().min(0).default(3_600_000),
  draftsRoot: z.string().default('.ruobai/skills-drafts'),
  dailyDrafts: z.number().min(0).default(5),
})

export const DRAFT_EVENT = 'skill/draft'
export const APPROVE_EVENT = 'skill/approved'
export const DISCARD_EVENT = 'skill/discarded'

interface Pending {
  fromSeq: number
  turns: number
  lastAt: number
  lastDraftAt: number
}

const IGNORED = new Set([DRAFT_EVENT, APPROVE_EVENT, DISCARD_EVENT])

/**
 * Turn finished sessions into skill drafts.
 *
 * Deliberately a *draft* writer: a skill is a system-prompt section next
 * session, so letting the model publish its own instructions would be a
 * self-granted capability. The draft directory is not a skill root
 * (`skillRoots` only scans `.ruobai/skills`), so nothing loads until a human
 * approves it through the drafts API.
 */
export function apply(ctx: Context, config: Config) {
  if (config.enabled !== true) return
  const draftsRoot = resolve(config.draftsRoot ?? '.ruobai/skills-drafts')
  const pending = new Map<string, Pending>()
  const idleMs = config.idleMs ?? 600_000
  let usedToday = 0
  let day = stamp()

  ctx.effect(() => ctx.on('session/event', (sessionId: string, event: SessionEvent) => {
    if (IGNORED.has(event.type)) return
    const current = pending.get(sessionId)
    const turn = event.type === 'message/user'
    pending.set(sessionId, current
      ? { ...current, lastAt: Date.now(), turns: current.turns + (turn ? 1 : 0) }
      : { fromSeq: event.seq, turns: turn ? 1 : 0, lastAt: Date.now(), lastDraftAt: 0 })
  }), 'skill-distiller.track')

  const tick = setInterval(() => {
    void sweep().catch((error) => {
      ctx.logger('skill-distiller').warn('sweep failed: %s',
        error instanceof Error ? error.message : String(error))
    })
  }, Math.max(1_000, Math.min(60_000, Math.floor(idleMs / 4))))
  ctx.effect(() => () => clearInterval(tick), 'skill-distiller.timer')

  async function sweep() {
    const today = stamp()
    if (today !== day) {
      day = today
      usedToday = 0
    }
    const cap = config.dailyDrafts ?? 5
    const now = Date.now()
    for (const [sessionId, state] of [...pending]) {
      if (now - state.lastAt < idleMs) continue
      if (state.turns < (config.minTurns ?? 2)) continue
      if (state.lastDraftAt && now - state.lastDraftAt < (config.minIntervalMs ?? 3_600_000)) continue
      if (cap > 0 && usedToday >= cap) return

      pending.delete(sessionId)
      const draft = await distill(ctx, sessionId, state.fromSeq, draftsRoot)
      if (!draft) continue
      usedToday += 1
      state.lastDraftAt = now
      pending.set(sessionId, { ...state, fromSeq: draft.upToSeq + 1, turns: 0, lastAt: now })
    }
  }
}

export default { name, inject, Config, apply }

interface Draft {
  slug: string
  path: string
  upToSeq: number
}

/**
 * Rules only, no model call.
 *
 * The first draft should be inspectable, not plausible: it names the goal, the
 * files that changed and the tools that succeeded, all read from the log.
 */
export async function distill(
  ctx: Context,
  sessionId: string,
  fromSeq: number,
  draftsRoot: string,
): Promise<Draft | undefined> {
  const record = ctx.sessions.get(sessionId)
  if (!record) return undefined
  const events = record.events.filter(event => event.seq >= fromSeq)
  if (!events.length) return undefined

  const goal = firstUserGoal(events)
  if (!goal) return undefined
  const paths = changedPaths(events)
  const tools = successfulTools(events)
  if (!tools.length && !paths.length) return undefined

  const upToSeq = events.at(-1)!.seq
  const slug = draftSlug(goal, sessionId, upToSeq)
  const body = renderDraft({ goal, paths, tools, sessionId, fromSeq, upToSeq })

  const dir = join(draftsRoot, slug)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  await writeFile(path, body)

  ctx.sessions.append(sessionId, DRAFT_EVENT, {
    slug,
    path,
    sessionId,
    fromSeq,
    toSeq: upToSeq,
    at: Date.now(),
  })
  return { slug, path, upToSeq }
}

function firstUserGoal(events: SessionEvent[]): string {
  for (const event of events) {
    if (event.type !== 'message/user') continue
    if (event.data?.source) continue
    const text = typeof event.data?.text === 'string' ? event.data.text.trim() : ''
    if (text) return text
  }
  return ''
}

function changedPaths(events: SessionEvent[]): string[] {
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'file/change') continue
    if (typeof event.data?.path === 'string') seen.add(event.data.path)
  }
  return [...seen].slice(0, 12)
}

function successfulTools(events: SessionEvent[]): string[] {
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result' || event.data?.isError === true) continue
    const tool = typeof event.data?.name === 'string' ? event.data.name : ''
    if (tool) seen.add(tool)
  }
  return [...seen].slice(0, 12)
}

function draftSlug(goal: string, sessionId: string, seq: number): string {
  const base = goal
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'session'
  return `${base}-${seq}-${sessionId.slice(0, 6)}`.replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '-')
}

function renderDraft(input: {
  goal: string
  paths: string[]
  tools: string[]
  sessionId: string
  fromSeq: number
  upToSeq: number
}): string {
  const description = input.goal.replace(/\s+/g, ' ').slice(0, 80)
  return [
    '---',
    `name: ${draftSlug(input.goal, input.sessionId, input.upToSeq)}`,
    `description: ${description}`,
    'status: draft',
    `source: session:${input.sessionId}#${input.fromSeq}-${input.upToSeq}`,
    '---',
    '',
    `# ${description}`,
    '',
    '## 何时使用',
    input.goal,
    '',
    '## 步骤',
    ...(input.paths.length ? input.paths.map(path => `- 读/改 \`${path}\``) : ['- 先定位相关文件']),
    ...input.tools.map(tool => `- 使用 \`${tool}\``),
    '',
    '## 验证',
    `- 本会话共 ${input.tools.length} 类工具调用成功、${input.paths.length} 个文件被修改。`,
    '- 复现时先跑一遍相同的命令，确认退出码为 0 再声明完成。',
    '',
    '> 这份草稿由会话日志规则提取，未经人工确认；批准后才会进入 `.ruobai/skills/`。',
  ].join('\n') + '\n'
}

function stamp() {
  return new Date().toISOString().slice(0, 10)
}
