import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import type { AttachmentMeta, TurnStats } from '@ruobai/chat-protocol'
import {
  api, type CommandPrefix, type ContextInfo, type ModeInfo, type ModelProvider, type PermissionMode,
  type SkillSummary, type WikiPageSummary, type WorkspaceMatch,
} from '../api.ts'
import { applyCompletion, detectTrigger } from '../composer-triggers.ts'
import { tokenizeComposer } from '../composer-tokens.ts'
import { useComposerAttachments } from '../useComposerAttachments.ts'
import { clearDraft, readDraft, writeDraft } from '../composer-drafts.ts'
import { AttachmentRail } from './AttachmentRail.tsx'
import { ComposerPlusMenu } from './ComposerPlusMenu.tsx'
import { KnowledgePicker } from './KnowledgePicker.tsx'
import { MentionMenu } from './MentionMenu.tsx'
import { ModelSelect } from './ModelSelect.tsx'
import { PermissionSelect } from './PermissionSelect.tsx'
import { Select } from './Select.tsx'
import { SlashMenu, filterSlashCommands, SKILL_PREFIX } from './SlashMenu.tsx'
import { StatsLine } from './StatsLine.tsx'
import { SendIcon, StopIcon } from './Icons.tsx'

interface ComposerProps {
  disabled: boolean
  streaming: boolean
  sessionId?: string
  workspace?: string
  provider?: string
  model: string
  models: ModelProvider[]
  modes: ModeInfo[]
  skills?: SkillSummary[]
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
  /** File reference from the files panel: insert the path token into the draft. */
  reference?: { path: string; token: number } | null
  /** A queued message taken back: its body goes ahead of whatever is typed. */
  restore?: { text: string; attachments?: AttachmentMeta[]; token: number } | null
}

type OpenMenu = 'plus' | 'permission' | 'model' | 'knowledge' | null

const FILE_ACCEPT = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  '.txt', '.md', '.json', '.jsonl', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.html', '.yml', '.yaml', '.toml', '.xml', '.csv', '.py', '.go', '.rs',
  '.java', '.kt', '.sh', '.sql', 'text/*',
].join(',')

