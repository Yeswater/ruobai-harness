import { describe, expect, it } from 'vitest'
import { noisePath, selectOutputs } from '../src/output-files.ts'

describe('session output filter', () => {
  // The panel used to list every checkpoint, so a single `pnpm install` drowned
  // the two source files the user cared about.
  it('drops dependencies, build output and runtime state', () => {
    for (const path of [
      'node_modules/react/index.js',
      'packages/ui-app/dist/assets/index.js',
      '.ruobai/wiki/index.json',
      '.sessions/s1.jsonl',
      'pnpm-lock.yaml',
      'coverage/lcov.info',
      '.git/HEAD',
      'src/app.js.map',
      '.DS_Store',
    ]) {
      expect(noisePath(path), path).toBe(true)
    }
  })

  it('keeps source, docs and config', () => {
    for (const path of [
      'packages/ui-app/src/App.tsx',
      'docs/session-runtime.md',
      'cordis.yml',
      'package.json',
      'src/styles.css',
    ]) {
      expect(noisePath(path), path).toBe(false)
    }
  })

  it('matches noise at any depth', () => {
    expect(noisePath('packages/commit-prompt/dist/index.js')).toBe(true)
    expect(noisePath('./node_modules/ws/index.js')).toBe(true)
  })

  it('reports what it filtered instead of hiding it', () => {
    const { kept, hidden } = selectOutputs([
      { path: 'src/App.tsx' },
      { path: 'node_modules/x/index.js' },
      { path: 'dist/app.js' },
    ])
    expect(kept.map(item => item.path)).toEqual(['src/App.tsx'])
    expect(hidden).toBe(2)
  })

  it('still shows a screenshot when the run produced nothing readable', () => {
    const { kept } = selectOutputs([
      { path: 'docs/shot.png' },
      { path: '.ruobai/scratch/tmp.png' },
    ])
    expect(kept.map(item => item.path)).toEqual(['docs/shot.png'])
  })

  it('prefers readable files over binaries when both exist', () => {
    const { kept, hidden } = selectOutputs([
      { path: 'docs/cover.png' },
      { path: 'src/App.tsx' },
    ])
    expect(kept.map(item => item.path)).toEqual(['src/App.tsx'])
    expect(hidden).toBe(1)
  })
})
