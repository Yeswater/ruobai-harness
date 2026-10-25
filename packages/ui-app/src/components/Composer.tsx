import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import type { AttachmentMeta, TurnStats } from '@ruobai/chat-protocol'
import {
  api, type CommandPrefix, type ContextInfo, type ModeInfo, type ModelProvider, type PermissionMode, type WorkspaceMatch,
} from '../api.ts'
import { applyCompletion, detectTrigger } from '../composer-triggers.ts'
import { useComposerAttachments } from '../useComposerAttachments.ts'
import { AttachmentRail } from './AttachmentRail.tsx'
import { ComposerPlusMenu } from './ComposerPlusMenu.tsx'
import { MentionMenu } from './MentionMenu.tsx'
import { ModelSelect } from './ModelSelect.tsx'
import { PermissionSelect } from './PermissionSelect.tsx'
import { Select } from './Select.tsx'
import { SlashMenu, filterSlashCommands } from './SlashMenu.tsx'
import { StatsLine } from './StatsLine.tsx'
import { SendIcon, StopIcon } from './Icons.tsx'

interface ComposerProps {
  disabled: boolean
  streaming: boolean
  sessionId?: string
  provider?: string
  model: string
  models: ModelProvider[]
  modes: ModeInfo[]
  mode: string
  permission: PermissionMode
  commandPrefix: CommandPrefix
  contextInfo: ContextInfo | null
  stats?: TurnStats | null
  onModeChange: (mode: string) => void
  onModelChange: (provider: string, model: string) => void
  onPermissionChange: (mode: PermissionMode, confirm?: boolean) => void
  onSend: (text: string, attachments: AttachmentMeta[]) => void
  onStop: () => void
  onNewSession: () => void
  onOpenConnectors: () => void
  /** Text to append to the draft, e.g. an `@path` reference from the files panel. */
  reference?: { text: string; token: number } | null
}

type OpenMenu = 'plus' | 'permission' | 'model' | null

const FILE_ACCEPT = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  '.txt', '.md', '.json', '.jsonl', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.html', '.yml', '.yaml', '.toml', '.xml', '.csv', '.py', '.go', '.rs',
  '.java', '.kt', '.sh', '.sql', 'text/*',
].join(',')
const DIRECTORY_PROPS = { webkitdirectory: '', directory: '' } as Record<string, string>

