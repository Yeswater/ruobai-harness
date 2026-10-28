#!/usr/bin/env node
/**
 * Run one test file repeatedly and report the pass/fail sequence.
 *
 * A single green run says nothing about a test that failed once; this keeps the
 * experiment in one command and reports the failure tail from every bad run.
 *
 *   node scripts/test-flake.mjs packages/memory-distill/tests/x.spec.ts
 *   node scripts/test-flake.mjs packages/x/tests/a.spec.ts --runs 5
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const options = { runs: 3, file: undefined }
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index]
  if (value === '--runs') options.runs = Math.max(1, Number(argv[++index]) || 3)
  else if (value === '--help' || value === '-h') {
    console.log('usage: node scripts/test-flake.mjs <test file> [--runs N]')
    process.exit(0)
  } else if (!options.file) options.file = value
}

if (!options.file) {
  console.error('usage: node scripts/test-flake.mjs <test file> [--runs N]')
  process.exit(2)
}

const file = resolve(process.cwd(), options.file)
const results = []
console.log(`${options.file} · ${options.runs} run(s)\n`)

for (let run = 1; run <= options.runs; run += 1) {
  const started = Date.now()
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', file], { encoding: 'utf8' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const failed = result.status !== 0
  results.push({ run, failed, seconds, output: `${result.stdout ?? ''}${result.stderr ?? ''}` })
  console.log(`run ${run}: ${failed ? 'FAIL' : 'pass'} (${seconds}s)`)
  if (failed) {
    const tail = results.at(-1).output.trim().split('\n').slice(-25).join('\n')
    console.log(tail.replace(/^/gm, '    '))
    console.log('')
  }
}

const failures = results.filter(item => item.failed).length
console.log(`\n${options.runs - failures}/${options.runs} passed`)
if (failures) {
  console.log(`sequence: ${results.map(item => item.failed ? 'F' : '.').join('')}`)
  process.exitCode = 1
}
