import { useEffect, useState } from 'react'
import { useEscapeKey } from '../useEscapeKey.ts'
import { api, type WorkspaceBrowse } from '../api.ts'
import { ChevronRightIcon, CloseIcon, FolderIcon } from './Icons.tsx'

interface WorkspacePickerProps {
  open: boolean
  recent: string[]
  onClose: () => void
  onPick: (path: string) => void
}

function nameOf(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

export function WorkspacePicker({ open, recent, onClose, onPick }: WorkspacePickerProps) {
  const [browse, setBrowse] = useState<WorkspaceBrowse | null>(null)
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (target?: string) => {
    setLoading(true)
    setError(null)
    try {
      const next = await api.browseWorkspace(target)
      setBrowse(next)
      setPath(next.path)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setBrowse(null)
    setError(null)
    void load()
  }, [open])

  useEscapeKey(onClose, open)

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal workspace-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Choose workspace"
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>选择工作区</h2>
            <div className="modal-sub">每个会话绑定一个文件夹，文件工具和右侧面板都以它为根。</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close workspace picker"><CloseIcon /></button>
        </div>

        {recent.length ? (
          <div className="workspace-recents">
            <div className="detail-section">最近使用</div>
            <div className="workspace-recent-list">
              {recent.map(item => (
                <button key={item} className="workspace-recent" onClick={() => onPick(item)} title={item}>
                  <FolderIcon size={14} />
                  <span className="workspace-recent-name">{nameOf(item)}</span>
                  <span className="workspace-recent-path mono">{item}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="workspace-pathbar">
          <button
            className="btn ghost compact"
            onClick={() => browse?.parent && load(browse.parent)}
            disabled={!browse?.parent || loading}
            title="上一级"
          >
            ..
          </button>
          <button
            className="btn ghost compact"
            onClick={() => browse?.home && load(browse.home)}
            disabled={!browse?.home || loading}
          >
            家目录
          </button>
          <input
            className="workspace-path-input mono"
            value={path}
            onChange={event => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void load(path)
            }}
            aria-label="Directory path"
            placeholder="/Users/you/code/project"
          />
          <button className="btn ghost compact" onClick={() => void load(path)} disabled={loading}>前往</button>
        </div>

        <div className="workspace-dirs">
          {loading
            ? <div className="loading">loading…</div>
            : browse
              ? browse.entries.length
                ? browse.entries.map(entry => (
                  <button
                    key={entry.path}
                    className="workspace-dir"
                    onClick={() => void load(entry.path)}
                    title={entry.path}
                  >
                    <FolderIcon size={15} />
                    <span>{entry.name}</span>
                    <ChevronRightIcon size={13} />
                  </button>
                ))
                : <div className="detail-note">这个目录下没有子文件夹。</div>
              : null}
        </div>

        {error ? <div className="detail-note error">{error}</div> : null}

        <div className="modal-foot workspace-foot">
          <span className="workspace-current mono ellipsis" title={browse?.path}>{browse?.path ?? ''}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn" disabled={!browse?.path || loading} onClick={() => browse && onPick(browse.path)}>
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  )
}