export function Composer({
  disabled, streaming, sessionId, provider, model, models, modes, mode, permission,
  commandPrefix, contextInfo, stats, onModeChange, onModelChange, onPermissionChange, onSend,
  onStop, onNewSession, onOpenConnectors, reference,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [dismissed, setDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [mentionItems, setMentionItems] = useState<WorkspaceMatch[]>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const attachments = useComposerAttachments(sessionId)

  const trigger = useMemo(
    () => detectTrigger(text, caret, commandPrefix),
    [text, caret, commandPrefix],
  )
  const slashOpen = !dismissed && trigger?.kind === 'slash'
  const mentionOpen = !dismissed && trigger?.kind === 'mention'
  const slashItems = slashOpen ? filterSlashCommands(trigger!.query) : []
  const pickerVisible = slashOpen || mentionOpen
  const pickerCount = slashOpen ? slashItems.length : mentionOpen ? mentionItems.length : 0

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const next = Math.min(Math.max(textarea.scrollHeight, 46), 240)
    textarea.style.height = `${next}px`
    textarea.style.overflowY = textarea.scrollHeight > 240 ? 'auto' : 'hidden'
  }, [text])

  useEffect(() => {
    const target = pendingCaret.current
    if (target === null) return
    pendingCaret.current = null
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(target, target)
  }, [text])

  useEffect(() => {
    if (!reference) return
    setText(current => {
      const base = current.replace(/\s+$/, '')
      return base ? `${base} ${reference.text}` : reference.text
    })
    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      const end = textarea.value.length
      textarea.setSelectionRange(end, end)
      setCaret(end)
    })
    return () => cancelAnimationFrame(frame)
  }, [reference])

  useEffect(() => {
    setActiveIndex(0)
  }, [trigger?.kind, trigger?.query])

  useEffect(() => {
    if (!mentionOpen || !sessionId) {
      setMentionItems([])
      setMentionLoading(false)
      return
    }
    let cancelled = false
    setMentionLoading(true)
    const query = trigger!.query
    const timer = setTimeout(() => {
      void api.searchWorkspace(query, sessionId, 20)
        .then((list) => {
          if (cancelled) return
          setMentionItems(list)
          setMentionLoading(false)
        })
        .catch(() => {
          if (!cancelled) {
            setMentionItems([])
            setMentionLoading(false)
          }
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mentionOpen, trigger?.query, sessionId])

  useEffect(() => {
    setOpenMenu(null)
    setDismissed(true)
  }, [sessionId])

  const syncCaret = (event: { currentTarget: HTMLTextAreaElement }) => {
    setCaret(event.currentTarget.selectionStart ?? 0)
  }

  const submit = () => {
    const value = text.trim()
    if (disabled || streaming) return
    if (!value && !attachments.attachments.length) return
    onSend(value, attachments.attachments)
    setText('')
    setCaret(0)
    setDismissed(true)
    attachments.clear()
    setOpenMenu(null)
  }

  const focusAt = (position: number) => {
    pendingCaret.current = position
    textareaRef.current?.focus()
  }

  const acceptSlash = (id: string) => {
    if (!trigger) return
    const next = applyCompletion(text, caret, trigger, '')
    setText(next.text)
    setCaret(next.caret)
    setDismissed(true)
    focusAt(next.caret)

    if (id === 'model') {
      setOpenMenu('model')
      return
    }
    if (id === 'permission') {
      setOpenMenu('permission')
      return
    }
    if (id === 'new') {
      onNewSession()
      return
    }
    if (id === 'stop') {
      onStop()
      return
    }
    if (modes.some(item => item.id === id)) onModeChange(id)
  }

  const acceptMention = (match: WorkspaceMatch) => {
    if (!trigger) return
    const replacement = `@${match.path}${match.type === 'directory' ? '/' : ''} `
    const next = applyCompletion(text, caret, trigger, replacement)
    setText(next.text)
    setCaret(next.caret)
    setDismissed(true)
    focusAt(next.caret)
    if (match.type !== 'file' || !sessionId) return
    void api.readWorkspaceFile(match.path, sessionId)
      .then((file) => {
        attachments.addOne({
          id: globalThis.crypto?.randomUUID?.() ?? `a-${Date.now()}`,
          kind: 'file',
          name: match.name,
          mime: 'text/plain',
          size: new TextEncoder().encode(file.content).length,
          text: file.content,
          path: match.path,
        })
      })
      .catch(() => undefined)
  }

  const pickActive = () => {
    if (slashOpen) {
      const command = slashItems[activeIndex]
      if (command) acceptSlash(command.id)
      return
    }
    const match = mentionItems[activeIndex]
    if (match) acceptMention(match)
  }

  const insertSlash = useCallback(() => {
    const position = textareaRef.current?.selectionStart ?? text.length
    setText(`${text.slice(0, position)}/${text.slice(position)}`)
    setCaret(position + 1)
    setDismissed(false)
    focusAt(position + 1)
  }, [text])

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (!files.length) return
    event.preventDefault()
    void attachments.addFiles(files)
  }

  return (
    <div className="composer-wrap">
      <form
        className={`composer ${dragActive ? 'drop-active' : ''}`}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onDragOver={(event) => {
          event.preventDefault()
          if (!dragActive) setDragActive(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragActive(false)
          if (event.dataTransfer.files.length) void attachments.addFiles(event.dataTransfer.files)
        }}
      >
        {pickerVisible
          ? (
            <div className="composer-picker-wrap">
              {slashOpen
                ? <SlashMenu query={trigger!.query} activeIndex={activeIndex} onPick={acceptSlash} />
                : (
                  <MentionMenu
                    query={trigger!.query}
                    items={mentionItems}
                    loading={mentionLoading}
                    activeIndex={activeIndex}
                    onPick={(path) => {
                      const match = mentionItems.find(item => item.path === path)
                      if (match) acceptMention(match)
                    }}
                  />
                )}
            </div>
          )
          : null}

        {attachments.attachments.length
          ? <AttachmentRail attachments={attachments.attachments} onRemove={attachments.remove} />
          : null}

        <textarea
          ref={textareaRef}
          value={text}
          rows={2}
          placeholder={disabled ? '正在加载会话…' : `发送消息…  输入 / 或 ${commandPrefix} 命令，@ 引用文件`}
          onChange={(event) => {
            setText(event.target.value)
            setCaret(event.target.selectionStart ?? 0)
            setDismissed(false)
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyUp={syncCaret}
          onBlur={() => setDismissed(true)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') {
              event.preventDefault()
              fileInputRef.current?.click()
              return
            }
            if (pickerVisible) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (pickerCount) setActiveIndex(index => (index + 1) % pickerCount)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                if (pickerCount) setActiveIndex(index => (index - 1 + pickerCount) % pickerCount)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                if (pickerCount) pickActive()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setDismissed(true)
                return
              }
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />

        <div className="composer-bar">
          <div className="composer-left">
            <ComposerPlusMenu
              open={openMenu === 'plus'}
              disabled={disabled}
              onOpenChange={open => setOpenMenu(open ? 'plus' : null)}
              onAddFiles={() => fileInputRef.current?.click()}
              onAddFolder={() => folderInputRef.current?.click()}
              onSlash={insertSlash}
              onConnectors={onOpenConnectors}
            />
            <PermissionSelect
              value={permission}
              open={openMenu === 'permission'}
              disabled={disabled || streaming}
              onOpenChange={open => setOpenMenu(open ? 'permission' : null)}
              onChange={onPermissionChange}
            />
            {modes.length
              ? (
                <Select
                  className="mode-select"
                  value={mode}
                  options={modes.map(item => ({
                    value: item.id,
                    label: item.name,
                    description: item.description,
                  }))}
                  onChange={onModeChange}
                  disabled={streaming}
                  ariaLabel="Agent mode"
                  menuWidth={260}
                />
              )
              : null}
          </div>
          <div className="composer-actions">
            <ModelSelect
              provider={provider}
              model={model}
              providers={models}
              open={openMenu === 'model'}
              disabled={disabled || streaming}
              onOpenChange={open => setOpenMenu(open ? 'model' : null)}
              onChange={onModelChange}
            />
            {streaming
              ? (
                <button type="button" className="send stop" onClick={onStop} aria-label="Stop">
                  <StopIcon size={13} />
                </button>
              )
              : (
                <button
                  type="submit"
                  className="send"
                  disabled={disabled || (!text.trim() && !attachments.attachments.length)}
                  aria-label="Send"
                >
                  <SendIcon size={14} />
                </button>
              )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          accept={FILE_ACCEPT}
          onChange={(event) => {
            if (event.target.files) void attachments.addFiles(event.target.files)
            event.target.value = ''
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          hidden
          multiple
          {...DIRECTORY_PROPS}
          onChange={(event) => {
            if (event.target.files) attachments.addFolder(event.target.files)
            event.target.value = ''
          }}
        />
      </form>

      <StatsLine stats={stats} contextInfo={contextInfo} />

      {attachments.error
        ? (
          <div className="composer-error">
            <span>{attachments.error}</span>
            <button type="button" onClick={() => attachments.setError(null)} aria-label="关闭提示">×</button>
          </div>
        )
        : null}
    </div>
  )
}
