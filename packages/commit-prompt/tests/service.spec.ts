import { execFileSync } from 'node:child_process'
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

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'rbh-commit-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim()
  git('init', '-q')
  git('config', 'user.name', 'Harness Test')
  git('config', 'user.email', 'harness@example.com')
  await writeFile(join(dir, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { dir, git }
}

async function setup(title = '修复 输入框有两个按钮') {
  harness = await createHarness()
  harnesses.push(harness)
  const { dir, git } = await repo()
  const session = harness.ctx.sessions.create({ title, workspace: dir })
  return { ctx: harness.ctx, dir, git, sessionId: session.id }
}

let harness: Harness | undefined

/** The card is built asynchronously (git status is a process); poll for it. */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('commit prompt', () => {
  it('proposes a ready message for the dirty workspace, without a model call', async () => {
    const { ctx, dir, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')

    const proposal = await ctx.commitPrompt.propose(sessionId)
    expect(proposal).not.toBeNull()
    expect(proposal!.message).toBe('fix: 修复 输入框有两个按钮')
    expect(proposal!.files).toEqual(['a.txt'])
    expect(proposal!.stat).toMatchObject({ add: 1, del: 1 })
    expect(ctx.commitPrompt.list(sessionId)).toHaveLength(1)
  })

  it('returns null when there is nothing to commit', async () => {
    const { ctx, sessionId } = await setup()
    expect(await ctx.commitPrompt.propose(sessionId)).toBeNull()
  })

  it('commits only the listed files, with the message the card carries', async () => {
    const { ctx, dir, git, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')
    const proposal = await ctx.commitPrompt.propose(sessionId)

    // Work that appears after the card was shown must not ride along.
    await writeFile(join(dir, 'late.txt'), 'late\n')

    const resolution = await ctx.commitPrompt.resolve(proposal!.id, {
      action: 'commit',
      message: 'chore: 手工改过的说明',
    })
    expect(resolution?.via).toBe('commit')
    expect(git('log', '-1', '--pretty=%s')).toBe('chore: 手工改过的说明')
    expect(git('status', '--porcelain')).toBe('?? late.txt')
    expect(ctx.commitPrompt.list(sessionId)).toHaveLength(0)
  })

  it('keeps a dismissing user from being asked again for the same diff', async () => {
    const { ctx, dir, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')
    const proposal = await ctx.commitPrompt.propose(sessionId)
    await ctx.commitPrompt.resolve(proposal!.id, { action: 'dismiss' })

    expect(await ctx.commitPrompt.propose(sessionId)).toBeNull()

    // A different diff — another path, or other line counts — is a new question.
    await writeFile(join(dir, 'b.txt'), 'new\n')
    expect(await ctx.commitPrompt.propose(sessionId)).not.toBeNull()
  })

  it('rejects an empty message and keeps the card alive', async () => {
    const { ctx, dir, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')
    const proposal = await ctx.commitPrompt.propose(sessionId)

    await expect(ctx.commitPrompt.resolve(proposal!.id, { action: 'commit', message: '  ' }))
      .rejects.toThrow('提交说明不能为空')
    expect(ctx.commitPrompt.list(sessionId)).toHaveLength(1)
  })
})

describe('commit prompt over HTTP', () => {
  it('serves the proposal and commits on accept', async () => {
    const { ctx, dir, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')
    const proposal = await ctx.commitPrompt.propose(sessionId)
    const base = ctx.web.url

    const listed = await fetch(`${base}/api/commits?sessionId=${sessionId}`)
      .then(response => response.json() as Promise<{ proposals: Array<{ id: string }> }>)
    expect(listed.proposals).toHaveLength(1)

    const accepted = await fetch(`${base}/api/commits/${proposal!.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'commit' }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ resolution: { via: 'commit' } })

    const again = await fetch(`${base}/api/commits/${proposal!.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    })
    expect(again.status).toBe(404)
  })

  it('pushes the card on the ui channel', async () => {
    const { ctx, dir, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')

    const frames: Array<{ kind: string; proposal?: { sessionId: string } }> = []
    const off = harness!.ctx.on('ui/broadcast', (channel, data) => {
      if (channel === 'commit') frames.push(data as (typeof frames)[number])
    })

    await ctx.commitPrompt.propose(sessionId)
    off()

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ kind: 'requested', proposal: { sessionId } })
  })
})

describe('automatic offer', () => {
  it('offers the card when a turn finishes with uncommitted work', async () => {
    const { ctx, dir, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')

    ctx.emit('agent/turn-end', sessionId, 'done')
    await waitFor(() => ctx.commitPrompt.list(sessionId).length === 1)

    expect(ctx.commitPrompt.list(sessionId)).toHaveLength(1)
  })

  it('stays quiet when the turn was stopped or failed', async () => {
    const { ctx, dir, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')

    ctx.emit('agent/turn-end', sessionId, 'stopped')
    ctx.emit('agent/turn-end', sessionId, 'error')
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(ctx.commitPrompt.list(sessionId)).toHaveLength(0)
  })
})

describe('harness state', () => {
  it('leaves runtime state and build output out of the commit', async () => {
    const { ctx, dir, git, sessionId } = await setup()
    await writeFile(join(dir, 'a.txt'), 'two\n')
    await mkdir(join(dir, '.ruobai', 'wiki'), { recursive: true })
    await writeFile(join(dir, '.ruobai', 'wiki', 'index.json'), '{}\n')
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'dist', 'bundle.js'), 'x\n')

    const proposal = await ctx.commitPrompt.propose(sessionId)
    expect(proposal!.files).toEqual(['a.txt'])
    expect(proposal!.skipped.sort()).toEqual(['.ruobai/wiki/index.json', 'dist/bundle.js'])

    await ctx.commitPrompt.resolve(proposal!.id, { action: 'commit' })
    expect(git('show', '--name-only', '--pretty=format:', 'HEAD').split('\n')).toEqual(['a.txt'])
  })
})
