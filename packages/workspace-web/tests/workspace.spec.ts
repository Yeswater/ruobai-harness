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

  it('reports git state and commits the session workspace', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url
    const dir = await mkdtemp(join(tmpdir(), 'rbh-git-web-'))
    dirs.push(dir)

    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init')
    git('config', 'user.name', 'Harness Test')
    git('config', 'user.email', 'harness@example.com')
    await writeFile(join(dir, 'notes.txt'), 'first')
    git('add', '-A')
    git('commit', '-m', 'init')

    const session = harness.ctx.sessions.create({ title: 'git', workspace: dir })
    const infoUrl = `${base}/api/workspace/git?sessionId=${session.id}`

    const clean = await (await fetch(infoUrl)).json() as {
      available: boolean; branch: string | null; files: number
    }
    expect(clean.available).toBe(true)
    expect(clean.branch).toBeTruthy()
    expect(clean.files).toBe(0)

    await writeFile(join(dir, 'notes.txt'), 'second\nthird')

    const dirty = await (await fetch(infoUrl)).json() as {
      files: number; added: number; removed: number
    }
    expect(dirty.files).toBe(1)
    expect(dirty.added).toBe(2)
    expect(dirty.removed).toBe(1)

    const missingMessage = await fetch(`${base}/api/workspace/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id }),
    })
    expect(missingMessage.status).toBe(400)

    const committed = await (await fetch(`${base}/api/workspace/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'update notes' }),
    })).json() as { ok: boolean; commit: string }
    expect(committed.ok).toBe(true)
    expect(committed.commit).toContain('update notes')

    const after = await (await fetch(infoUrl)).json() as { files: number }
    expect(after.files).toBe(0)
  })

  it('lists working-tree files, per-file diffs and commits selected paths', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url
    const dir = await mkdtemp(join(tmpdir(), 'rbh-git-files-'))
    dirs.push(dir)

    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init')
    git('config', 'user.name', 'Harness Test')
    git('config', 'user.email', 'harness@example.com')
    await writeFile(join(dir, 'a.txt'), 'one\n')
    await writeFile(join(dir, 'b.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-m', 'init')

    await writeFile(join(dir, 'a.txt'), 'two\n')
    await writeFile(join(dir, 'b.txt'), 'two\n')
    await writeFile(join(dir, 'c.txt'), 'new\n')

    const session = harness.ctx.sessions.create({ title: 'files', workspace: dir })
    const listUrl = `${base}/api/workspace/git/files?sessionId=${session.id}`
    const files = await (await fetch(listUrl)).json() as {
      files: Array<{ path: string; status: string; staged: boolean }>
    }
    expect(files.files.map(file => file.path)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(files.files.find(file => file.path === 'a.txt')).toMatchObject({ status: 'M', staged: false })
    expect(files.files.find(file => file.path === 'c.txt')).toMatchObject({ status: '?' })

    const tracked = await (await fetch(
      `${base}/api/workspace/git/diff?sessionId=${session.id}&path=a.txt`,
    )).json() as { diff: string }
    expect(tracked.diff).toContain('+two')

    const untracked = await (await fetch(
      `${base}/api/workspace/git/diff?sessionId=${session.id}&path=c.txt`,
    )).json() as { diff: string }
    expect(untracked.diff).toContain('+new')

    const escape = await fetch(
      `${base}/api/workspace/git/diff?sessionId=${session.id}&path=../../etc/passwd`,
    )
    expect(escape.status).toBe(403)

    const committed = await (await fetch(`${base}/api/workspace/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'only a', paths: ['a.txt'] }),
    })).json() as { ok: boolean; commit: string }
    expect(committed.ok).toBe(true)
    expect(committed.commit).toContain('only a')

    const after = await (await fetch(listUrl)).json() as { files: Array<{ path: string }> }
    expect(after.files.map(file => file.path)).toEqual(['b.txt', 'c.txt'])
  })

  it('searches file contents and skips ignored directories', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url
    const dir = await mkdtemp(join(tmpdir(), 'rbh-grep-web-'))
    dirs.push(dir)
    await mkdir(join(dir, 'src'))
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'src', 'a.ts'), 'const needle = 1\n// needle\n')
    await writeFile(join(dir, 'node_modules', 'dep.ts'), 'needle should be ignored\n')

    const session = harness.ctx.sessions.create({ title: 'grep', workspace: dir })
    const body = await (await fetch(
      `${base}/api/workspace/grep?q=needle&sessionId=${session.id}`,
    )).json() as { matches: Array<{ path: string; line: number; text: string }> }

    expect(body.matches).toEqual([
      { path: 'src/a.ts', line: 1, text: 'const needle = 1' },
      { path: 'src/a.ts', line: 2, text: '// needle' },
    ])
  })

  it('compacts chains of single-child directories on request', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url
    const dir = await mkdtemp(join(tmpdir(), 'rbh-compact-tree-'))
    dirs.push(dir)
    await mkdir(join(dir, 'x', 'y', 'z'), { recursive: true })
    await writeFile(join(dir, 'x', 'y', 'z', 'file.txt'), 'x')
    await mkdir(join(dir, 'a', 'b', 'c'), { recursive: true })
    await mkdir(join(dir, 'a', 'b', 'd'), { recursive: true })
    const session = harness.ctx.sessions.create({ title: 'compact', workspace: dir })

    const compact = await (await fetch(
      `${base}/api/workspace/tree?path=.&depth=1&compact=1&sessionId=${session.id}`,
    )).json() as { tree: { children: Array<{ name: string; path: string }> } }
    expect(compact.tree.children.map(child => child.name)).toEqual(['a/b', 'x/y/z'])
    expect(compact.tree.children.map(child => child.path)).toEqual(['a/b', 'x/y/z'])

    const plain = await (await fetch(
      `${base}/api/workspace/tree?path=.&depth=1&sessionId=${session.id}`,
    )).json() as { tree: { children: Array<{ name: string }> } }
    expect(plain.tree.children.map(child => child.name)).toEqual(['a', 'x'])

    const inner = await (await fetch(
      `${base}/api/workspace/tree?path=x/y/z&depth=1&compact=1&sessionId=${session.id}`,
    )).json() as { tree: { children: Array<{ name: string; type: string }> } }
    expect(inner.tree.children).toEqual([expect.objectContaining({ name: 'file.txt', type: 'file' })])
  })

  it('validates open-in-editor requests before launching anything', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url
    const session = harness.ctx.sessions.create({ title: 'open', workspace: process.cwd() })
    const url = `${base}/api/workspace/open`

    const escape = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, path: '../../etc/passwd' }),
    })
    expect(escape.status).toBe(403)

    const unknown = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, editor: 'not-an-editor' }),
    })
    expect(unknown.status).toBe(400)
  })

  it('detects editors and always offers the file manager', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url
    const session = harness.ctx.sessions.create({ title: 'editors', workspace: process.cwd() })

    const listed = await (await fetch(
      `${base}/api/workspace/editors?sessionId=${session.id}`,
    )).json() as { editors: Array<{ id: string; name: string; kind: string }> }
    expect(listed.editors.length).toBeGreaterThan(0)
    expect(listed.editors.some(editor => editor.id === 'system' && editor.kind === 'folder')).toBe(true)
    expect(new Set(listed.editors.map(editor => editor.id)).size).toBe(listed.editors.length)
    expect(listed.editors.every(editor => editor.name.length > 0)).toBe(true)
  })

  it('marks a non-git workspace as unavailable', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const dir = await mkdtemp(join(tmpdir(), 'rbh-nogit-web-'))
    dirs.push(dir)
    const session = harness.ctx.sessions.create({ title: 'plain', workspace: dir })

    const info = await (await fetch(
      `${harness.ctx.web.url}/api/workspace/git?sessionId=${session.id}`,
    )).json() as { available: boolean; branch: string | null; workspace: string }
    expect(info.available).toBe(false)
    expect(info.branch).toBeNull()
    expect(info.workspace).toBe(dir)
  })

  it('searches files for composer mentions', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const base = harness.ctx.web.url
    const dir = await mkdtemp(join(tmpdir(), 'rbh-search-web-'))
    dirs.push(dir)
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'package.json'), '{}')
    await writeFile(join(dir, 'src', 'package-lock.json'), '{}')
    const session = harness.ctx.sessions.create({ title: 'search', workspace: dir })

    const found = await (await fetch(
      `${base}/api/workspace/search?q=package&limit=5&sessionId=${session.id}`,
    )).json() as {
      files: Array<{ path: string; type: string }>
    }
    expect(found.files.length).toBeLessThanOrEqual(5)
    expect(found.files.some(file => file.path === 'package.json')).toBe(true)

    const top = await (await fetch(
      `${base}/api/workspace/search?limit=50&sessionId=${session.id}`,
    )).json() as {
      files: Array<{ path: string }>
    }
    expect(top.files.length).toBeGreaterThan(0)
    expect(top.files.every(file => !file.path.includes('/'))).toBe(true)
  })
})
