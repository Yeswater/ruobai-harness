import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type {} from '@ruobai/agent'
import type { GitChange } from '@ruobai/git'
import type {} from '@ruobai/session'
import { partitionChanges, proposeMessage } from './message.ts'

export type * from './message.ts'
export { describeChanges, ignoredPath, inferType, partitionChanges, proposeMessage, scopeOf } from './message.ts'

export interface Config {
  /**
   * Offer a card when a turn finishes with uncommitted work.
   *
   * On by default: the gesture the card replaces is "assistant asks whether to
   * commit", and a forgotten commit is the failure people actually hit. Set it
   * to `false` to keep the card purely on demand (`/commit`).
   */
  auto?: boolean
}

/** A ready-to-send commit the user has not answered yet. */
export interface CommitProposal {
  id: string
  sessionId: string
  workspace: string
  /** Message the card starts with; the user may edit it. */
  message: string
  /** Alternative phrasings, offered as one-click choices. */
  candidates: string[]
  /** Exactly the paths that will be staged. */
  files: string[]
  /** Harness state / build output deliberately left out of this commit. */
  skipped: string[]
  stat: { add: number; del: number }
  createdAt: number
  /** Identifies the diff, so the same state is not proposed twice. */
  fingerprint: string
}

export type CommitVia = 'commit' | 'dismiss'

export interface CommitResolution {
  id: string
  sessionId: string
  via: CommitVia
  /** Short hash of the new commit, for the `commit` path. */
  commit?: string
  message?: string
}

declare module '@ruobai/cordis' {
  interface Context {
    commitPrompt: CommitPromptService
  }

  interface Events {
    'commit/requested'(proposal: CommitProposal): void
    'commit/resolved'(resolution: CommitResolution): void
  }
}

/**
 * The commit card's host half: prepare a message, then commit only when the
 * user says so.
 *
 * A question ("是否提交？") in the transcript costs a model round trip and
 * leaves the answer in the conversation; the card costs nothing, and the
 * decision stays next to the diff it is about.
 */
export class CommitPromptService extends Service {
  static inject = ['git', 'sessions']

  static Config: z<Config> = z.object({
    auto: z.boolean().default(true),
  })

