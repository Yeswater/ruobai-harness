import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type WikiPageSummary } from '../api.ts'
import { useAnchoredMenu } from './AnchoredMenu.ts'
import { FileTextIcon, FolderTreeIcon, SearchIcon } from './Icons.tsx'

interface KnowledgePickerProps {
  open: boolean
  sessionId?: string
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onPick: (page: WikiPageSummary) => void
}

export function KnowledgePicker({ open, sessionId, disabled, onOpenChange, onPick }: KnowledgePickerProps) {
  const { triggerRef, menuRef, position } = useAnchoredMenu({
    open,
    onClose: () => onOpenChange(false),
    width: 340,
  })
  const [pages, setPages] = useState<WikiPageSummary[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (!sessionId) {
      setError('打开一个会话后才能连接项目知识库')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setQuery('')
    void api.getWikiPages(sessionId)
      .then((list) => {
        if (!cancelled) setPages(list)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  const term = query.trim().toLowerCase()
  const filtered = pages.filter(page =>
    !term
    || page.title.toLowerCase().includes(term)
    || page.id.toLowerCase().includes(term)
    || page.summary?.toLowerCase().includes(term))

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-knowledge ${open ? 'active' : ''}`}
        aria-label="连接知识库"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={sessionId ? '从知识库附加一页' : '打开会话后可连接知识库'}
        onClick={() => onOpenChange(!open)}
      >
        <FolderTreeIcon size={13} />
        <span>知识库</span>
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="view-menu knowledge-menu"
              role="dialog"
              aria-label="连接知识库"
              style={{
                left: position.left,
                width: position.width,
                ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
              }}
            >
              <div className="knowledge-search">
                <SearchIcon size={13} />
                <input
                  value={query}
                  autoFocus
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && filtered[0]) {
                      onPick(filtered[0])
                      onOpenChange(false)
                    }
                  }}
                  placeholder="搜索知识库页面"
                  aria-label="搜索知识库页面"
                />
              </div>

              <div className="knowledge-list">
                {loading
                  ? <div className="knowledge-empty">读取知识库…</div>
                  : error
                    ? <div className="knowledge-empty error">{error}</div>
                    : filtered.length
                      ? filtered.map(page => (
                        <button
                          key={page.id}
                          type="button"
                          className="knowledge-row"
                          onClick={() => {
                            onPick(page)
                            onOpenChange(false)
                          }}
                        >
                          <span className="knowledge-row-icon"><FileTextIcon size={14} /></span>
                          <span className="knowledge-row-copy">
                            <strong>{page.title}</strong>
                            <small>{page.id} · {page.status}{page.sourced === false ? ' · 未溯源' : ''}</small>
                          </span>
                        </button>
                      ))
                      : (
                        <div className="knowledge-empty">
                          {pages.length ? '没有匹配的页面' : '知识库还没有页面。在左侧功能区新建一页。'}
                        </div>
                      )}
              </div>

              <div className="knowledge-foot">选中后作为 Markdown 附件加入本条消息</div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
