import { defineConfig } from 'vite'

export default defineConfig({
  // React's automatic JSX runtime comes from esbuild; no plugin needed.
  esbuild: { jsx: 'automatic' },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
