import { FileTextIcon, ImageIcon } from './Icons.tsx'

interface FileType {
  glyph: string
  className: string
}

const TYPES: Array<{ test: RegExp; type: FileType }> = [
  { test: /\.(ts|tsx|mts|cts)$/i, type: { glyph: '<>', className: 'ft-ts' } },
  { test: /\.(js|jsx|mjs|cjs)$/i, type: { glyph: '<>', className: 'ft-js' } },
  { test: /\.(json|jsonl|json5)$/i, type: { glyph: '{}', className: 'ft-json' } },
  { test: /\.(css|scss|less)$/i, type: { glyph: '#', className: 'ft-css' } },
  { test: /\.(html?|xml|vue)$/i, type: { glyph: '<>', className: 'ft-html' } },
  { test: /\.(md|markdown|mdx)$/i, type: { glyph: 'M', className: 'ft-md' } },
  { test: /\.(ya?ml)$/i, type: { glyph: 'Y', className: 'ft-yaml' } },
  { test: /\.(sh|bash|zsh)$/i, type: { glyph: '$', className: 'ft-sh' } },
  { test: /\.(py)$/i, type: { glyph: 'Py', className: 'ft-py' } },
  { test: /\.(toml|ini|conf)$/i, type: { glyph: '=', className: 'ft-conf' } },
]

export function fileType(path: string): FileType | undefined {
  return TYPES.find(entry => entry.test.test(path))?.type
}

/** Compact, color-coded file badge; images fall back to an outline icon. */
export function FileTypeIcon({ path, size = 12 }: { path: string; size?: number }) {
  if (/\.(png|jpe?g|gif|webp|ico|bmp|svg)$/i.test(path)) {
    return <span className="ft-icon ft-image"><ImageIcon size={size} /></span>
  }
  const type = fileType(path)
  if (!type) {
    return <span className="ft-icon ft-default"><FileTextIcon size={size} /></span>
  }
  return (
    <span
      className={`ft-icon ${type.className}`}
      style={{ fontSize: Math.max(7, size - 3) }}
      aria-hidden
    >
      {type.glyph}
    </span>
  )
}
