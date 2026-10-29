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

/** One question in an ask, as the card answers it (one page at a time). */
export interface AskQuestion {
  question: string
  options?: string[]
  allowFreeText: boolean
}

export interface AskRequest {
  id: string
  sessionId: string
  /** First question, kept for cards built before `questions` existed. */
  question: string
  options?: string[]
  allowFreeText: boolean
  /** Every question in order; a single-question ask has one entry. */
  questions: AskQuestion[]
  createdAt: number
  expiresAt: number
}

export type AskVia = 'option' | 'text' | 'timeout' | 'cancelled'

export interface AskResolution {
  id: string
  via: AskVia
  /** All answers joined for the transcript; see `answers` for the pages. */
  answer: string | null
  /** Per-question answers, aligned with `request.questions`. */
  answers?: string[]
  request: AskRequest
}

export interface AskInput {
  sessionId: string
  question?: string
  options?: string[]
  allowFreeText?: boolean
  /** Several questions asked in one call; the user answers them in order. */
  questions?: Array<{ question?: string; options?: string[]; allowFreeText?: boolean }>
  timeoutMs?: number
}

export interface AskOutcome {
  via: AskVia
  answer: string | null
  /** Per-question answers, aligned with the submitted questions. */
  answers?: string[]
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
const MAX_QUESTIONS = 8

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

    const questions = normalizeQuestions(input)
    const first = questions[0]!
    const timeoutMs = Math.min(
      Math.max(Math.floor(input.timeoutMs ?? this.config.timeoutMs ?? 5 * 60_000), MIN_TIMEOUT),
      MAX_TIMEOUT,
    )
    const request: AskRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      question: first.question,
      ...(first.options ? { options: first.options } : {}),
      allowFreeText: first.allowFreeText,
      questions,
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

  /**
   * Answers a pending question; unknown or already-settled ids are ignored.
   *
   * `value` is one answer per question, either an array (the paged card) or a
   * bare string for a single-question ask.
   */
  answer(id: string, value: unknown): AskResolution | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    const questions = entry.request.questions
    const raw = Array.isArray(value) ? value : [value]
    if (raw.length !== questions.length) {
      throw new Error(`this question expects ${questions.length} answer${questions.length === 1 ? '' : 's'}`)
    }
    const answers = raw.map(item => String(item ?? '').trim())
    if (answers.some(answer => !answer)) throw new Error('an answer cannot be empty')
    // `option` only when every page picked one of its own options.
    const via: AskVia = answers.every((answer, index) => questions[index]?.options?.includes(answer))
      ? 'option'
      : 'text'
    const answer = questions.length === 1
      ? answers[0]!
      : questions.map((question, index) => `${index + 1}. ${question.question}\n→ ${answers[index]}`).join('\n')
    return this.finish(id, { via, answer, answers })
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
  '要一次收集多个决定时，把问题放进 questions 数组一次问清：界面会按 1、2、3 逐页让用户回答，不要拆成多次调用。',
  '提问本身要短（两三行）：把关键事实压成一句话，细节放进选项，不要把整份检查报告粘进问题里。',
].join('\n')

/**
 * One page per question; a plain `question` call is a one-page ask.
 *
 * Validated up front: a blank page would reach the card as an empty body with
 * no way to continue the wizard.
 */
function normalizeQuestions(input: AskInput): AskQuestion[] {
  const raw = Array.isArray(input.questions) && input.questions.length
    ? input.questions
    : [{ question: input.question, options: input.options, allowFreeText: input.allowFreeText }]
  if (raw.length > MAX_QUESTIONS) throw new Error(`ask_user is limited to ${MAX_QUESTIONS} questions`)
  return raw.map((entry, index) => {
    const question = String(entry?.question ?? '').trim()
    if (!question) throw new Error(`question ${index + 1} is empty`)
    const options = (Array.isArray(entry?.options) ? entry.options : [])
      .map(option => String(option).trim())
      .filter(Boolean)
      .slice(0, MAX_OPTIONS)
    const allowFreeText = entry?.allowFreeText !== false
    // A page must be answerable: no options and no free text leaves the user
    // stuck on it with no way to reach the next question.
    if (!options.length && !allowFreeText) {
      throw new Error(`question ${index + 1} needs options or free text`)
    }
    return {
      question,
      ...(options.length ? { options } : {}),
      allowFreeText,
    }
  })
}

function askTool(service: AskService): ToolDefinition {
  return {
    name: 'ask_user',
    readOnly: true,
    // The answer can change what the rest of the step should do, so this runs
    // before (and without) its siblings.
    blocksBatch: true,
    description: [
      'Ask the user one or more direct questions and wait for the answers.',
      'Use `question` for a single decision; use `questions` to collect several decisions at once —',
      'the card asks them one page at a time, in order. Prefer one call with `questions` over asking twice.',
      'Keep each question short: one or two sentences on what you verified and why you are asking;',
      'the options carry the choice, so do not paste a full report into a question.',
      'Do not use it for anything you can check yourself.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A single question, including the facts you verified that made you ask.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 4 short choices shown as buttons. The user can still answer in their own words.',
        },
        allowFreeText: { type: 'boolean', description: 'Whether the user may type an answer instead of picking an option. Default true.' },
        questions: {
          type: 'array',
          description: 'Several questions answered one page at a time. Use instead of calling ask_user again.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              allowFreeText: { type: 'boolean' },
            },
            required: ['question'],
          },
        },
        timeoutMs: { type: 'number', description: `How long to wait before reporting the question as unanswered (max ${MAX_TIMEOUT}).` },
      },
    },
    async execute(args, run) {
      if (!run?.sessionId) throw new Error('ask_user requires a session')
      const outcome = await service.ask({
        sessionId: run.sessionId,
        ...(typeof args?.question === 'string' ? { question: args.question } : {}),
        ...(Array.isArray(args?.options) ? { options: args.options } : {}),
        ...(args?.allowFreeText === false ? { allowFreeText: false } : {}),
        ...(Array.isArray(args?.questions) ? { questions: args.questions } : {}),
        ...(typeof args?.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      }, { signal: run.signal })

      if (outcome.via === 'timeout') {
        return '用户没有在等待时间内回答。把你的假设和下一步写清楚并停下来等用户确认；不要继续执行写文件、重装或其它不可逆操作。'
      }
      if (outcome.via === 'cancelled') return '用户中止了本轮，问题没有回答。'
      const pages = outcome.answers?.length ?? 0
      return pages > 1 ? `用户逐题回答：\n${outcome.answer}` : `用户回答：${outcome.answer}`
    },
  }
}

export default AskService

export const meta = {
  title: '向用户提问',
  description: '回合内提问并在界面等待回答，同时把「先核对再动手」写进系统提示。',
}
