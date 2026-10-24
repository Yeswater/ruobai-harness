import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatSession, SessionSummary } from '@ruobai/chat-protocol'
import {
  api,
  connectEvents,
  summarize,
  type ApprovalDecision,
  type ApprovalRequest,
  type ModeInfo,
} from './api.ts'

function upsert(list: SessionSummary[], next: SessionSummary) {
  return [next, ...list.filter(item => item.id !== next.id)].sort((a, b) => b.updatedAt - a.updatedAt)
}

function applyEvent(session: ChatSession, event: ChatEvent): ChatSession {  switch (event.type) {
    case 'session-updated':
      return event.session
    case 'message-added':
      return session.messages.some(message => message.id === event.message.id)
        ? session
        : { ...session, messages: [...session.messages, event.message] }
    case 'message-updated':
      return {
        ...session,
        messages: session.messages.some(message => message.id === event.message.id)
          ? session.messages.map(message => message.id === event.message.id ? event.message : message)
          : [...session.messages, event.message],
      }
    case 'message-delta':
      return {
        ...session,
        messages: session.messages.map((message) => {
          if (message.id !== event.messageId) return message
          const blocks = [...message.blocks]
          const last = blocks.at(-1)
          if (!last || last.type !== 'text') blocks.push({ type: 'text', text: event.delta })
          else blocks[blocks.length - 1] = { ...last, text: last.text + event.delta }
          return { ...message, blocks }
        }),
      }
    case 'message-block':
      return {
        ...session,
        messages: session.messages.map(message => message.id === event.messageId
          ? { ...message, blocks: [...message.blocks, event.block] }
          : message),
      }
    default:
      return session
  }
}

let bootstrapPromise: Promise<{ sessions: SessionSummary[]; activeId: string | null }> | undefined

/** One initial load per page, shared by StrictMode's double effect run. */
function bootstrap() {
  bootstrapPromise ??= (async () => {
    let list = await api.listSessions()
    if (!list.length) {
      const created = await api.createSession()
      list = [summarize(created)]
    }
    return { sessions: list, activeId: list[0]?.id ?? null }
  })()
  return bootstrapPromise
}

