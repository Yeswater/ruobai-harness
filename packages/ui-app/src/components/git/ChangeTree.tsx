import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ChevronRightIcon, FolderIcon } from '../Icons.tsx'
import { FileTypeIcon } from '../FileTypeIcon.tsx'
import {
  descendants, entryKey, statOf, statusClass, statusOf, statusTitle,
  type ChangeEntry, type PathNode,
} from './model.ts'

interface ChangeTreeProps {
  entries: ChangeEntry[]
  tree: PathNode
  grouped: boolean
  selectable: boolean
  selected: Record<string, boolean>
  collapsed: Set<string>
  activeKey?: string
  onToggle: (path: string, value: boolean) => void
  onTogglePaths: (paths: string[], value: boolean) => void
  onToggleDir: (path: string) => void
  onActivate: (entry: ChangeEntry) => void
  onContextMenu: (event: ReactMouseEvent, entry: ChangeEntry) => void
  renderDiff?: (entry: ChangeEntry) => ReactNode
  emptyText: string
}

function TriStateCheckbox({ checked, mixed, onChange, label }: {
  checked: boolean
  mixed: boolean
  onChange: () => void
  label: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      aria-checked={mixed ? 'mixed' : checked}
      onChange={onChange}
      onClick={event => event.stopPropagation()}
    />
  )
}

interface EntryRowProps {
  entry: ChangeEntry
  display: string
  selectable: boolean
  selected: boolean
  active: boolean
  onToggle: (path: string, value: boolean) => void
  onActivate: (entry: ChangeEntry) => void
  onContextMenu: (event: ReactMouseEvent, entry: ChangeEntry) => void
  renderDiff?: (entry: ChangeEntry) => ReactNode
}

function EntryRow({
  entry, display, selectable, selected, active, onToggle, onActivate, onContextMenu, renderDiff,
}: EntryRowProps) {
  const letter = statusOf(entry.change, entry.side)
  const stat = statOf(entry.change, entry.side)
  const slash = display.lastIndexOf('/')
  const dir = slash >= 0 ? display.slice(0, slash + 1) : ''
  const name = slash >= 0 ? display.slice(slash + 1) : display
  return (
    <>
      <div
        className={`git-row ${active ? 'selected' : ''}`}
        onContextMenu={event => onContextMenu(event, entry)}
      >
        {selectable
          ? (
            <input
              type="checkbox"
              checked={selected}
              aria-label={`选择 ${entry.change.path}`}
              onChange={() => onToggle(entry.change.path, !selected)}
              onClick={event => event.stopPropagation()}
            />
          )
          : <span className="git-row-spacer" />}
        <span className={`git-status git-status-${statusClass(letter)}`} title={statusTitle(letter)}>
          {letter}
        </span>
        <FileTypeIcon path={entry.change.path} size={12} />
        <button
          className="git-row-open"
          onClick={() => onActivate(entry)}
          title={entry.change.path}
        >
          {dir ? <span className="git-path-dir">{dir}</span> : null}
          <span className="git-path-name">{name}</span>
          {stat
            ? (
              <span className="change-stats">
                <span className="add">+{stat.added}</span>
                <span className="del">-{stat.removed}</span>
              </span>
            )
            : null}
        </button>
      </div>
      {active && renderDiff ? renderDiff(entry) : null}
    </>
  )
}

/** Staged/unstaged file rows, flat or grouped by directory. */
export function ChangeTree(props: ChangeTreeProps) {
  const {
    entries, tree, grouped, selectable, selected, collapsed, activeKey,
    onToggle, onTogglePaths, onToggleDir, onActivate, onContextMenu, renderDiff, emptyText,
  } = props

  if (!entries.length) return <div className="detail-note">{emptyText}</div>

  const row = (entry: ChangeEntry, display: string) => (
    <EntryRow
      key={entryKey(entry)}
      entry={entry}
      display={display}
      selectable={selectable}
      selected={Boolean(selected[entry.change.path])}
      active={activeKey === entryKey(entry)}
      onToggle={onToggle}
      onActivate={onActivate}
      onContextMenu={onContextMenu}
      renderDiff={renderDiff}
    />
  )

  if (!grouped) {
    return <div className="git-rows">{entries.map(entry => row(entry, entry.change.path))}</div>
  }

  const node = (dir: PathNode): ReactNode => {
    const all = descendants(dir)
    const selectedCount = all.filter(entry => selected[entry.change.path]).length
    const open = !collapsed.has(dir.path)
    return (
      <div className="git-dir" key={dir.path}>
        <div className="git-dir-row" onClick={() => onToggleDir(dir.path)}>
          <span className={`git-caret ${open ? 'open' : ''}`}><ChevronRightIcon size={12} /></span>
          <FolderIcon size={13} />
          <span className="git-dir-name" title={dir.path}>{dir.name}</span>
          <span className="git-count">{all.length}</span>
          {selectable
            ? (
              <TriStateCheckbox
                checked={selectedCount === all.length}
                mixed={selectedCount > 0 && selectedCount < all.length}
                label={`选择 ${dir.path}`}
                onChange={() => onTogglePaths(
                  all.map(entry => entry.change.path),
                  selectedCount !== all.length,
                )}
              />
            )
            : null}
        </div>
        {open
          ? (
            <div className="git-dir-body">
              {dir.entries.map(entry => row(entry, entry.change.path.slice(dir.path.length + 1)))}
              {dir.children.map(node)}
            </div>
          )
          : null}
      </div>
    )
  }

  return (
    <div className="git-rows">
      {tree.entries.map(entry => row(entry, entry.change.path))}
      {tree.children.map(node)}
    </div>
  )
}
