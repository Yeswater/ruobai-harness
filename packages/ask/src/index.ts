import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { PromptSection } from '@ruobai/context'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'

export interface Config {
  /** How long a question waits for a human before it is reported as unanswered. */
  timeoutMs?: number
}

export interface AskRequest {
  id: string
  sessionId: string
  question: string
  options?: string[]
  allowFreeText: boolean
  createdAt: number
  expiresAt: number
}

export type AskVia = 'option' | 'text' | 'timeout' | 'cancelled'

export interface AskResolution {
  id: string
  via: AskVia
  answer: string | null
  request: AskRequest
}

export interface AskInput {
  sessionId: string
  question: string
  options?: string[]
  allowFreeText?: boolean
  timeoutMs?: number
}

export interface AskOutcome {
  via: AskVia
  answer: string | null
}

declare module '@ruobai/cordis' {
  interface Context {
    ask: AskService
  }

  interface Events {
    'ask/requested'(request: AskRequest): void
    'ask/resolved'(resolution: AskResolution): void
  }
}

const MIN_TIMEOUT = 5_000
const MAX_TIMEOUT = 30 * 60_000
const MAX_OPTIONS = 4

/**
 * Asks the human a question mid-turn and blocks the calling tool until it is
 * answered.
 *
 * A question is not a permission: an unanswered question is reported back to
 * the model as "no answer" (with the instruction to state assumptions and
 * stop) rather than being treated as consent. The pending request lives only
 * in memory; the transcript keeps the question in the tool call and the answer
 * in the tool result.
 */
export class AskService extends Service {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    timeoutMs: z.number().min(MIN_TIMEOUT).default(5 * 60_000),
  })

  private readonly pending = new Map<
    string,
    { request: AskRequest; settle: (outcome: AskOutcome) => void; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'ask')

    ctx.effect(() => () => {
      for (const id of [...this.pending.keys()]) this.finish(id, { via: 'cancelled', answer: null })
    }, 'ask.dispose')

    ctx.effect(() => ctx.tools.register(askTool(this)), 'ask.tool')

    const section: PromptSection = {
      id: 'ask',
      order: 30,
      stability: 'static',
      render: () => PREFLIGHT,
    }
    const context = ctx.get('context', false) as
      | { registerSection(value: PromptSection): () => void }
      | undefined
    if (context) {
      ctx.effect(() => context.registerSection(section), 'ask.section')
    } else {
      ctx.inject(['context'], (injected) => {
        injected.effect(() => injected.context.registerSection(section), 'ask.section')
      })
    }
  }

  /** Every question still waiting for this session (or all of them). */
  list(sessionId?: string) {
    return [...this.pending.values()]
      .map(entry => entry.request)
      .filter(request => !sessionId || request.sessionId === sessionId)
  }

  ask(input: AskInput, run: { signal?: AbortSignal } = {}): Promise<AskOutcome> {
    if (run.signal?.aborted) return Promise.resolve({ via: 'cancelled', answer: null })

    const question = input.question.trim()
    if (!question) throw new Error('ask_user requires a non-empty question')
    const options = (input.options ?? [])
      .map(option => String(option).trim())
      .filter(Boolean)
      .slice(0, MAX_OPTIONS)
    const timeoutMs = Math.min(
      Math.max(Math.floor(input.timeoutMs ?? this.config.timeoutMs ?? 5 * 60_000), MIN_TIMEOUT),
      MAX_TIMEOUT,
    )
    const request: AskRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      question,
      ...(options.length ? { options } : {}),
      allowFreeText: input.allowFreeText !== false,
      createdAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
    }

    return new Promise<AskOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(request.id, { via: 'timeout', answer: null }), timeoutMs)
      // A long-lived question must not keep the process alive on its own.
      timer.unref?.()
      this.pending.set(request.id, { request, settle: resolve, timer })

      run.signal?.addEventListener('abort', () => this.finish(request.id, { via: 'cancelled', answer: null }), { once: true })
      this.ctx.emit('ask/requested', request)
    })
  }

  /** Answers a pending question; unknown or already-settled ids are ignored. */
  answer(id: string, value: unknown): AskResolution | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    const text = String(value ?? '').trim()
    if (!text) throw new Error('an answer cannot be empty')
    const via: AskVia = entry.request.options?.includes(text) ? 'option' : 'text'
    const resolution = this.finish(id, { via, answer: text })
    return resolution
  }

  private finish(id: string, outcome: AskOutcome): AskResolution | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.settle(outcome)
    const resolution: AskResolution = { id, ...outcome, request: entry.request }
    this.ctx.emit('ask/resolved', resolution)
    return resolution
  }
}

