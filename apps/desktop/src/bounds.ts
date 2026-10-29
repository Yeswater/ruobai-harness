export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export const MIN_WIDTH = 900
export const MIN_HEIGHT = 600
/** Keep at least this much of a restored window reachable on screen. */
const VISIBLE_X = 80
const VISIBLE_Y = 40

function finite(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Fit a saved window rectangle into the current work area.
 *
 * Displays change between runs, so a rectangle that is valid on one screen can
 * land entirely off another. The result always overlaps the work area by at
 * least `VISIBLE_X` × `VISIBLE_Y`.
 */
export function clampToWorkArea(saved: Partial<Rect> | undefined, workArea: Rect, fallback: Size): Rect {
  const width = clamp(finite(saved?.width, fallback.width), MIN_WIDTH, workArea.width)
  const height = clamp(finite(saved?.height, fallback.height), MIN_HEIGHT, workArea.height)

  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
    return {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    }
  }

  const x = width === workArea.width
    ? workArea.x
    : clamp(saved.x as number, workArea.x - width + VISIBLE_X, workArea.x + workArea.width - VISIBLE_X)
  const y = height === workArea.height
    ? workArea.y
    : clamp(saved.y as number, workArea.y - height + VISIBLE_Y, workArea.y + workArea.height - VISIBLE_Y)

  return { x, y, width, height }
}
