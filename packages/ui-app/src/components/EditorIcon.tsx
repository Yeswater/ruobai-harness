import type { ReactNode } from 'react'

/**
 * Brand marks for the apps the workspace can be opened in.
 *
 * These are recognisable approximations drawn in SVG rather than the vendors'
 * actual artwork: the button is 20–24px, and a bitmap icon per editor would mean
 * shipping (and licensing) every logo. The shape carries the identity — a
 * bow-tie for VS Code, a hammer for Xcode, letters for the JetBrains IDEs —
 * while colours stay in the same family as the real marks.
 */
interface EditorIconProps {
  id: string
  name?: string
  size?: number
}

interface Mark {
  /** Tile fill. */
  bg: string
  /** Foreground geometry drawn over the tile. */
  glyph: ReactNode
}

const TILE = 22
const RADIUS = 5.5

/** JetBrains IDEs share one tile colour and differ only in their letters. */
const JETBRAINS = '#c14f7f'

const LABEL = {
  textAnchor: 'middle',
  fontSize: 9.5,
  fontWeight: 700,
  fill: '#fff',
  fontFamily: 'var(--sans)',
} as const

const MARKS: Record<string, Mark> = {
  vscode: {
    bg: '#0f8ae0',
    glyph: (
      <>
        {/* The bow-tie: right blade plus the two left folds. */}
        <path d="M16.7 4.4 9.6 11.9l7.1 7.6 2.3-1.2V5.6z" fill="#fff" opacity=".95" />
        <path d="M9.6 11.9 5.3 8.4 3.7 9.3v5.4l1.6.9z" fill="#fff" opacity=".72" />
      </>
    ),
  },
  cursor: {
    bg: '#16181d',
    glyph: (
      <>
        <path d="M12 5.4 18.4 17H5.6z" fill="#fff" opacity=".92" />
        <path d="M12 5.4 18.4 17h-4.1z" fill="#8b7cf6" />
      </>
    ),
  },
  zed: {
    bg: '#2b2a33',
    glyph: <path d="M7.8 7.2h8.4l-8.4 9.6h8.4" stroke="#f5f5f7" strokeWidth="2.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />,
  },
  windsurf: {
    bg: '#0b7f6b',
    glyph: <path d="M6.2 15.4c2.6 0 3.5-2.5 4.5-5 1-2.5 2-5 4.3-5 1.8 0 2.9 1.5 2.9 3.5" stroke="#eafaf6" strokeWidth="2.1" fill="none" strokeLinecap="round" />,
  },
  idea: {
    bg: JETBRAINS,
    glyph: <text x="11.5" y="16.2" {...LABEL}>IJ</text>,
  },
  webstorm: {
    bg: JETBRAINS,
    glyph: <text x="11.5" y="16.2" {...LABEL}>WS</text>,
  },
  pycharm: {
    bg: JETBRAINS,
    glyph: <text x="11.5" y="16.2" {...LABEL}>PC</text>,
  },
  goland: {
    bg: JETBRAINS,
    glyph: <text x="11.5" y="16.2" {...LABEL}>GO</text>,
  },
  rider: {
    bg: JETBRAINS,
    glyph: <text x="11.5" y="16.2" {...LABEL}>R#</text>,
  },
  sublime: {
    bg: '#ff9800',
    glyph: <text x="11.5" y="16.2" {...LABEL}>S</text>,
  },
  xcode: {
    bg: '#1f7ae0',
    glyph: (
      <>
        <path d="M6.4 15.6 15 6.6l2.4 2.2-8.6 9z" fill="#fff" />
        <path d="M13.2 5.6 16 4.2l3.4 6.5-1.9 1z" fill="#fff" opacity=".85" />
      </>
    ),
  },
  // The file manager: Finder's face on macOS, a folder elsewhere.
  system: {
    bg: '#2f8bf0',
    glyph: (
      <>
        <path d="M12 3.4c-4.2 0-7.3 3.6-7.3 8.1S7.8 19.6 12 19.6s7.3-3.6 7.3-8.1S16.2 3.4 12 3.4z" fill="#fff" opacity=".92" />
        <path d="M6.1 12h11.8" stroke="#2f8bf0" strokeWidth="1.1" />
        <ellipse cx="9.4" cy="9.6" rx=".95" ry="1.5" fill="#2f8bf0" />
        <ellipse cx="14.6" cy="9.6" rx=".95" ry="1.5" fill="#2f8bf0" />
        <path d="M9 14.4c.9.9 1.9 1.3 3 1.3s2.1-.4 3-1.3" stroke="#2f8bf0" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  terminal: {
    bg: '#20232a',
    glyph: (
      <>
        <path d="M6 8.6 10 12l-4 3.4" stroke="#e9ecef" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M11.6 15.8h6.2" stroke="#e9ecef" strokeWidth="1.9" strokeLinecap="round" />
      </>
    ),
  },
}

export function EditorIcon({ id, name = '', size = 20 }: EditorIconProps) {
  const mark = MARKS[id.toLowerCase()]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      {mark
        ? <>{tile(mark.bg)}{mark.glyph}</>
        : (
          <>
            {tile('var(--border-strong)')}
            <text x="11.5" y="16" textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--panel)" fontFamily="var(--sans)">
              {(name.trim()[0] ?? '?').toUpperCase()}
            </text>
          </>
        )}
    </svg>
  )
}

function tile(fill: string) {
  return <rect x="1" y="1" width={TILE} height={TILE} rx={RADIUS} fill={fill} />
}
