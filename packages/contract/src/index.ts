import { randomUUID } from 'node:crypto'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/context'
import type { SessionEvent } from '@ruobai/session'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'
import type { AcceptanceItem, ContractState, TaskContract } from './types.ts'

export type * from './types.ts'

export const name = 'contract'
export const inject = ['tools', 'sessions']

export const CONTRACT_EVENT = 'contract/opened'
export const CONTRACT_AMENDED_EVENT = 'contract/amended'
export const CONTRACT_CLOSED_EVENT = 'contract/closed'
export const CONTRACT_PROJECTION = 'contract'

export interface Amendment {
  goals?: string[]
  nonGoals?: string[]
  acceptance?: AcceptanceItem[]
}

declare module '@ruobai/cordis' {
  interface Events {
    'contract/opened'(contract: TaskContract): void
    'contract/closed'(info: { sessionId: string; id: string }): void
  }
}

const EMPTY: ContractState = { open: null, lastSeq: -1 }
const MAX_TITLE = 80
const MAX_ITEMS = 20
const MAX_TEXT = 400
const ACCEPTANCE_ID = /^A\d+$/

/**
 * Fold the contract events into "the contract still in force".
 *
 * The open contract is durable state: a reloaded session must still know what
 * it promised. `acceptance` is replaced as a whole on amendment, so replaying a
 * session needs no merge logic — the same reason the task list replaces its
 * table instead of patching it.
 */
export const contractProjection = {
  init: () => EMPTY,
  apply(state: ContractState, event: SessionEvent): ContractState {
    if (event.type === CONTRACT_EVENT) {
      const contract = event.data as TaskContract | undefined
      if (!contract?.id) return state
      return { open: contract, lastSeq: event.seq }
    }
    if (event.type === CONTRACT_AMENDED_EVENT) {
      const data = event.data as { id?: string; patch?: Amendment } | undefined
      if (!data?.id || state.open?.id !== data.id || !data.patch) return state
      const patch = data.patch
      return {
        open: {
          ...state.open,
          goals: patch.goals ?? state.open.goals,
          nonGoals: patch.nonGoals ?? state.open.nonGoals,
          acceptance: patch.acceptance ?? state.open.acceptance,
          revision: state.open.revision + 1,
        },
        lastSeq: event.seq,
      }
    }
    if (event.type === CONTRACT_CLOSED_EVENT) {
      const id = (event.data as { id?: string } | undefined)?.id
      if (!id || state.open?.id !== id) return state
      return { open: null, lastSeq: event.seq }
    }
    return state
  },
}

export function contractOf(ctx: Context, sessionId: string): ContractState {
  const view = ctx.sessions.view<Record<string, unknown>>(sessionId)
  return (view?.[CONTRACT_PROJECTION] as ContractState | undefined) ?? EMPTY
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.sessions.registerProjection(CONTRACT_PROJECTION, contractProjection), 'contract.projection')
  ctx.effect(() => ctx.tools.register(openTool(ctx)), 'contract.open')
  ctx.effect(() => ctx.tools.register(amendTool(ctx)), 'contract.amend')
  ctx.effect(() => ctx.tools.register(closeTool(ctx)), 'contract.close')

  // The tool description alone is not enough: the rule has to be in the cached
  // prefix before the first step, or the model writes the agreement as prose.
  const guide = {
    id: 'contract.guide',
    order: 84,
    stability: 'static' as const,
    render: () => CONTRACT_GUIDE,
  }
  const section = {
    id: CONTRACT_PROJECTION,
    // Epoch, not turn: the contract does not change inside a step, and it must
    // be re-read after compaction rather than summarized away.
    order: 85,
    stability: 'epoch' as const,
    maxChars: 8_000,
    render: ({ sessionId }: { sessionId: string }) => renderContract(contractOf(ctx, sessionId).open),
  }
  ctx.inject(['context'], (sectionCtx) => {
    sectionCtx.effect(() => sectionCtx.context.registerSection(guide), 'contract.guide')
    sectionCtx.effect(() => sectionCtx.context.registerSection(section), 'contract.section')
  })
}

export default { name, inject, apply }

