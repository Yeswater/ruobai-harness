import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import GitService from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rbh-pr-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  await writeFile(join(root, 'a.txt'), 'one\n')
  git(root, 'add', 'a.txt')
  git(root, 'commit', '-m', 'init')

  const ctx = new Context()
  const plugin = ctx.plugin(GitService, {})
  await plugin
  cleanups.push(() => plugin.dispose())
  return { ctx, root }
}

describe('create pull request', () => {
  it('rejects an invalid branch or a path outside the workspace', async () => {
    const { ctx, root } = await setup()
    await expect(ctx.git.createPullRequest(root, {
      title: 'x', branch: '../bad', base: 'main', files: [],
    })).rejects.toThrow(/分支名/)

    await expect(ctx.git.createPullRequest(root, {
      title: 'x', branch: 'feat/x', base: 'main', files: ['../etc/passwd'],
    })).rejects.toThrow(/非法路径/)
  })

  it('refuses to create a PR from the base branch with nothing selected', async () => {
    const { ctx, root } = await setup()
    await expect(ctx.git.createPullRequest(root, {
      title: 'x', branch: 'feat/x', base: 'main', files: [],
    })).rejects.toThrow(/没有选中的改动/)
  })

  it('commits only the selected paths, leaving other staged work alone', async () => {
    const { ctx, root } = await setup()
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(root, 'b.txt'), 'other\n')
    git(root, 'add', 'b.txt')

    // No remote: the flow reaches the push step and fails there, after the
    // commit. That is exactly the state we want to inspect.
    await expect(ctx.git.createPullRequest(root, {
      title: 'feat: only a', branch: 'feat/a', base: 'main', files: ['a.txt'],
    })).rejects.toThrow(/找不到 GitHub 或 Gitee/)

    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/a')
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(['a.txt'])
    const status = git(root, 'status', '--porcelain')
    expect(status).toContain('b.txt')
    expect(status).not.toContain('a.txt')
  }, 20_000)
})
