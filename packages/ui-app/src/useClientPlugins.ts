import { useEffect } from 'react'

interface Manifest {
  plugins: Array<{ id: string; url: string }>
}

/** Loads every client half advertised by client-modules, once after mount. */
export function useClientPlugins() {
  useEffect(() => {
    let cancelled = false

    void (async () => {
      let manifest: Manifest
      try {
        const response = await fetch('/api/client-plugins')
        if (!response.ok) return
        manifest = await response.json() as Manifest
      } catch (error) {
        console.error('[client-plugin] manifest', error)
        return
      }

      for (const plugin of manifest.plugins ?? []) {
        if (cancelled) return
        try {
          const module = await import(/* @vite-ignore */ plugin.url)
          const register = module.default ?? module.register
          if (typeof register === 'function') register(window.__RBU__)
          else console.warn(`[client-plugin] ${plugin.id} has no default export`)
        } catch (error) {
          console.error(`[client-plugin] ${plugin.id}`, error)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])
}
