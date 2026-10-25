import { describe, expect, it } from 'vitest'
import type { GitChange, GitCommit } from '@ruobai/git/types'
import {
  buildPathTree, buildTree, computeGraph, countDiff, groupChanges, parseDiff, parseRef,
  relativeTime, statusOf,
} from '../src/components/git/model.ts'

function change(overrides: Partial<GitChange> & { path: string }): GitChange {
  return {
    index: '.',
    worktree: '.',
    untracked: false,
    conflicted: false,
    staged: false,
    unstaged: false,
    ...overrides,
  }
}

function commit(hash: string, ...parents: string[]): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    author: 'Test',
    email: 'test@example.com',
    date: '2026-10-25T10:00:00+08:00',
    subject: hash,
    refs: [],
  }
}

describe('git model', () => {
  it('splits changes into conflicted, staged and unstaged groups', () => {
    const groups = groupChanges([
      change({ path: 'both.txt', index: 'M', worktree: 'M', staged: true, unstaged: true }),
      change({ path: 'staged.txt', index: 'A', staged: true }),
      change({ path: 'untracked.txt', index: '?', worktree: '?', untracked: true, unstaged: true }),
      change({ path: 'conflict.txt', index: 'U', worktree: 'U', conflicted: true, staged: true, unstaged: true }),
    ])
    expect(groups.conflicted.map(entry => entry.change.path)).toEqual(['conflict.txt'])
    expect(groups.staged.map(entry => entry.change.path)).toEqual(['both.txt', 'staged.txt'])
    expect(groups.unstaged.map(entry => entry.change.path)).toEqual(['both.txt', 'untracked.txt'])
  })

  it('reports the letter for each side of a change', () => {
    const both = change({ path: 'a.txt', index: 'A', worktree: 'D', staged: true, unstaged: true })
    expect(statusOf(both, 'staged')).toBe('A')
    expect(statusOf(both, 'working')).toBe('D')
    expect(statusOf(change({ path: 'b.txt', worktree: 'M', unstaged: true }), 'working')).toBe('M')
    expect(statusOf(change({ path: 'c.txt', index: '?', worktree: '?', untracked: true }), 'working')).toBe('?')
  })

  it('builds a directory tree and sorts directories before files', () => {
    const entries = groupChanges([
      change({ path: 'README.md', worktree: 'M', unstaged: true }),
      change({ path: 'src/app.ts', worktree: 'M', unstaged: true }),
      change({ path: 'src/deep/util.ts', worktree: 'M', unstaged: true }),
      change({ path: 'docs/a.md', worktree: 'M', unstaged: true }),
    ]).unstaged
    const tree = buildTree(entries)
    expect(tree.entries.map(entry => entry.change.path)).toEqual(['README.md'])
    expect(tree.children.map(node => node.name)).toEqual(['docs', 'src'])
    const src = tree.children[1]!
    expect(src.entries.map(entry => entry.change.path)).toEqual(['src/app.ts'])
    expect(src.children[0]!.path).toBe('src/deep')
  })

  it('builds a directory tree before files for any path list', () => {
    const tree = buildPathTree(
      [{ path: 'a/b.ts' }, { path: 'a/c.ts' }, { path: 'd.ts' }],
      item => item.path,
    )
    expect(tree.items.map(item => item.path)).toEqual(['d.ts'])
    expect(tree.children.map(node => node.name)).toEqual(['a'])
    expect(tree.children[0]!.items.map(item => item.path)).toEqual(['a/b.ts', 'a/c.ts'])
  })

  it('lays out lanes for linear history and merges', () => {
    const rows = computeGraph([
      commit('c1', 'c2'),
      commit('c2', 'c3'),
      commit('c3'),
    ])
    expect(rows.map(row => row.dot)).toEqual([0, 0, 0])
    expect(rows.every(row => row.width === 1)).toBe(true)

    const merged = computeGraph([
      commit('m', 'a', 'b'),
      commit('a', 'root'),
      commit('b', 'root'),
      commit('root'),
    ])
    expect(merged[0]!.dot).toBe(0)
    expect(merged[0]!.width).toBe(2)
    expect(merged.map(row => row.width)).toEqual([2, 2, 2, 2])
    expect(merged.map(row => row.dot)).toEqual([0, 0, 1, 0])
  })

  it('parses unified diffs with both side line numbers', () => {
    const lines = parseDiff([
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      '+three',
    ].join('\n'))
    expect(lines.map(line => line.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'add'])
    expect(lines[4]).toMatchObject({ oldLine: 1, newLine: 1 })
    expect(lines[5]).toMatchObject({ oldLine: 2 })
    expect(lines[6]).toMatchObject({ newLine: 2 })
    expect(lines[7]).toMatchObject({ newLine: 3 })
  })

  it('counts added and removed lines', () => {
    expect(countDiff('--- a\n+++ b\n+one\n+two\n-three\n context')).toEqual({ added: 2, removed: 1 })
    expect(countDiff()).toEqual({ added: 0, removed: 0 })
  })

  it('classifies decorations by kind', () => {
    expect(parseRef('HEAD -> main', [])).toMatchObject({ kind: 'head', label: 'main' })
    expect(parseRef('origin/main', ['origin'])).toMatchObject({ kind: 'remote' })
    expect(parseRef('feature/x', ['origin'])).toMatchObject({ kind: 'local' })
    expect(parseRef('tag: v1.0.0', [])).toMatchObject({ kind: 'tag', label: 'v1.0.0' })
  })

  it('formats relative dates', () => {
    expect(relativeTime(new Date().toISOString())).toBe('刚刚')
    expect(relativeTime('not a date')).toBe('not a date')
  })
})
