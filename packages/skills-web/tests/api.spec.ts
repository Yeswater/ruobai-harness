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

describe('skills web', () => {
  it('lists session-scoped skills and their roots', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const dir = await mkdtemp(join(tmpdir(), 'rbh-skills-web-'))
    dirs.push(dir)
    await mkdir(join(dir, '.ruobai', 'skills', 'review'), { recursive: true })
    await writeFile(
      join(dir, '.ruobai', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review changes\n---\n\nbody\n',
    )

    const session = harness.ctx.sessions.create({ title: 'skills', workspace: dir })
    const response = await fetch(`${harness.ctx.web.url}/api/skills?sessionId=${session.id}`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      skills: Array<{ name: string; description: string; source: string }>
      roots: Array<{ path: string; source: string }>
    }
    expect(body.skills).toEqual([
      expect.objectContaining({ name: 'review', description: 'Review changes', source: 'project' }),
    ])
    expect(body.roots[0]).toEqual({ path: join(dir, '.ruobai', 'skills'), source: 'project' })

    const unknown = await fetch(`${harness.ctx.web.url}/api/skills?sessionId=missing`)
    expect(unknown.status).toBe(404)
  })
})
