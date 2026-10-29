/**
 * The right-hand column's views, as data.
 *
 * Kept out of the component so the list can be asserted without pulling xterm
 * and the file browser into a test. Each view needs a label: the panel no longer
 * prints its name at the top-left, so the label is what the close button and the
 * toolbar tooltip read from — a view added without one would announce nothing.
 */
export type FileView = 'files' | 'git' | 'preview' | 'terminal'

export const TITLES: Record<FileView, string> = {
  files: '文件',
  git: 'Git',
  preview: '预览',
  terminal: '终端',
}

export const FILE_VIEWS = Object.keys(TITLES) as FileView[]

/** The toolbar buttons, in the order they appear. */
export const TOOLBAR_VIEWS: FileView[] = ['files', 'git', 'preview', 'terminal']
