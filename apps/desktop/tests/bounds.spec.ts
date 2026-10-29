import { describe, expect, it } from 'vitest'
import { clampToWorkArea, MIN_HEIGHT, MIN_WIDTH } from '../src/bounds.ts'

const area = { x: 0, y: 25, width: 1440, height: 875 }

describe('clampToWorkArea', () => {
  it('centers the fallback size when nothing is saved', () => {
    expect(clampToWorkArea(undefined, area, { width: 1200, height: 800 })).toEqual({
      x: 120,
      y: 63,
      width: 1200,
      height: 800,
    })
  })

  it('never returns a window smaller than the minimum', () => {
    const bounds = clampToWorkArea({ x: 10, y: 10, width: 200, height: 100 }, area, { width: 1200, height: 800 })
    expect(bounds.width).toBe(MIN_WIDTH)
    expect(bounds.height).toBe(MIN_HEIGHT)
  })

  it('fits a window larger than the work area', () => {
    const bounds = clampToWorkArea({ x: -200, y: -100, width: 3000, height: 2000 }, area, { width: 1200, height: 800 })
    expect(bounds.width).toBe(area.width)
    expect(bounds.height).toBe(area.height)
    expect(bounds.x).toBe(area.x)
    expect(bounds.y).toBe(area.y)
  })

  it('keeps an off-screen window partly reachable', () => {
    const offRight = clampToWorkArea({ x: 5000, y: 40, width: 1000, height: 700 }, area, { width: 1200, height: 800 })
    expect(offRight.x).toBe(area.width - 80)

    const offBottom = clampToWorkArea({ x: 40, y: 9000, width: 1000, height: 700 }, area, { width: 1200, height: 800 })
    expect(offBottom.y).toBe(area.y + area.height - 40)
  })

  it('centers when the saved coordinates are not finite', () => {
    const bounds = clampToWorkArea({ x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 1000, height: 700 }, area, {
      width: 1200,
      height: 800,
    })
    expect(bounds.x).toBe(area.x + Math.round((area.width - 1000) / 2))
    expect(bounds.y).toBe(area.y + Math.round((area.height - 700) / 2))
  })
})
