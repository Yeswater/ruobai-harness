import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '../useEscapeKey.ts'
import type { ArchiveFilter, GroupBy, OrderBy, SidebarView } from '../sidebar-model.ts'
import {
  ArchiveIcon, ChatIcon, CheckIcon, ClockIcon, FolderIcon, FolderTreeIcon,
  GripIcon, ListIcon, SlidersIcon,
} from './Icons.tsx'

interface SidebarViewMenuProps {
  view: SidebarView
  onChange: (patch: Partial<SidebarView>) => void
}

interface MenuPosition {
  left: number
  width: number
  top?: number
  bottom?: number
}

const GROUPS: Array<{ value: GroupBy; label: string; icon: ReactNode }> = [
  { value: 'workspace', label: '按工作区', icon: <FolderIcon size={16} /> },
  { value: 'tree', label: '按工作区树', icon: <FolderTreeIcon size={16} /> },
  { value: 'flat', label: '单列表', icon: <ListIcon size={16} /> },
]

const ORDERS: Array<{ value: OrderBy; label: string; icon: ReactNode }> = [
  { value: 'manual', label: '手动排序', icon: <GripIcon size={16} /> },
  { value: 'updated', label: '最近更新', icon: <ClockIcon size={16} /> },
]

const FILTERS: Array<{ value: ArchiveFilter; label: string; icon: ReactNode }> = [
  { value: 'active', label: '隐藏已归档', icon: <ArchiveIcon size={16} /> },
  { value: 'all', label: '全部对话（显示已归档）', icon: <ChatIcon size={16} /> },
  { value: 'archived', label: '仅显示已归档', icon: <ArchiveIcon size={16} /> },
]

export function SidebarViewMenu({ view, onChange }: SidebarViewMenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = 264
      const openUp = rect.bottom + 380 > window.innerHeight
      setPosition({
        left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
        width,
        ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      })
    }
    update()

    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      if (triggerRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEscapeKey(() => setOpen(false), open)

  return (
    <>
      <button
        ref={triggerRef}
        className="icon-btn subtle"
        aria-label="视图选项"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <SlidersIcon />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="view-menu"
              role="menu"
              aria-label="视图选项"
              style={{
                left: position.left,
                width: position.width,
                ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
              }}
            >
              <div className="view-menu-label">分组方式</div>
              {GROUPS.map(option => (
                <MenuRow
                  key={option.value}
                  icon={option.icon}
                  label={option.label}
                  selected={view.groupBy === option.value}
                  onClick={() => onChange({ groupBy: option.value })}
                />
              ))}
              <div className="view-menu-sep" />
              <div className="view-menu-label">排序方式</div>
              {ORDERS.map(option => (
                <MenuRow
                  key={option.value}
                  icon={option.icon}
                  label={option.label}
                  selected={view.orderBy === option.value}
                  onClick={() => onChange({ orderBy: option.value })}
                />
              ))}
              <div className="view-menu-sep" />
              <div className="view-menu-label">筛选会话</div>
              {FILTERS.map(option => (
                <MenuRow
                  key={option.value}
                  icon={option.icon}
                  label={option.label}
                  selected={view.filter === option.value}
                  onClick={() => onChange({ filter: option.value })}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function MenuRow({ icon, label, selected, onClick }: {
  icon: ReactNode
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`view-menu-row ${selected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <span className="view-menu-icon">{icon}</span>
      <span className="view-menu-text">{label}</span>
      {selected ? <CheckIcon size={14} /> : null}
    </button>
  )
}
