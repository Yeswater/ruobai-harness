import { useEffect, useState } from 'react'
import { api, type WorkspaceEntry } from '../api.ts'

export function FileBrowser() {
  const [tree, setTree] = useState<WorkspaceEntry | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']))
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<{ path: string; size: number; content: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.getWorkspaceTree('.')
      .then((root) => {
        if (!cancelled) setTree(root)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const open = (path: string) => {
    setSelected(path)
    setError(null)
    void api.readWorkspaceFile(path)
      .then(setFile)
      .catch((caught) => {
        setFile(null)
        setError(caught instanceof Error ? caught.message : String(caught))
      })
  }

  const toggle = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="files">
      <div className="file-tree">
        {tree
          ? (
            <TreeNode
              entry={tree}
              depth={0}
              expanded={expanded}
              selected={selected}
              onToggle={toggle}
              onOpen={open}
            />
          )
          : <div className="loading">loading workspace…</div>}
      </div>

      {error ? <div className="detail-note error">{error}</div> : null}

      {file
        ? (
          <div className="file-view">
            <div className="file-view-head">
              <span className="mono ellipsis">{file.path}</span>
              <span className="muted">{formatBytes(file.size)}</span>
            </div>
            <pre className="file-content">{file.content}</pre>
          </div>
        )
        : <div className="file-hint">选择一个文件查看内容</div>}
    </div>
  )
}

interface TreeNodeProps {
  entry: WorkspaceEntry
  depth: number
  expanded: Set<string>
  selected: string | null
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}

function TreeNode({ entry, depth, expanded, selected, onToggle, onOpen }: TreeNodeProps) {
  const directory = entry.type === 'directory'
  const open = expanded.has(entry.path)

  return (
    <div>
      <button
        className={`tree-row ${selected === entry.path ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => directory ? onToggle(entry.path) : onOpen(entry.path)}
        title={entry.path}
      >
        <span className="tree-caret">{directory ? (open ? '▾' : '▸') : ''}</span>
        <span className="tree-name">{entry.name}{directory ? '/' : ''}</span>
      </button>
      {directory && open
        ? entry.children?.map(child => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            expanded={expanded}
            selected={selected}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))
        : null}
    </div>
  )
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
