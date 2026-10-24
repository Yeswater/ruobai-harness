import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

describe('workspace web', () => {
  it('lists the workspace and reads files with a traversal guard', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url

    const tree = await (await fetch(`${base}/api/workspace/tree?path=.`)).json() as {
      tree: { type: string; children: Array<{ name: string }> }
    }
    expect(tree.tree.type).toBe('directory')
    expect(tree.tree.children.some(child => child.name === 'packages')).toBe(true)

    const file = await (await fetch(`${base}/api/workspace/file?path=package.json`)).json() as {
      content: string
    }
    expect(file.content).toContain('"name": "ruobai-harness"')

    const escape = await fetch(`${base}/api/workspace/file?path=../../etc/passwd`)
    expect(escape.status).toBe(403)
  })
})
