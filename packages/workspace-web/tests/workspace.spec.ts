import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
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

  it('scopes reads to a session workspace and browses directories', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url
    const dir = await mkdtemp(join(tmpdir(), 'rbh-workspace-web-'))
    dirs.push(dir)
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'notes.txt'), 'workspace file')

    const session = harness.ctx.sessions.create({ title: 'scoped', workspace: dir })

    const tree = await (await fetch(
      `${base}/api/workspace/tree?path=.&sessionId=${session.id}`,
    )).json() as { tree: { children: Array<{ name: string }> } }
    expect(tree.tree.children.map(child => child.name)).toEqual(expect.arrayContaining(['src', 'notes.txt']))

    const file = await (await fetch(
      `${base}/api/workspace/file?path=notes.txt&sessionId=${session.id}`,
    )).json() as { content: string }
    expect(file.content).toBe('workspace file')

    const unscoped = await fetch(`${base}/api/workspace/file?path=notes.txt`)
    expect(unscoped.status).toBe(404)

    const browse = await (await fetch(
      `${base}/api/workspace/browse?path=${encodeURIComponent(dir)}`,
    )).json() as { path: string; entries: Array<{ name: string }> }
    expect(browse.path).toBe(dir)
    expect(browse.entries.map(entry => entry.name)).toContain('src')

    const unknown = await fetch(`${base}/api/workspace/tree?sessionId=missing`)
    expect(unknown.status).toBe(404)
  })
})
