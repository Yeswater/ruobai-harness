import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import WorkspaceService from '@ruobai/workspace'
import SkillsService from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function setup() {
  const workspaceRoot = await tempDir('rbh-skills-ws-')
  const globalRoot = await tempDir('rbh-skills-home-')
  const homeDir = await tempDir('rbh-skills-compat-')
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(() => sessions.dispose())
  const workspace = ctx.plugin(WorkspaceService, { root: workspaceRoot })
  await workspace
  cleanups.push(() => workspace.dispose())
  const tools = ctx.plugin(ToolRegistry)
  await tools
  cleanups.push(() => tools.dispose())
  const skills = ctx.plugin(SkillsService, { globalRoot, homeDir, ttlMs: 0 })
  await skills
  cleanups.push(() => skills.dispose())
  const session = ctx.sessions.create({ title: 'skills', workspace: workspaceRoot })
  return { ctx, workspaceRoot, globalRoot, sessionId: session.id }
}

async function writeSkill(
  root: string,
  folder: string,
  frontmatter: string,
  body: string,
  files: Record<string, string> = {},
) {
  await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, folder, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, folder, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
}

describe('skills service', () => {
  it('discovers project and global skills with project priority', async () => {
    const { ctx, workspaceRoot, globalRoot, sessionId } = await setup()
    await writeSkill(join(workspaceRoot, '.ruobai', 'skills'), 'review',
      'name: review\ndescription: Project review skill', 'project body')
    await writeSkill(join(workspaceRoot, '.claude', 'skills'), 'claude-skill',
      'name: claude-skill\ndescription: From Claude skills', 'claude body')
    await writeSkill(join(globalRoot, 'skills'), 'review',
      'name: review\ndescription: Global review skill', 'global body')
    await writeSkill(join(globalRoot, 'skills'), 'global-skill',
      'name: global-skill\ndescription: Global helper', 'global helper')
    await writeFile(join(globalRoot, 'skills', 'flat.md'), '---\nname: flat\ndescription: Flat skill\n---\n\nflat body\n')

    const skills = await ctx.skills.list(sessionId)
    expect(skills.map(skill => skill.name)).toEqual(['claude-skill', 'flat', 'global-skill', 'review'])
    expect(skills.find(skill => skill.name === 'review')).toMatchObject({
      description: 'Project review skill',
      source: 'project',
    })
    expect((await ctx.skills.render('review', sessionId))).toContain('project body')
  })

  it('renders a catalog with XML escaping and hides model-disabled skills', async () => {
    const { ctx, workspaceRoot, sessionId } = await setup()
    await writeSkill(join(workspaceRoot, '.ruobai', 'skills'), 'a-skill',
      'name: a-skill\ndescription: Use <this> & that', 'body')
    await writeSkill(join(workspaceRoot, '.ruobai', 'skills'), 'user-only',
      'name: user-only\ndescription: Only the user\n\ndisable-model-invocation: true', 'secret body')

    const catalog = await ctx.skills.catalog(sessionId)
    expect(catalog).toContain('<available_skills>')
    expect(catalog).toContain('- a-skill: Use &lt;this&gt; &amp; that')
    expect(catalog).not.toContain('user-only')

    const listed = await ctx.skills.list(sessionId)
    expect(listed.find(skill => skill.name === 'user-only')).toMatchObject({
      modelInvocable: false,
      userInvocable: true,
    })
  })

  it('loads bodies, resources and rejects path escapes', async () => {
    const { ctx, workspaceRoot, sessionId } = await setup()
    await writeSkill(join(workspaceRoot, '.ruobai', 'skills'), 'with-files',
      'name: with-files\ndescription: Has resources', 'Follow the guide.',
      { 'references/guide.md': 'resource text', 'scripts/run.sh': '#!/bin/sh' })

    const rendered = await ctx.skills.render('with-files', sessionId)
    expect(rendered).toContain('<skill_content name="with-files" source="project">')
    expect(rendered).toContain('references/guide.md')
    expect(rendered).toContain('scripts/run.sh')
    expect(rendered).toContain('Follow the guide.')

    const resource = await ctx.skills.render('with-files', sessionId, { file: 'references/guide.md' })
    expect(resource).toContain('resource text')
    expect(await ctx.skills.render('with-files', sessionId, { file: '../outside.md' })).toBeUndefined()
    expect(await ctx.skills.render('missing', sessionId)).toBeUndefined()
  })

  it('exposes one read-only skill tool scoped to the session workspace', async () => {
    const { ctx, workspaceRoot, sessionId } = await setup()
    await writeSkill(join(workspaceRoot, '.ruobai', 'skills'), 'review',
      'name: review\ndescription: Review changes', 'review body')
    const tool = ctx.tools.get('skill')
    expect(tool?.readOnly).toBe(true)
    expect(tool?.requiresApproval).toBeFalsy()

    const result = await ctx.tools.invoke('skill', { name: 'review' }, { sessionId })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('review body')

    const missing = await ctx.tools.invoke('skill', { name: 'nope' }, { sessionId })
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('unknown skill')
  })
})
