import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Workspace packages export their TypeScript source; resolve through the
  // tsconfig paths so Vite transforms them instead of Node loading them raw.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    include: [
      'packages/*/tests/**/*.spec.ts',
      'apps/*/tests/**/*.spec.ts',
    ],
    testTimeout: 10_000,
  },
})