  private readonly pending = new Map<string, CommitProposal>()
  /** Last resolved fingerprint per session: a dismissed diff stays dismissed. */
  private readonly settled = new Map<string, string>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'commitPrompt')
  }

  /**
   * Registrations wait for `[Service.init]`.
   *
   * A Service's constructor runs before its fiber is active, so `ctx.effect`
   * there is dropped silently — the card simply never appeared. Everything
   * reversible is registered here instead.
   */
  async *[Service.init]() {
    // A turn that ran to completion is the moment the work is plausibly done.
    // `stopped` / `error` / `max-steps` mean the opposite, and a card there
    // would ask the user to commit half a step.
    yield this.ctx.effect(() => this.ctx.on('agent/turn-end', (sessionId, reason) => {
      if (!this.config.auto || reason !== 'done') return
      void this.autoPropose(sessionId)
    }), 'commit-prompt.auto')

    yield this.ctx.effect(() => {
      const commands = this.ctx.get('commands', false)
      if (!commands) return () => {}
      return commands.register({
        name: 'commit',
        description: '准备提交这次的改动（弹出提交卡片，不调用模型）',
        run: async (invocation) => {
          const proposal = await this.propose(invocation.sessionId, { force: true })
          if (!proposal) return '工作区没有可提交的改动。'
          return `已准备提交 ${proposal.files.length} 个文件，请在卡片里确认提交说明。`
        },
      })
    }, 'commit-prompt.command')
  }

  /** Pending proposals, newest last; optionally for one session. */
  list(sessionId?: string) {
    return [...this.pending.values()]
      .filter(proposal => !sessionId || proposal.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** The proposal for a session, if one is waiting. */
  get(sessionId: string) {
    return this.list(sessionId).at(-1)
  }

  /**
   * Build a proposal from the workspace's current state.
   *
   * Returns `null` — rather than throwing — when there is nothing to commit or
   * the workspace is not a git checkout: both are ordinary states, not errors,
   * and the auto path must never fail a turn.
   */
  async propose(
    sessionId: string,
    options: { force?: boolean } = {},
  ): Promise<CommitProposal | null> {
    const record = this.ctx.sessions.get(sessionId)
    const workspace = record?.meta.workspace
    if (!record || !workspace) return null
    // Sub-agent sessions share the parent's workspace; the parent owns the card.
    if (record.meta.kind === 'subagent') return null

    const existing = this.get(sessionId)
    if (existing && !options.force) return existing

    const status = await this.ctx.git.status(workspace).catch(() => null)
    if (!status?.info.available) return null
    // Harness state and build output sit in the same dirty tree; a generated
    // commit must not sweep them in (AGENTS.md forbids them explicitly).
    const { kept, skipped } = partitionChanges(status.changes)
    if (!kept.length) return null

    const fingerprint = fingerprintOf(status.info.head ?? '', kept)
    // The user already answered this exact diff; re-asking every turn is noise.
    if (!options.force && this.settled.get(sessionId) === fingerprint) return null

    const { message, candidates } = proposeMessage({
      title: record.meta.title,
      changes: kept,
    })
    const proposal: CommitProposal = {
      id: randomUUID(),
      sessionId,
      workspace,
      message,
      candidates,
      files: kept.map(change => change.path),
      skipped: skipped.map(change => change.path),
      stat: sumStat(kept),
      createdAt: Date.now(),
      fingerprint,
    }
    this.pending.set(proposal.id, proposal)
    this.ctx.emit('commit/requested', proposal)
    return proposal
  }

  /**
   * Commit as the user accepted it, or drop the card.
   *
   * The message is taken from the card (the user may have edited it); staging is
   * limited to the files the card listed, so work that appeared in between is
   * not swept into this commit.
   */
  async resolve(
    id: string,
    input: { action: CommitVia; message?: string },
  ): Promise<CommitResolution | undefined> {
    const proposal = this.pending.get(id)
    if (!proposal) return undefined

    if (input.action === 'dismiss') {
      this.pending.delete(id)
      this.settled.set(proposal.sessionId, proposal.fingerprint)
      const resolution: CommitResolution = { id, sessionId: proposal.sessionId, via: 'dismiss' }
      this.ctx.emit('commit/resolved', resolution)
      return resolution
    }

    const message = (input.message ?? proposal.message).trim()
    if (!message) throw new Error('提交说明不能为空')

    // A failed commit keeps the card: hooks, an empty index or a lock file all
    // deserve a retry without re-deriving the proposal.
    this.pending.delete(id)
    let result
    try {
      result = await this.ctx.git.commit(proposal.workspace, { message, paths: proposal.files })
    } catch (error) {
      this.pending.set(id, proposal)
      throw error
    }
    this.settled.delete(proposal.sessionId)
    const resolution: CommitResolution = {
      id,
      sessionId: proposal.sessionId,
      via: 'commit',
      commit: result.commit,
      message,
    }
    this.ctx.emit('commit/resolved', resolution)
    return resolution
  }

  private async autoPropose(sessionId: string) {
    if (this.get(sessionId)) return
    try {
      await this.propose(sessionId)
    } catch (error) {
      // A card is an offer, never a failure: log it and let the turn stand.
      this.ctx.logger('commit-prompt').warn(error)
    }
  }
}

function sumStat(changes: GitChange[]) {
  const total = { add: 0, del: 0 }
  for (const change of changes) {
    for (const stat of [change.stagedStat, change.worktreeStat]) {
      if (!stat) continue
      total.add += stat.added
      total.del += stat.removed
    }
  }
  return total
}

/**
 * HEAD, the sorted paths and the line counts.
 *
 * Paths alone are not enough: editing the same file differently is a new diff
 * and deserves a new card, while re-proposing an untouched dirty tree is noise.
 */
function fingerprintOf(head: string, changes: GitChange[]) {
  const { add, del } = sumStat(changes)
  return `${head}:${add}:${del}:${changes.map(change => change.path).sort().join(',')}`
}

export default CommitPromptService

export const meta = {
  title: '提交卡片',
  description: '回合结束后准备一条现成的提交说明，由用户一键确认提交；也可用 /commit 手动唤起。',
}
