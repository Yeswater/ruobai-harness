import { describe, expect, it } from 'vitest'
import { FILE_VIEWS, TITLES, TOOLBAR_VIEWS } from '../src/panel-views.ts'

/**
 * The right-hand column is a stack of cards: the session dock and the panel.
 * Both are rounded, and neither prints its own name at the top-left — the
 * labels below are what the close button and tooltips read from, so a view
 * added without one would announce nothing.
 */
describe('right-hand panel views', () => {
  it('carries the terminal as a panel view, not a separate bottom dock', () => {
    expect(FILE_VIEWS).toContain('terminal')
  })

  it('labels every view', () => {
    for (const view of FILE_VIEWS) {
      expect(TITLES[view], view).toBeTruthy()
    }
  })

  it('offers one toolbar button per view, in a stable order', () => {
    expect(TOOLBAR_VIEWS).toEqual(['files', 'git', 'preview', 'terminal'])
    for (const view of TOOLBAR_VIEWS) expect(FILE_VIEWS).toContain(view)
  })
})
