#!/usr/bin/env node
/**
 * Run the test suite (or one file) against an untouched ref in a throwaway
 * worktree.
 *
 * The alternative — `git stash` — edits the working tree, and a failed pop
 * after an interrupted run loses in-flight changes. A detached worktree is a
 * read-only snapshot of the commit and never touches the current checkout.
 *
 *   node scripts/test-baseline.mjs                       # HEAD, full suite
 *   node scripts/test-baseline.mjs --ref origin/main     # another ref
 *   node scripts/test-baseline.mjs packages/x/tests/a.spec.ts
 *   node scripts/test-baseline.mjs --keep                # leave the tree for inspection
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const argv = process.argv.slice(2)
const options = { ref: 'HEAD', keep: false, files: [] }
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index]
  if (value === '--ref') options.ref = argv[++index] ?? 'HEAD'
  else if (value === '--keep') options.keep = true
  else if (value === '--help' || value === '-h') {
    console.log('usage: node scripts/test-baseline.mjs [--ref REF] [--keep] [test file ...]')
    process.exit(0)
  } else options.files.push(value)
}

const repo = run('git', ['rev-parse', '--show-toplevel'], process.cwd()).trim()
const sha = run('git', ['rev-parse', '--short', options.ref], repo).trim()
const dir = mkdtempSync(join(tmpdir(), 'rbh-baseline-'))
const tree = join(dir, 'tree')

// A path typed relative to the current checkout has to be re-expressed
// relative to the worktree root.
const files = options.files.map((file) => {
  const absolute = resolve(process.cwd(), file)
  return relative(repo, absolute).split('\\').join('/')
})

console.log(`baseline ${options.ref} (${sha})`)
console.log(`worktree ${tree}`)

try {
  run('git', ['worktree', 'add', '--detach', tree, options.ref], repo)
  console.log('installing dependencies offline…')
  run('pnpm', ['install', '--offline', '--frozen-lockfile'], tree, { stdio: 'inherit' })

  const started = Date.now()
  const args = files.length ? ['exec', 'vitest', 'run', ...files] : ['test']
  const result = spawnSync('pnpm', args, { cwd: tree, stdio: 'inherit' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\nbaseline finished in ${seconds}s with exit code ${result.status ?? 1}`)
  process.exitCode = result.status ?? 1
} finally {
  if (options.keep) {
    console.log(`kept: ${tree}`)
  } else {
    const removed = spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: repo })
    if (removed.status !== 0) console.warn(`could not remove worktree ${tree}; remove it with: git worktree remove --force ${tree}`)
    rmSync(dir, { recursive: true, force: true })
  }
}

function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', ...extra })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr ?? '').trim().slice(0, 500)}`)
  }
  return result.stdout ?? ''
}