/**
 * The behaviour the tool depends on cannot live in the tool description alone:
 * it has to be in the cached prefix, before the model starts acting.
 */
const PREFLIGHT = [
  '## 动手前先核对，拿不准就问',
  '动手之前先核对现状：现有安装与数据目录、正在运行的服务与端口、工作目录内容、git 状态、配置里已经写死的路径。请求里的前提如果没有核实过，就当作未经验证。',
  '当出现下列情况时，先用 ask_user 把查到的事实摆出来，给出 2–4 个选项让用户决定，再往下做：',
  '- 本地已经存在同名安装、数据目录或后台进程（复用、升级还是重装，是用户的决定）；',
  '- 请求隐含的前提与查到的事实不一致（例如包并不自带某个能力、端口已被占用、目录并非空）；',
  '- 同一句话有多种合理解读，且不同解读会写入不同位置或产生不同副作用。',
  '不要替用户默认选择，也不要为了省事直接覆盖或重装。能自己查证的事情不要问；提问时写清楚你查到了什么、为什么要问。',
  '提问本身要短（两三行）：把关键事实压成一句话，细节放进选项，不要把整份检查报告粘进问题里。',
].join('\n')

function askTool(service: AskService): ToolDefinition {
  return {
    name: 'ask_user',
    readOnly: true,
    // The answer can change what the rest of the step should do, so this runs
    // before (and without) its siblings.
    blocksBatch: true,
    description: [
      'Ask the user a direct question and wait for their answer.',
      'Use it when the request is ambiguous or when the state you found contradicts the premise of the request,',
      'for example an installation or data directory that already exists.',
      'Keep the question short: one or two sentences on what you verified and why you are asking;',
      'the options carry the choice, so do not paste a full report into the question.',
      'Do not use it for anything you can check yourself.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, including the facts you verified that made you ask.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 4 short choices shown as buttons. The user can still answer in their own words.',
        },
        allowFreeText: { type: 'boolean', description: 'Whether the user may type an answer instead of picking an option. Default true.' },
        timeoutMs: { type: 'number', description: `How long to wait before reporting the question as unanswered (max ${MAX_TIMEOUT}).` },
      },
      required: ['question'],
    },
    async execute(args, run) {
      if (!run?.sessionId) throw new Error('ask_user requires a session')
      const outcome = await service.ask({
        sessionId: run.sessionId,
        question: String(args?.question ?? ''),
        options: Array.isArray(args?.options) ? args.options : undefined,
        allowFreeText: args?.allowFreeText !== false,
        timeoutMs: typeof args?.timeoutMs === 'number' ? args.timeoutMs : undefined,
      }, { signal: run.signal })

      if (outcome.via === 'timeout') {
        return '用户没有在等待时间内回答。把你的假设和下一步写清楚并停下来等用户确认；不要继续执行写文件、重装或其它不可逆操作。'
      }
      if (outcome.via === 'cancelled') return '用户中止了本轮，问题没有回答。'
      return `用户回答：${outcome.answer}`
    },
  }
}

export default AskService

export const meta = {
  title: '向用户提问',
  description: '回合内提问并在界面等待回答，同时把「先核对再动手」写进系统提示。',
}