export function useHarness() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [session, setSession] = useState<ChatSession | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [defaultMode, setDefaultMode] = useState('agent')
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const activeRef = useRef<string | null>(null)
  const sessionsRef = useRef<SessionSummary[]>([])

  useEffect(() => {
    activeRef.current = activeId
  }, [activeId])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  const fail = useCallback((caught: unknown) => {
    setError(caught instanceof Error ? caught.message : String(caught))
  }, [])

  const select = useCallback((id: string) => {
    // Clicking the active row must not clear the transcript: activeId would
    // not change, so the loading effect would never run again.
    if (activeRef.current === id) return
    activeRef.current = id
    setActiveId(id)
    setSession(null)
  }, [])

  const createFresh = useCallback(() => {
    void api.createSession()
      .then((created) => {
        const summary = summarize(created)
        sessionsRef.current = upsert(sessionsRef.current, summary)
        setSessions(previous => upsert(previous, summary))
        activeRef.current = created.id
        setActiveId(created.id)
        setSession(created)
        setApprovals([])
      })
      .catch(fail)
  }, [fail])

  /** Remove a session locally; select the next one or start a fresh session. */
  const dropSession = useCallback((id: string) => {
    sessionsRef.current = sessionsRef.current.filter(item => item.id !== id)
    setSessions(sessionsRef.current)
    setApprovals(previous => previous.filter(item => item.sessionId !== id))
    if (activeRef.current !== id) return
    const next = sessionsRef.current[0]?.id ?? null
    activeRef.current = next
    setActiveId(next)
    setSession(null)
    if (!next) createFresh()
  }, [createFresh])

  const renameSession = useCallback((id: string, title: string) => {
    void api.renameSession(id, title)
      .then((next) => {
        sessionsRef.current = sessionsRef.current.map(item =>
          item.id === id ? { ...item, title: next.title, updatedAt: next.updatedAt } : item)
        setSessions(sessionsRef.current)
        setSession(previous => previous && previous.id === id ? { ...previous, title: next.title } : previous)
      })
      .catch(fail)
  }, [fail])

  const deleteSession = useCallback((id: string) => {
    void api.deleteSession(id)
      .then(() => dropSession(id))
      .catch(fail)
  }, [dropSession, fail])

  const forkSession = useCallback((id: string) => {
    void api.forkSession(id)
      .then((created) => {
        const summary = summarize(created)
        sessionsRef.current = upsert(sessionsRef.current, summary)
        setSessions(previous => upsert(previous, summary))
        activeRef.current = created.id
        setActiveId(created.id)
        setSession(created)
        setApprovals([])
      })
      .catch(fail)
  }, [fail])

  useEffect(() => {
    let cancelled = false
    void bootstrap()
      .then(({ sessions, activeId }) => {
        if (cancelled) return
        setSessions(sessions)
        if (activeId) setActiveId(activeId)
      })
      .catch((caught) => {
        if (!cancelled) fail(caught)
      })
    return () => {
      cancelled = true
    }
  }, [fail])

  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    setSession(null)
    void api.getSession(activeId)
      .then(next => {
        if (!cancelled) setSession(next)
      })
      .catch(caught => {
        if (!cancelled) fail(caught)
      })
    return () => {
      cancelled = true
    }
  }, [activeId, fail])

  useEffect(() => {
    let cancelled = false
    void api.getModes()
      .then(({ modes: list, default: fallback }) => {
        if (cancelled) return
        setModes(list)
        setDefaultMode(fallback)
      })
      .catch((caught) => {
        if (!cancelled) fail(caught)
      })
    return () => {
      cancelled = true
    }
  }, [fail])

  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    void api.getApprovals(activeId)
      .then((list) => {
        if (!cancelled) setApprovals(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeId])

  useEffect(() => {
    const events = connectEvents({
      onOpen: () => {
        setConnected(true)
        setError(null)
      },
      onError: () => setConnected(false),
      onChat: (event) => {
        if (event.type === 'session-deleted') {
          dropSession(event.sessionId)
          return
        }
        if (event.type === 'session-created' || event.type === 'session-updated' || event.type === 'message-done') {
          const summary = summarize(event.session)
          sessionsRef.current = upsert(sessionsRef.current, summary)
          setSessions(previous => upsert(previous, summary))
        }
        if (!('sessionId' in event)) {
          if (event.type === 'session-updated' && event.session.id === activeRef.current) {
            setSession(event.session)
          }
          return
        }
        if (event.sessionId !== activeRef.current) return
        if (event.type === 'message-done') {
          setSession(event.session)
        } else {
          setSession(previous => previous ? applyEvent(previous, event) : previous)
        }
      },
      onApproval: (payload) => {
        if (payload.kind === 'requested') {
          const request = payload.request
          setApprovals(previous => previous.some(item => item.id === request.id) ? previous : [...previous, request])
        } else {
          setApprovals(previous => previous.filter(item => item.id !== payload.resolution.id))
        }
      },
    })
    return () => events.close()
  }, [dropSession])

  const send = useCallback((text: string) => {
    const id = activeRef.current
    if (!id) return
    void api.sendMessage(id, text)
      .then((message) => {
        setSession(previous => {
          if (!previous || previous.id !== id) return previous
          if (previous.messages.some(item => item.id === message.id)) return previous
          return { ...previous, messages: [...previous.messages, message] }
        })
      })
      .catch(fail)
  }, [fail])

  const stop = useCallback(() => {
    const id = activeRef.current
    if (id) void api.stopSession(id).catch(fail)
  }, [fail])

  const createSession = createFresh

  const setMode = useCallback((mode: string) => {
    const id = activeRef.current
    if (!id) return
    void api.setSessionMode(id, mode)
      .then((next) => {
        setSession(previous => previous && previous.id === id ? { ...previous, mode: next.mode } : previous)
        setSessions(previous => previous.map(item => item.id === id ? { ...item, mode: next.mode } : item))
      })
      .catch(fail)
  }, [fail])

  const resolveApproval = useCallback((id: string, decision: ApprovalDecision) => {
    setApprovals(previous => previous.filter(item => item.id !== id))
    void api.resolveApproval(id, decision).catch((caught) => {
      fail(caught)
      const sessionId = activeRef.current
      if (sessionId) void api.getApprovals(sessionId).then(setApprovals).catch(() => undefined)
    })
  }, [fail])

  return {
    sessions,
    activeId,
    session,
    connected,
    error,
    modes,
    defaultMode,
    approvals,
    select,
    send,
    stop,
    createSession,
    renameSession,
    deleteSession,
    forkSession,
    setMode,
    resolveApproval,
    dismissError: () => setError(null),
  }
}
