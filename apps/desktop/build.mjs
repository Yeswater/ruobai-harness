import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))

await mkdir(join(dir, 'dist'), { recursive: true })

// Electron's main process runs Node, not TypeScript. One bundle keeps the
// entry plain JS while every native module stays external.
await build({
  entryPoints: [join(dir, 'src/main.ts')],
  outfile: join(dir, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
})
