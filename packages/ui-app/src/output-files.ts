/**
 * Which files the session's output list shows, and how it labels them.
 *
 * Claude Code's transcript does not print every path the run touched: it shows
 * the files that carry meaning (source, docs, config) with a type badge, and
 * leaves build output, dependencies and runtime state out. The session panel's
 * output list wants the same filter — a `checkpoint` fires for every write, so a
 * `pnpm install` or a dev-server build would otherwise bury the two files the
 * user cares about.
 */

/** Directories that are never "output" in the sense the panel means. */
const NOISE_PREFIXES = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '.git/',
  '.sessions/',
  '.ruobai/',
  '.idea/',
  '.vscode/',
]

const NOISE_FILES = new Set([
  '.DS_Store',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
])

/** Extensions whose content is not something a person reads in a list. */
const NOISE_EXT = /\.(map|log|lock|tmp|temp|swp|bak|orig|rej|pyc|pyo|o|a|so|dylib|dll|exe|class|jar|wasm)$/i

/** Long-form binary or media: shown only when the run produced nothing else. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|avif|mp4|mov|avi|webm|mp3|wav|flac|ogg|zip|tar|gz|bz2|xz|7z|rar|pdf|docx?|xlsx?|pptx?|ttf|otf|woff2?)$/i

export interface OutputLike {
  path: string
  tool?: string
  afterBytes?: number
}

/**
 * True for build artefacts, dependencies, locks and runtime state.
 *
 * Matched on any depth (`packages/x/dist/`), because a monorepo keeps them
 * below the root as often as at it.
 */
export function noisePath(path: string) {
  if (!path) return true
  const clean = path.replace(/^\.\//, '')
  const name = clean.split('/').pop() ?? clean
  if (NOISE_FILES.has(name)) return true
  if (NOISE_EXT.test(name)) return true
  const segments = clean.split('/')
  return segments.some(segment => NOISE_PREFIXES.includes(`${segment}/`))
}

/**
 * The files worth listing, newest first, plus what was left out.
 *
 * Binaries are dropped only when there is something readable to show instead: a
 * screenshot-only run still has to report its screenshot.
 */
export function selectOutputs<T extends OutputLike>(items: T[]) {
  const readable: T[] = []
  const binary: T[] = []
  let hidden = 0

  for (const item of items) {
    if (noisePath(item.path)) {
      hidden += 1
      continue
    }
    if (BINARY_EXT.test(item.path)) binary.push(item)
    else readable.push(item)
  }

  const kept = readable.length || !binary.length ? readable : binary
  return {
    kept,
    /** How many noise paths the filter removed, so the UI can say so. */
    hidden: hidden + (kept === readable ? binary.length : 0),
  }
}
