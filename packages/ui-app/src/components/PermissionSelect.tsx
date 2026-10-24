import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PermissionMode } from '../api.ts'
import { useAnchoredMenu } from './AnchoredMenu.ts'
import {
  AlertIcon, BotIcon, CheckIcon, ChevronDownIcon, EyeIcon, FolderIcon, ShieldIcon,
} from './Icons.tsx'

interface PermissionSelectProps {
  value: PermissionMode
  open: boolean
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onChange: (mode: PermissionMode, confirm?: boolean) => void
}

interface PermissionOption {
  value: PermissionMode
  label: string
  description: string
  icon: ReactNode
  risky?: boolean
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    value: 'read-only',
    label: '仅可查看',
    description: '只能读取与搜索，不执行任何修改',
    icon: <EyeIcon size={16} />,
  },
  {
    value: 'workspace-write',
    label: '工作区内修改',
    description: '允许修改工作区文件，命令仍需审批',
    icon: <FolderIcon size={16} />,
  },
  {
    value: 'full-access',
    label: '完全权限',
    description: '跳过审批与危险命令确认；deny 规则仍生效',
    icon: <ShieldIcon size={16} />,
    risky: true,
  },
  {
    value: 'auto-review',
    label: '自动审查',
    description: '自动放行安全操作，危险命令仍需确认',
    icon: <BotIcon size={16} />,
  },
]

export function permissionLabel(value: string) {
  return PERMISSION_OPTIONS.find(option => option.value === value)?.label ?? value
}

export function PermissionSelect({
  value, open, disabled, onOpenChange, onChange,
}: PermissionSelectProps) {
  const { triggerRef, menuRef, position } = useAnchoredMenu({
    open,
    onClose: () => onOpenChange(false),
    width: 300,
  })
  const [confirming, setConfirming] = useState(false)
  const current = PERMISSION_OPTIONS.find(option => option.value === value) ?? PERMISSION_OPTIONS[1]!

  const pick = (mode: PermissionMode) => {
    if (mode === value) {
      onOpenChange(false)
      return
    }
    if (mode === 'full-access') {
      onOpenChange(false)
      setConfirming(true)
      return
    }
    onOpenChange(false)
    onChange(mode)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-chip permission-chip ${value === 'full-access' ? 'danger' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        {value === 'read-only' ? <EyeIcon size={14} /> : <ShieldIcon size={14} />}
        <span>{current.label}</span>
        <ChevronDownIcon size={12} />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="view-menu permission-menu"
              role="menu"
              aria-label="权限模式"
              style={{
                left: position.left,
                width: position.width,
                ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
              }}
            >
              <div className="view-menu-label">会话权限</div>
              {PERMISSION_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === value}
                  className={`view-menu-row ${option.value === value ? 'selected' : ''} ${option.risky ? 'danger' : ''}`}
                  onClick={() => pick(option.value)}
                >
                  <span className="view-menu-icon">{option.icon}</span>
                  <span className="view-menu-text">
                    <span className="view-menu-title">{option.label}</span>
                    <span className="view-menu-desc">{option.description}</span>
                  </span>
                  {option.value === value ? <CheckIcon size={14} /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      {confirming
        ? (
          <div className="modal-backdrop" onClick={() => setConfirming(false)}>
            <div
              className="modal confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-label="启用完全权限"
              onClick={event => event.stopPropagation()}
            >
              <div className="modal-head">
                <h2><AlertIcon size={16} /> 启用完全权限</h2>
              </div>
              <div className="modal-body">
                <p className="modal-note">
                  该会话的写文件、shell 命令与 MCP 调用将不再询问，危险命令也不会二次确认。
                  你在审批设置里配置的 deny / ask 规则仍然生效。
                </p>
              </div>
              <div className="modal-foot">
                <span className="hint">仅影响当前会话</span>
                <div className="modal-actions">
                  <button className="btn ghost" onClick={() => setConfirming(false)}>取消</button>
                  <button
                    className="btn danger-solid"
                    onClick={() => {
                      setConfirming(false)
                      onChange('full-access', true)
                    }}
                  >
                    启用完全权限
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
        : null}
    </>
  )
}
