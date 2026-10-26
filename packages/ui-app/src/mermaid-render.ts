/**
 * Mermaid 渲染有两条容易被忽略的全局约束，这里把它们抽成可测的纯逻辑：
 * 1. 渲染 id 会被写进 SVG 内部的 CSS 选择器，只能含 `[A-Za-z0-9_-]`；
 * 2. mermaid 的 config / theme 是模块级全局状态，并发渲染会互相串味。
 */

let fallbackSequence = 0

/** React 的 `useId` 会带 `:`（18）或 `«»`（19），净化后再拼成 mermaid 可用的 id。 */
export function mermaidRenderId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, '')
  return cleaned ? `mermaid-${cleaned}` : `mermaid-${++fallbackSequence}`
}

/** 串行队列：前一个任务结束（无论成败）之后才启动下一个。 */
export function createSerialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(job: () => Promise<T>) => {
    const run = tail.then(job, job)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/** 全局唯一的 mermaid 渲染队列，多张图共用。 */
export const serializeMermaidRender = createSerialQueue()
