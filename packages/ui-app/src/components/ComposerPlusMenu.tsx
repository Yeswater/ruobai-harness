import { createPortal } from 'react-dom'
import { useAnchoredMenu } from './AnchoredMenu.ts'
import {
  CommandIcon, FolderIcon, ImageIcon, PlugIcon, PlusIcon, PuzzleIcon,
} from './Icons.tsx'

interface ComposerPlusMenuProps {
  open: boolean
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onAddFiles: () => void
  onReferenceFolder: () => void
  onSlash: () => void
  onConnectors: () => void
}

export function ComposerPlusMenu({
  open, disabled, onOpenChange, onAddFiles, onReferenceFolder, onSlash, onConnectors,
}: ComposerPlusMenuProps) {
  const { triggerRef, menuRef, position } = useAnchoredMenu({
    open,
    onClose: () => onOpenChange(false),
    width: 260,
  })

  const run = (action: () => void) => {
    onOpenChange(false)
    action()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-plus"
        aria-label="添加"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <PlusIcon size={14} />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="view-menu plus-menu"
              role="menu"
              aria-label="添加内容"
              style={{
                left: position.left,
                width: position.width,
                ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
              }}
            >
              <button type="button" role="menuitem" className="view-menu-row" onClick={() => run(onAddFiles)}>
                <span className="view-menu-icon"><ImageIcon size={16} /></span>
                <span className="view-menu-text"><span className="view-menu-title">添加文件或照片</span></span>
                <span className="view-menu-shortcut">⌘U</span>
              </button>
              <button type="button" role="menuitem" className="view-menu-row" onClick={() => run(onReferenceFolder)}>
                <span className="view-menu-icon"><FolderIcon size={16} /></span>
                <span className="view-menu-text">
                  <span className="view-menu-title">引用文件夹</span>
                </span>
                <span className="view-menu-shortcut">@</span>
              </button>
              <button type="button" role="menuitem" className="view-menu-row" onClick={() => run(onSlash)}>
                <span className="view-menu-icon"><CommandIcon size={16} /></span>
                <span className="view-menu-text"><span className="view-menu-title">斜线命令</span></span>
              </button>
              <div className="view-menu-sep" />
              <button type="button" role="menuitem" className="view-menu-row" onClick={() => run(onConnectors)}>
                <span className="view-menu-icon"><PlugIcon size={16} /></span>
                <span className="view-menu-text"><span className="view-menu-title">管理连接器</span></span>
              </button>
              <button type="button" role="menuitem" className="view-menu-row" disabled title="插件市场暂未提供">
                <span className="view-menu-icon"><PuzzleIcon size={16} /></span>
                <span className="view-menu-text"><span className="view-menu-title">添加插件</span></span>
                <span className="view-menu-shortcut">即将支持</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
