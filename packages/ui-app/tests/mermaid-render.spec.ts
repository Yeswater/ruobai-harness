import { describe, expect, it } from 'vitest'
import { createSerialQueue, mermaidRenderId } from '../src/mermaid-render.ts'

describe('mermaid render id', () => {
  it('strips the characters React 18/19 put in useId', () => {
    expect(mermaidRenderId(':r0:')).toBe('mermaid-r0')
    expect(mermaidRenderId('«r7»')).toBe('mermaid-r7')
  })

  it('keeps ids usable inside a CSS selector', () => {
    expect(mermaidRenderId('a.b#c d')).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('never returns an empty id', () => {
    expect(mermaidRenderId(':')).not.toBe('')
    expect(mermaidRenderId('')).toMatch(/^mermaid-\d+$/)
  })
})

describe('serial render queue', () => {
  it('runs jobs one at a time in enqueue order', async () => {
    const queue = createSerialQueue()
    const log: string[] = []
    let running = 0
    const job = (name: string, delay: number) => async () => {
      running += 1
      expect(running).toBe(1)
      log.push(`start:${name}`)
      await new Promise(resolve => setTimeout(resolve, delay))
      log.push(`end:${name}`)
      running -= 1
      return name
    }

    const results = await Promise.all([
      queue(job('a', 10)),
      queue(job('b', 1)),
      queue(job('c', 5)),
    ])

    expect(results).toEqual(['a', 'b', 'c'])
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  })

  it('keeps going after a failed job', async () => {
    const queue = createSerialQueue()
    const first = queue(async () => {
      throw new Error('boom')
    })
    await expect(first).rejects.toThrow('boom')
    await expect(queue(async () => 'ok')).resolves.toBe('ok')
  })
})