function openTool(ctx: Context): ToolDefinition {
  return {
    name: 'contract_open',
    description: [
      'Open the delivery contract for this session: what is being delivered and how it will be accepted.',
      'Use it before delivery work with a customer or a verifiable outcome. acceptance is the only input of the delivery gate.',
      'Write each acceptance item as an observable action → expected result, not an internal property.',
      'Only one contract may be open; change it with contract_amend and finish it with contract_close.',
    ].join(' '),
    // Session scratch state, not an external side effect: allowed in read-only mode.
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short noun phrase, e.g. "客户 A 首页性能整改".' },
        customer: { type: 'string', description: 'Customer or environment label; used as a handoff heading.' },
        goals: { type: 'array', items: { type: 'string' }, description: 'What this delivery must achieve.' },
        nonGoals: { type: 'array', items: { type: 'string' }, description: 'Explicitly out of scope; becomes the runbook known limits.' },
        acceptance: {
          type: 'array',
          description: 'The complete acceptance list; each item becomes a delivery-gate row.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id, e.g. "A1".' },
              criterion: { type: 'string', description: 'Observable action → expected result.' },
              kind: { type: 'string', enum: ['auto', 'manual'] },
              check: {
                type: 'object',
                properties: {
                  tool: { type: 'string', enum: ['bash', 'test', 'manual'] },
                  command: { type: 'string' },
                  expectExit: { type: 'number' },
                  expectContains: { type: 'string' },
                },
              },
            },
            required: ['id', 'criterion', 'kind'],
          },
        },
      },
      required: ['title', 'acceptance'],
    },
    execute(args, run) {
      const sessionId = run?.sessionId
      if (!sessionId) throw new Error('contract_open requires a session')
      const existing = contractOf(ctx, sessionId).open
      if (existing) {
        throw new Error(`a contract is already open (${existing.title}); use contract_amend to change it`)
      }
      const contract = normalizeNew(args)
      ctx.sessions.append(sessionId, CONTRACT_EVENT, contract)
      ctx.emit('contract/opened', contract)
      return `Contract opened: ${contract.title} (${contract.acceptance.length} acceptance items). Claim delivery with evidence for each item.`
    },
  }
}

function amendTool(ctx: Context): ToolDefinition {
  return {
    name: 'contract_amend',
    description: [
      'Amend the open contract. acceptance replaces the whole list, so pass every item you still want.',
      'An existing acceptance id cannot be dropped: evidence may already point at it.',
      'Use it when the customer adds or changes a requirement; do not open a second contract.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        goals: { type: 'array', items: { type: 'string' } },
        nonGoals: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'array', items: { type: 'object' } },
        reason: { type: 'string', description: 'Why the contract changed; recorded in the log.' },
      },
      required: ['reason'],
    },
    execute(args, run) {
      const sessionId = run?.sessionId
      if (!sessionId) throw new Error('contract_amend requires a session')
      const current = contractOf(ctx, sessionId).open
      if (!current) throw new Error('no open contract; use contract_open first')

      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      if (!reason) throw new Error('contract_amend requires a reason')

      const patch: Amendment = {}
      if (args?.goals !== undefined) patch.goals = stringList(args.goals, 'goals')
      if (args?.nonGoals !== undefined) patch.nonGoals = stringList(args.nonGoals, 'nonGoals')
      if (args?.acceptance !== undefined) {
        const next = normalizeAcceptance(args.acceptance)
        const dropped = current.acceptance
          .filter(item => !next.some(candidate => candidate.id === item.id))
          .map(item => item.id)
        if (dropped.length) {
          throw new Error(`acceptance ${dropped.join(', ')} cannot be dropped; evidence may already reference it`)
        }
        patch.acceptance = next
      }
      if (!Object.keys(patch).length) throw new Error('contract_amend has nothing to change')

      ctx.sessions.append(sessionId, CONTRACT_AMENDED_EVENT, { id: current.id, patch, reason, at: Date.now() })
      return `Contract amended (revision ${current.revision + 1}).`
    },
  }
}

function closeTool(ctx: Context): ToolDefinition {
  return {
    name: 'contract_close',
    description: [
      'Close the open contract once every acceptance item has a verdict.',
      'Closing does not mean "passed": the delivery verdict is recorded separately, this only ends the agreement.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contract id; omit to close the open one.' },
        reason: { type: 'string', description: 'Why it closes: accepted, superseded, abandoned.' },
      },
    },
    execute(args, run) {
      const sessionId = run?.sessionId
      if (!sessionId) throw new Error('contract_close requires a session')
      const current = contractOf(ctx, sessionId).open
      if (!current) throw new Error('no open contract')
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (id && id !== current.id) throw new Error(`contract ${id} is not the open one`)

      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      ctx.sessions.append(sessionId, CONTRACT_CLOSED_EVENT, {
        id: current.id,
        ...(reason ? { reason } : {}),
        at: Date.now(),
      })
      ctx.emit('contract/closed', { sessionId, id: current.id })
      return `Contract closed: ${current.title}`
    },
  }
}

