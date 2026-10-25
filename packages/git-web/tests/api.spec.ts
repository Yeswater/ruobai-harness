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
  const dir = await mkdtemp(join(tmpdir(), 'rbh-git-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.name', 'Harness Test')
  git('config', 'user.email', 'harness@example.com')
  await writeFile(join(dir, 'a.txt'), 'one\n')
  await writeFile(join(dir, 'b.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { dir, git }
}

async function session(harness: Harness, workspace: string) {
  return harness.ctx.sessions.create({ title: 'git', workspace })
}

function post(base: string, path: string, body: unknown) {
  return fetch(`${base}/api/git${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function get<T>(base: string, path: string) {
  return fetch(`${base}/api/git${path}`).then(response => response.json() as Promise<T>)
}

describe('git web', () => {
  it('splits status into staged, unstaged and untracked with line stats', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const { dir, git } = await repo()
    const active = await session(harness, dir)
    const base = harness.ctx.web.url
    const query = `sessionId=${active.id}`

    await writeFile(join(dir, 'a.txt'), 'two\nthree\n')
    await writeFile(join(dir, 'b.txt'), 'two\n')
    git('add', 'b.txt')
    await writeFile(join(dir, 'c.txt'), 'new\n')
    await writeFile(join(dir, 'with space.txt'), 'space\n')
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'd.txt'), 'deep\n')

    const status = await get<{
      info: { files: number; added: number; removed: number; branch: string }
      changes: Array<{
        path: string; index: string; worktree: string; staged: boolean; unstaged: boolean
        untracked: boolean; stagedStat?: { added: number; removed: number }
        worktreeStat?: { added: number; removed: number }
      }>
    }>(base, `/status?${query}`)

    expect(status.info.branch).toBeTruthy()
    expect(status.info.files).toBe(5)
    expect(status.changes.map(change => change.path)).toEqual([
      'a.txt', 'b.txt', 'c.txt', 'src/d.txt', 'with space.txt',
    ])
    const a = status.changes.find(change => change.path === 'a.txt')!
    expect(a).toMatchObject({ index: '.', worktree: 'M', staged: false, unstaged: true })
    expect(a.worktreeStat).toEqual({ added: 2, removed: 1 })
    const b = status.changes.find(change => change.path === 'b.txt')!
    expect(b).toMatchObject({ index: 'M', worktree: '.', staged: true, unstaged: false })
    expect(b.stagedStat).toEqual({ added: 1, removed: 1 })
    expect(status.changes.find(change => change.path === 'c.txt')).toMatchObject({
      untracked: true,
      worktreeStat: { added: 1, removed: 0 },
    })

    const working = await get<{ diff: string }>(base, `/diff?${query}&path=a.txt&scope=working`)
    expect(working.diff).toContain('+two')
    const staged = await get<{ diff: string }>(base, `/diff?${query}&path=b.txt&scope=staged`)
    expect(staged.diff).toContain('+two')
    const untracked = await get<{ diff: string }>(base, `/diff?${query}&path=c.txt&scope=working`)
    expect(untracked.diff).toContain('+new')
    const quoted = await get<{ diff: string }>(
      base, `/diff?${query}&path=${encodeURIComponent('with space.txt')}&scope=working`,
    )
    expect(quoted.diff).toContain('+space')
  })

  it('stages, unstages and discards tracked and untracked paths', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const { dir, git } = await repo()
    const active = await session(harness, dir)
    const base = harness.ctx.web.url
    const query = `sessionId=${active.id}`

    await writeFile(join(dir, 'a.txt'), 'two\n')
    await writeFile(join(dir, 'c.txt'), 'new\n')

    expect((await post(base, '/stage', { sessionId: active.id, paths: ['a.txt', 'c.txt'] })).status).toBe(200)
    let status = await get<{
      changes: Array<{ path: string; staged: boolean; untracked: boolean }>
    }>(base, `/status?${query}`)
    expect(status.changes.every(change => change.staged)).toBe(true)

    await post(base, '/unstage', { sessionId: active.id, paths: ['a.txt', 'c.txt'] })
    status = await get<{
      changes: Array<{ path: string; staged: boolean; untracked: boolean }>
    }>(base, `/status?${query}`)
    expect(status.changes.find(change => change.path === 'c.txt')?.untracked).toBe(true)

    await post(base, '/discard', { sessionId: active.id, paths: ['a.txt', 'c.txt'] })
    const cleaned = await get<{ changes: Array<{ path: string; staged: boolean; untracked: boolean }> }>(
      base, `/status?${query}`,
    )
    expect(cleaned.changes).toEqual([])
    expect(() => execFileSync('git', ['diff', '--quiet'], { cwd: dir })).not.toThrow()
    expect(await import('node:fs/promises').then(fs => fs.stat(join(dir, 'c.txt')).catch(() => null)))
      .toBeNull()
    expect(git).toBeTypeOf('function')
  })

  it('commits staged work plus the selected paths and supports amend', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const { dir, git } = await repo()
    const active = await session(harness, dir)
    const base = harness.ctx.web.url
    const query = `sessionId=${active.id}`

    await writeFile(join(dir, 'a.txt'), 'two\n')
    await writeFile(join(dir, 'b.txt'), 'two\n')
    git('add', 'b.txt')

    const missingMessage = await post(base, '/commit', { sessionId: active.id, paths: ['a.txt'] })
    expect(missingMessage.status).toBe(400)

    const committed = await post(base, '/commit', {
      sessionId: active.id,
      message: 'selected a',
      paths: ['a.txt'],
    }).then(response => response.json() as Promise<{ commit: string; hash: string }>)
    expect(committed.commit).toContain('selected a')
    expect(committed.hash).toBeTruthy()

    const after = await get<{ changes: unknown[] }>(base, `/status?${query}`)
    expect(after.changes).toEqual([])

    await writeFile(join(dir, 'a.txt'), 'three\n')
    const amended = await post(base, '/commit', {
      sessionId: active.id,
      message: 'amended a',
      amend: true,
      paths: ['a.txt'],
    }).then(response => response.json() as Promise<{ hash: string }>)
    expect(amended.hash).not.toBe(committed.hash)

    const log = await get<{ commits: Array<{ subject: string }> }>(base, `/log?${query}`)
    expect(log.commits[0]?.subject).toBe('amended a')
    expect(log.commits).toHaveLength(2)
  })

  it('keeps both sides of a rename when staging, unstaging and discarding', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const { dir, git } = await repo()
    const active = await session(harness, dir)
    const base = harness.ctx.web.url
    const query = `sessionId=${active.id}`

    git('mv', 'a.txt', 'renamed.txt')
    const renamed = await get<{
      changes: Array<{ path: string; origPath?: string; index: string; staged: boolean }>
    }>(base, `/status?${query}`)
    expect(renamed.changes).toHaveLength(1)
    expect(renamed.changes[0]).toMatchObject({
      path: 'renamed.txt', origPath: 'a.txt', index: 'R', staged: true,
    })

    await post(base, '/unstage', { sessionId: active.id, paths: ['renamed.txt'] })
    const unstaged = await get<{ changes: Array<{ path: string; staged: boolean }> }>(
      base, `/status?${query}`,
    )
    expect(unstaged.changes.map(change => change.path)).toEqual(['a.txt', 'renamed.txt'])
    expect(unstaged.changes.every(change => !change.staged)).toBe(true)

    await post(base, '/stage', { sessionId: active.id, paths: ['a.txt', 'renamed.txt'] })
    const restaged = await get<{ changes: Array<{ path: string; origPath?: string; index: string }> }>(
      base, `/status?${query}`,
    )
    expect(restaged.changes).toEqual([expect.objectContaining({ path: 'renamed.txt', origPath: 'a.txt' })])

    await post(base, '/discard', { sessionId: active.id, paths: ['renamed.txt'] })
    const cleanedUp = await get<{ changes: unknown[] }>(base, `/status?${query}`)
    expect(cleanedUp.changes).toEqual([])
    const fs = await import('node:fs/promises')
    expect(await fs.readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await fs.stat(join(dir, 'renamed.txt')).catch(() => null)).toBeNull()
  })

  it('pages the log, searches it, and shows commit detail with per-file diffs', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const { dir, git } = await repo()
    const active = await session(harness, dir)
    const base = harness.ctx.web.url
    const query = `sessionId=${active.id}`

    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(dir, 'a.txt'), `line ${index}\n`)
      git('add', '-A')
      git('commit', '-qm', `change ${index}`)
    }
    git('branch', 'feature')

    const first = await get<{ commits: Array<{ hash: string; subject: string; refs: string[]; parents: string[] }>; hasMore: boolean }>(
      base, `/log?${query}&limit=2`,
    )
    expect(first.commits).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.commits[0]?.refs.some(ref => ref.includes('main') || ref.includes('master'))).toBe(true)

    const second = await get<{ commits: unknown[]; hasMore: boolean }>(base, `/log?${query}&limit=2&skip=2`)
    expect(second.commits).toHaveLength(2)
    expect(second.hasMore).toBe(false)

    const searched = await get<{ commits: Array<{ subject: string }> }>(base, `/log?${query}&q=change 1`)
    expect(searched.commits.map(commit => commit.subject)).toEqual(['change 1'])

    const hash = first.commits[0]!.hash
    const detail = await get<{
      hash: string; body: string; files: Array<{ path: string; status: string; added: number }>
    }>(base, `/commit?${query}&hash=${hash}`)
    expect(detail.hash).toBe(hash)
    expect(detail.body).toContain('change 2')
    expect(detail.files).toEqual([expect.objectContaining({ path: 'a.txt', status: 'M', added: 1, removed: 1 })])

    const patch = await get<{ diff: string }>(base, `/diff?${query}&path=a.txt&scope=commit&hash=${hash}`)
    expect(patch.diff).toContain('+line 2')

    const branches = await get<{ branches: Array<{ name: string; current: boolean; remote: boolean }> }>(
      base, `/branches?${query}`,
    )
    expect(branches.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'feature', current: false }),
    ]))
    expect(branches.branches.some(branch => branch.current)).toBe(true)

    const checkout = await post(base, '/checkout', { sessionId: active.id, branch: 'feature' })
      .then(response => response.json() as Promise<{ branch: string }>)
    expect(checkout.branch).toBe('feature')
    const switched = await get<{ info: { branch: string } }>(base, `/status?${query}`)
    expect(switched.info.branch).toBe('feature')

    const createdResponse = await post(base, '/branch', { sessionId: active.id, name: 'topic/created' })
    const created = await createdResponse.json() as { branch?: string; error?: string }
    expect(created, JSON.stringify(created)).toMatchObject({ branch: 'topic/created' })
    const after = await get<{ branches: Array<{ name: string; current: boolean }> }>(
      base, `/branches?${query}`,
    )
    expect(after.branches.find(branch => branch.name === 'topic/created')?.current).toBe(true)
  })

  it('diffs a merge commit against its first parent', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const { dir, git } = await repo()
    const base = harness.ctx.web.url
    const main = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir }).toString().trim()

    git('checkout', '-qb', 'side')
    await writeFile(join(dir, 'side.txt'), 'side\n')
    git('add', '-A')
    git('commit', '-qm', 'side work')

    git('checkout', '-q', main)
    await writeFile(join(dir, 'main.txt'), 'main\n')
    git('add', '-A')
    git('commit', '-qm', 'main work')
    git('merge', '--no-ff', 'side', '-m', 'merge side')

    const active = await session(harness, dir)
    const query = `sessionId=${active.id}`
    const log = await get<{ commits: Array<{ hash: string; subject: string; parents: string[] }> }>(
      base, `/log?${query}`,
    )
    const merge = log.commits.find(commit => commit.subject === 'merge side')!
    expect(merge.parents).toHaveLength(2)

    const detail = await get<{ files: Array<{ path: string; status: string; added: number }> }>(
      base, `/commit?${query}&hash=${merge.hash}`,
    )
    expect(detail.files).toEqual([expect.objectContaining({ path: 'side.txt', status: 'A', added: 1 })])

    const patch = await get<{ diff: string }>(
      base, `/diff?${query}&path=side.txt&scope=commit&hash=${merge.hash}`,
    )
    expect(patch.diff).toContain('+side')

    const sideLog = await get<{ commits: Array<{ subject: string }> }>(
      base, `/log?${query}&ref=side`,
    )
    expect(sideLog.commits.map(commit => commit.subject)).toEqual(['side work', 'init'])

    const missingRef = await fetch(`${base}/api/git/log?${query}&ref=missing-branch`)
    expect(missingRef.status).toBe(404)
  })

  it('reports a non-repository, unborn history and guards paths', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url

    const plain = await mkdtemp(join(tmpdir(), 'rbh-plain-'))
    dirs.push(plain)
    const plainSession = await session(harness, plain)
    const info = await get<{ available: boolean; branch: string | null }>(
      base, `/info?sessionId=${plainSession.id}`,
    )
    expect(info.available).toBe(false)
    expect(info.branch).toBeNull()

    const empty = await mkdtemp(join(tmpdir(), 'rbh-empty-'))
    dirs.push(empty)
    execFileSync('git', ['init', '-q'], { cwd: empty })
    const emptySession = await session(harness, empty)
    const log = await get<{ commits: unknown[]; hasMore: boolean }>(
      base, `/log?sessionId=${emptySession.id}`,
    )
    expect(log).toEqual({ commits: [], hasMore: false })

    const escape = await fetch(
      `${base}/api/git/diff?sessionId=${emptySession.id}&path=../../etc/passwd&scope=working`,
    )
    expect(escape.status).toBe(403)

    const unknown = await fetch(`${base}/api/git/status?sessionId=missing`)
    expect(unknown.status).toBe(404)

    const noSession = await post(base, '/stage', { paths: ['a.txt'] })
    expect(noSession.status).toBe(400)
  })

  it('fetches, pulls and pushes against a local bare origin', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const { dir, git } = await repo()
    const remote = await mkdtemp(join(tmpdir(), 'rbh-remote-'))
    dirs.push(remote)
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote })
    git('remote', 'add', 'origin', remote)
    const active = await session(harness, dir)
    const base = harness.ctx.web.url
    const query = `sessionId=${active.id}`

    const pushed = await post(base, '/push', { sessionId: active.id })
      .then(response => response.json() as Promise<{ output: string }>)
    expect(pushed.output).toBeTruthy()

    const clone = await mkdtemp(join(tmpdir(), 'rbh-clone-'))
    dirs.push(clone)
    execFileSync('git', ['clone', '-q', remote, clone])
    execFileSync('git', ['config', 'user.name', 'Other'], { cwd: clone })
    execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: clone })
    await writeFile(join(clone, 'a.txt'), 'remote\n')
    execFileSync('git', ['commit', '-qam', 'remote change'], { cwd: clone })
    execFileSync('git', ['push', '-q'], { cwd: clone })

    const pulled = await post(base, '/pull', { sessionId: active.id })
      .then(response => response.json() as Promise<{ output: string }>)
    expect(pulled.output).toBeTruthy()
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir }).toString().trim())
      .toBe('remote change')

    const fetched = await post(base, '/fetch', { sessionId: active.id })
      .then(response => response.json() as Promise<{ output: string }>)
    expect(fetched.output).toBeTruthy()
  })
})
