#!/usr/bin/env node
/**
 * Assemble the runtime tree the packaged desktop starts.
 *
 * `pnpm deploy --prod` materializes the plugin closure as real packages (no
 * dev toolchain: Electron, Vite, TypeScript and Biome stay out), which keeps
 * the installer an order of magnitude smaller than shipping the checkout's
 * `node_modules`. The harness CLI and UI dist are added beside it.
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const app = join(root, 'apps/desktop-runtime')
const out = join(app, 'dist/harness')

const sync = spawnSync(process.execPath, [join(root, 'apps/desktop/scripts/sync-runtime.mjs'), '--check'], {
  stdio: 'inherit',
})
if (sync.status !== 0) process.exit(sync.status ?? 1)

if (!existsSync(join(root, 'packages/ui-app/dist/index.html'))) {
  console.error('packages/ui-app/dist is missing; run pnpm build:ui first')
  process.exit(1)
}

rmSync(join(app, 'dist'), { recursive: true, force: true })

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const deploy = spawnSync(pnpm, [
  '--filter', '@ruobai/desktop-runtime',
  'deploy', '--prod', '--legacy', out,
], {
  cwd: root,
  stdio: 'inherit',
  // Node refuses to spawn .cmd shims without a shell on Windows.
  shell: process.platform === 'win32',
})
if (deploy.error) {
  console.error(deploy.error)
  process.exit(1)
}
if (deploy.status !== 0) process.exit(deploy.status ?? 1)

cpSync(join(root, 'cordis.yml'), join(out, 'cordis.yml'))
cpSync(join(root, 'packages/ui-app/dist'), join(out, 'ui-app/dist'), { recursive: true })

const entry = join(out, 'node_modules/@ruobai/harness-cli/src/bin.ts')
if (!existsSync(entry)) {
  console.error(`deployed entry is missing: ${entry}`)
  process.exit(1)
}

console.log(`runtime ready: ${out}`)
