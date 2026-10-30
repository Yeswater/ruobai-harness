import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approve, list } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rbu-draft-api-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const drafts = join(root, 'drafts')
  const skills = join(root, 'skills')
  await mkdir(join(drafts, 'demo-1'), { recursive: true })
  await writeFile(join(drafts, 'demo-1', 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n\n# demo\n')
  return { drafts, skills }
}

describe('skill draft api', () => {
  it('lists a draft with its frontmatter', async () => {
    const { drafts } = await setup()
    const found = await list(drafts)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ slug: 'demo-1', name: 'demo', description: '演示' })
  })

  it('returns an empty list when the directory is missing', async () => {
    expect(await list(join(tmpdir(), 'rbu-missing-drafts'))).toEqual([])
  })

  it('approves a draft into the skill root', async () => {
    const { drafts, skills } = await setup()
    await approve(drafts, skills, 'demo-1')
    expect(await list(drafts)).toHaveLength(0)
    expect(await readFile(join(skills, 'demo-1', 'SKILL.md'), 'utf8')).toContain('# demo')
  })

  it('refuses to overwrite an existing skill', async () => {
    const { drafts, skills } = await setup()
    await mkdir(join(skills, 'demo-1'), { recursive: true })
    await expect(approve(drafts, skills, 'demo-1')).rejects.toThrow(/already exists/)
  })

  it('refuses an unknown draft', async () => {
    const { drafts, skills } = await setup()
    await expect(approve(drafts, skills, 'nope')).rejects.toThrow(/unknown draft/)
  })
})