function normalizeNew(args: any): TaskContract {
  const title = typeof args?.title === 'string' ? args.title.trim() : ''
  if (!title) throw new Error('contract_open requires a title')
  if (title.length > MAX_TITLE) throw new Error(`title is longer than ${MAX_TITLE} characters`)

  const customer = typeof args?.customer === 'string' ? args.customer.trim() : ''
  return {
    id: randomUUID(),
    title,
    ...(customer ? { customer } : {}),
    goals: stringList(args?.goals, 'goals'),
    nonGoals: stringList(args?.nonGoals, 'nonGoals'),
    acceptance: normalizeAcceptance(args?.acceptance),
    openedAt: Date.now(),
    revision: 1,
  }
}

function stringList(input: unknown, field: string): string[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error(`${field} must be an array`)
  return input.map((raw, index) => {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) throw new Error(`${field}[${index}] is empty`)
    if (text.length > MAX_TEXT) throw new Error(`${field}[${index}] is longer than ${MAX_TEXT} characters`)
    return text
  })
}

function normalizeAcceptance(input: unknown): AcceptanceItem[] {
  if (!Array.isArray(input) || !input.length) throw new Error('acceptance must be a non-empty array')
  if (input.length > MAX_ITEMS) throw new Error(`acceptance is limited to ${MAX_ITEMS} items`)

  const seen = new Set<string>()
  return input.map((raw, index) => {
    const item = (raw ?? {}) as { id?: unknown; criterion?: unknown; kind?: unknown; check?: any }
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!ACCEPTANCE_ID.test(id)) throw new Error(`acceptance ${index + 1} needs an id like "A1"`)
    if (seen.has(id)) throw new Error(`duplicate acceptance id "${id}"`)
    seen.add(id)

    const criterion = typeof item.criterion === 'string' ? item.criterion.trim() : ''
    if (!criterion) throw new Error(`acceptance ${id} has no criterion`)
    if (criterion.length > MAX_TEXT) throw new Error(`acceptance ${id} is longer than ${MAX_TEXT} characters`)

    if (item.kind === 'manual') {
      if (typeof item.check?.command === 'string' && item.check.command.trim()) {
        throw new Error(`acceptance ${id} is manual but carries a command; use kind "auto"`)
      }
      return { id, criterion, kind: 'manual' }
    }
    if (item.kind !== 'auto') throw new Error(`acceptance ${id} has an invalid kind`)

    const command = typeof item.check?.command === 'string' ? item.check.command.trim() : ''
    const expectExit = typeof item.check?.expectExit === 'number' ? item.check.expectExit : undefined
    if (!command && expectExit === undefined) {
      throw new Error(`acceptance ${id} needs check.command or check.expectExit`)
    }
    return {
      id,
      criterion,
      kind: 'auto',
      check: {
        tool: item.check?.tool === 'test' ? 'test' : 'bash',
        ...(command ? { command } : {}),
        ...(expectExit !== undefined ? { expectExit } : {}),
        ...(typeof item.check?.expectContains === 'string' ? { expectContains: item.check.expectContains } : {}),
      },
    }
  })
}

function renderContract(contract: TaskContract | null): string {
  if (!contract) return ''
  return [
    '<contract>',
    `Title: ${contract.title}`,
    contract.customer ? `Customer: ${contract.customer}` : '',
    'Goals:',
    ...contract.goals.map(goal => `- ${goal}`),
    contract.nonGoals.length ? 'Non-goals (explicitly out of scope):' : '',
    ...contract.nonGoals.map(goal => `- ${goal}`),
    'Acceptance (every item needs evidence before delivery is claimed):',
    ...contract.acceptance.map(item => `- ${item.id} [${item.kind}] ${item.criterion}`),
    '</contract>',
  ].filter(Boolean).join('\n')
}

const CONTRACT_GUIDE = [
  '## 交付前先立契约',
  '- 开始有客户或验收标准的交付工作前，先调用 contract_open 写下 goals / nonGoals / acceptance；验收条款写"可观察的动作 → 期望结果"。',
  '- acceptance 是交付门禁的唯一输入：没有契约就没有验收，不要用正文或计划代替。',
  '- 契约变更用 contract_amend（acceptance 整表替换，不能删除已有 id）；交付结束用 contract_close。',
].join('\n')
