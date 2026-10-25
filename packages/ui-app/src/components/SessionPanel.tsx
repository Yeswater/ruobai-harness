import { useCallback, useEffect, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type ContextInfo, type GitInfo } from '../api.ts'
import { ContextCard } from './ContextCard.tsx'
import { EnvironmentCard } from './EnvironmentCard.tsx'
import { CloseIcon } from './Icons.tsx'
import { InfoCard } from './InfoCard.tsx'
import { Slot } from './Slot.tsx'

interface SessionPanelProps {
  session: ChatSession | null
  contextInfo: ContextInfo | null
  onClose: () => void
}

type CardKey = 'environment' | 'context'

/** Session context beside the chat; the file/Git explorer lives separately. */
export function SessionPanel({ session, contextInfo, onClose }: SessionPanelProps) {
  const [open, setOpen] = useState<Record<CardKey, boolean>>({
    environment: true,
    context: true,
  })
  const [git, setGit] = useState<GitInfo | null>(null)
  const [gitError, setGitError] = useState<string | null>(null)
  const sessionId = session?.id

  const toggle = (key: CardKey) => setOpen(current => ({ ...current, [key]: !current[key] }))

  useEffect(() => {
    if (!sessionId) {
      setGit(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const info = await api.getGitInfo(sessionId)
        if (cancelled) return
        setGit(info)
        setGitError(null)
      } catch (caught) {
        if (!cancelled) setGitError(caught instanceof Error ? caught.message : String(caught))
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])

  const refreshGit = useCallback(() => {
    if (sessionId) void api.getGitInfo(sessionId).then(setGit).catch(() => undefined)
  }, [sessionId])

  return (
    <aside className="session-panel">
      <div className="details-head">
        <span className="details-title">会话</span>
        <button className="icon-btn subtle" onClick={onClose} aria-label="关闭会话栏">
          <CloseIcon />
        </button>
      </div>

      <div className="details-scroll">
        {session
          ? (
            <>
              <InfoCard title="环境" open={open.environment} onToggle={() => toggle('environment')}>
                <EnvironmentCard git={git} workspace={session.workspace} />
                {gitError ? <div className="detail-note error">{gitError}</div> : null}
                <button className="link-btn" onClick={refreshGit}>刷新</button>
              </InfoCard>

              <InfoCard title="上下文" open={open.context} onToggle={() => toggle('context')}>
                <ContextCard context={contextInfo} />
              </InfoCard>

              <Slot name="details.side" />
            </>
          )
          : <div className="loading">no session</div>}
      </div>
    </aside>
  )
}