export function Composer({
  disabled, streaming, sessionId, workspace, provider, model, models, modes, skills = [], mode, permission,
  commandPrefix, contextInfo, stats, onModeChange, onModelChange, onPermissionChange, onSend,
  onStop, onNewSession, onOpenConnectors, reference, restore,
}: ComposerProps) {
  const [text, setText] = useState(() => readDraft(sessionId).text)
  const [caret, setCaret] = useState(0)
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [dismissed, setDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [mentionItems, setMentionItems] = useState<WorkspaceMatch[]>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const handledReference = useRef<number | null>(null)
  const handledRestore = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const attachments = useComposerAttachments(sessionId)
  const sessionRef = useRef(sessionId)
  const textRef = useRef(text)
  const attachmentsRef = useRef(attachments.attachments)
  const loadedSession = useRef(sessionId)
  sessionRef.current = sessionId
  textRef.current = text
  attachmentsRef.current = attachments.attachments
  const tokens = useMemo(() => tokenizeComposer(text), [text])

  const attachKnowledge = async (page: WikiPageSummary) => {
    if (!sessionId) return
    const target = sessionId
    try {
      const detail = await api.getWikiPage(page.id, sessionId)
      if (sessionRef.current !== target) return
      const text = detail.body
      attachments.addOne({
        id: globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}`,
        kind: 'file',
        name: `${detail.meta.title || page.title}.md`,
        mime: 'text/markdown',
        size: new TextEncoder().encode(text).length,
        text,
        path: `wiki:${page.id}`,
      })
    } catch (caught) {
      attachments.setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const trigger = useMemo(
    () => detectTrigger(text, caret, commandPrefix),
    [text, caret, commandPrefix],
  )
  const slashOpen = !dismissed && trigger?.kind === 'slash'
  const mentionOpen = !dismissed && trigger?.kind === 'mention'
  const slashItems = slashOpen ? filterSlashCommands(trigger!.query, skills) : []
  const pickerVisible = slashOpen || mentionOpen
  const pickerCount = slashOpen ? slashItems.length : mentionOpen ? mentionItems.length : 0

  const resizeText = useCallback(() => {
    const textarea = textareaRef.current
    // A hidden composer (an expanded side panel) measures zero; skip it and
    // let the ResizeObserver recalculate once it becomes visible again.
    if (!textarea || textarea.clientWidth === 0) return
    textarea.style.height = 'auto'
    const next = Math.min(Math.max(textarea.scrollHeight, 46), 240)
    textarea.style.height = `${next}px`
    textarea.style.overflowY = textarea.scrollHeight > 240 ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    resizeText()
  }, [text, resizeText])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    let lastWidth = textarea.clientWidth
    let hidden = lastWidth === 0
    const observer = new ResizeObserver(() => {
      const width = textarea.clientWidth
      if (width === 0) {
        hidden = true
        return
      }
      if (hidden || width !== lastWidth) {
        hidden = false
        lastWidth = width
        resizeText()
      }
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [resizeText])

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
    if (!reference || handledReference.current === reference.token) return
    handledReference.current = reference.token
    // A reference is a pointer for the agent's tools, not an upload: the
    // content stays in the workspace and is read only if the turn needs it.
    const token = `@${reference.path} `
    setText(current => {
      const base = current.replace(/\s+$/, '')
      return base ? `${base} ${token}` : token
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
    if (!restore || handledRestore.current === restore.token) return
    handledRestore.current = restore.token
    const body = restore.text.replace(/\s+$/, '')
    // Taken-back text goes ahead of what is already typed, like Claude Code's
    // "take back": edit it and press Enter to queue it again.
    if (body) setText(current => (current.trim() ? `${body}\n${current}` : restore.text))
    for (const attachment of restore.attachments ?? []) attachments.addOne(attachment)
    const end = body.length
    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      const target = Math.min(end, textarea.value.length)
      textarea.setSelectionRange(target, target)
      setCaret(target)
    })
    return () => cancelAnimationFrame(frame)
  }, [restore, attachments.addOne])

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
    // Save what belongs to the session we are leaving, then restore the draft
    // of the one we just opened: text and attachments are per-session.
    const previous = loadedSession.current
    if (previous === sessionId) return
    loadedSession.current = sessionId
    writeDraft(previous, { text: textRef.current, attachments: attachmentsRef.current })
    const draft = readDraft(sessionId)
    setText(draft.text)
    setCaret(draft.text.length)
    attachments.replace(draft.attachments)
    setOpenMenu(null)
    setDismissed(true)
  }, [sessionId, attachments.replace])

  useEffect(() => () => {
    // Switching to another view unmounts the composer; keep the draft for later.
    writeDraft(sessionRef.current, {
      text: textRef.current,
      attachments: attachmentsRef.current,
    })
  }, [])

  const syncCaret = (event: { currentTarget: HTMLTextAreaElement }) => {
    setCaret(event.currentTarget.selectionStart ?? 0)
  }

  const submit = () => {
    const value = text.trim()
    // A running turn does not block input: the host queues the message and
    // starts it as the next turn.
    if (disabled) return
    if (!value && !attachments.attachments.length) return
    onSend(value, attachments.attachments)
    setText('')
    setCaret(0)
    setDismissed(true)
    attachments.clear()
    clearDraft(sessionId)
    setOpenMenu(null)
  }

  const focusAt = (position: number) => {
    pendingCaret.current = position
    textareaRef.current?.focus()
  }

  const acceptSlash = (id: string) => {
    if (!trigger) return
    if (id.startsWith(SKILL_PREFIX)) {
      const name = id.slice(SKILL_PREFIX.length)
      const next = applyCompletion(text, caret, trigger, `/${name} `)
      setText(next.text)
      setCaret(next.caret)
      setDismissed(true)
      focusAt(next.caret)
      return
    }
    if (id === 'compact') {
      // `/compact [focus]` is parsed by the host; keep the caret after the
      // space so a focus can be typed before sending.
      const next = applyCompletion(text, caret, trigger, '/compact ')
      setText(next.text)
      setCaret(next.caret)
      setDismissed(true)
      focusAt(next.caret)
      return
    }
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
    // Both files and directories become a path reference; nothing is uploaded.
    // The agent reads the workspace through its own tools when it needs to.
    const replacement = match.type === 'directory' ? `@${match.path}/ ` : `@${match.path} `
    const next = applyCompletion(text, caret, trigger, replacement)
    setText(next.text)
    setCaret(next.caret)
    setDismissed(true)
    focusAt(next.caret)
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

  /**
   * Opening the folder picker with an `@` turns it into a workspace reference.
   * A folder's contents are never read: the agent reads it through its tools,
   * so picking one does not upload the whole directory.
   */
  const insertMention = useCallback(() => {
    const position = textareaRef.current?.selectionStart ?? text.length
    const before = text.slice(0, position)
    // A mention only opens at a word boundary.
    const prefix = before && !/\s$/.test(before) ? ' @' : '@'
    setText(`${before}${prefix}${text.slice(position)}`)
    setCaret(position + prefix.length)
    setDismissed(false)
    focusAt(position + prefix.length)
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
                ? <SlashMenu query={trigger!.query} activeIndex={activeIndex} skills={skills} onPick={acceptSlash} />
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

        <div className="composer-input">
          <div className="composer-mirror" aria-hidden="true" ref={mirrorRef}>
            {tokens.map((token, index) => token.kind === 'text'
              ? <span key={index}>{token.text}</span>
              : <span key={index} className={`composer-token ${token.kind}`}>{token.text}</span>)}
            {text.endsWith('\n') ? '\n' : null}
          </div>
          <textarea
            ref={textareaRef}
            value={text}
            rows={2}
            placeholder={disabled
              ? '正在加载会话…'
              : streaming
                ? '运行中：回车把消息排到下一轮'
                : `发送消息…  输入 / 或 ${commandPrefix} 命令，@ 引用文件`}
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
            onScroll={(event) => {
              const mirror = mirrorRef.current
              if (!mirror) return
              mirror.scrollTop = event.currentTarget.scrollTop
              mirror.scrollLeft = event.currentTarget.scrollLeft
            }}
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
        </div>

        <div className="composer-bar">
          <div className="composer-left">
            <ComposerPlusMenu
              open={openMenu === 'plus'}
              disabled={disabled}
              onOpenChange={open => setOpenMenu(open ? 'plus' : null)}
              onAddFiles={() => fileInputRef.current?.click()}
              onReferenceFolder={insertMention}
              onSlash={insertSlash}
              onConnectors={onOpenConnectors}
            />
            <PermissionSelect
              value={permission}
              open={openMenu === 'permission'}
              disabled={disabled}
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
            <KnowledgePicker
              open={openMenu === 'knowledge'}
              sessionId={sessionId}
              disabled={disabled}
              onOpenChange={open => setOpenMenu(open ? 'knowledge' : null)}
              onPick={page => { void attachKnowledge(page) }}
            />
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
                <button
                  type="button"
                  className="send stop"
                  onClick={onStop}
                  aria-label="Stop"
                  title="停止当前回合；回车排队的消息会接着发送"
                >
                  <StopIcon size={13} />
                </button>
              )
              : (
                <button
                  type="submit"
                  className="send"
                  disabled={disabled || (!text.trim() && !attachments.attachments.length)}
                  aria-label="Send"
                  title="发送"
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
      </form>

      <StatsLine stats={stats} contextInfo={contextInfo} sessionId={sessionId} workspace={workspace} />

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
