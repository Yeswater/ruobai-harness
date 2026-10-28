import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentMeta, ChatEvent, ChatSession, SessionSummary } from '@ruobai/chat-protocol'
import {
  api,
  connectEvents,
  summarize,
  type ApprovalDecision,
  type ApprovalRequest,
  type CommandPrefix,
  type ContextInfo,
  type ModeInfo,
  type ModelProvider,
  type PermissionMode,
} from './api.ts'

function appendDelta(session: ChatSession, messageId: string, kind: 'text' | 'reasoning', delta: string): ChatSession {
  return {
    ...session,
    messages: session.messages.map((message) => {
      if (message.id !== messageId) return message
      const blocks = [...message.blocks]
      const last = blocks.at(-1)
      if (!last || last.type !== kind) blocks.push({ type: kind, text: delta })
      else blocks[blocks.length - 1] = { ...last, text: last.text + delta }
      return { ...message, blocks }
    }),
  }
}

function upsert(list: SessionSummary[], next: SessionSummary) {
  return [next, ...list.filter(item => item.id !== next.id)].sort((a, b) => b.updatedAt - a.updatedAt)
}

function applyEvent(session: ChatSession, event: ChatEvent): ChatSession {
  switch (event.type) {
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
      return appendDelta(session, event.messageId, 'text', event.delta)
    case 'message-reasoning':
      return appendDelta(session, event.messageId, 'reasoning', event.delta)
    case 'message-block':
      return {
        ...session,
        messages: session.messages.map(message => message.id === event.messageId
          ? { ...message, blocks: [...message.blocks, event.block] }
          : message),
      }
    case 'message-done':
      return { ...event.session, stats: session.stats }
    case 'session-stats':
      return { ...session, stats: event.stats }
    default:
      return session
  }
}

let bootstrapPromise: Promise<{ sessions: SessionSummary[]; activeId: string | null }> | undefined

const ACTIVE_KEY = 'rbh-active-session'

function storedActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

/** One initial load per page, shared by StrictMode's double effect run. */
function bootstrap() {
  bootstrapPromise ??= (async () => {
    let list = await api.listSessions()
    if (!list.length) {
      const created = await api.createSession()
      return { sessions: [summarize(created)], activeId: created.id }
    }
    // Come back to the session that was open, not just the busiest one: an
    // untouched new session never moves to the top on its own.
    const stored = storedActiveId()
    const activeId = stored && list.some(item => item.id === stored) ? stored : list[0]?.id ?? null
    return { sessions: list, activeId }
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
  const [models, setModels] = useState<ModelProvider[]>([])
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null)
  const [commandPrefix, setCommandPrefix] = useState<CommandPrefix>('～')
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const activeRef = useRef<string | null>(null)
  const sessionsRef = useRef<SessionSummary[]>([])

  useEffect(() => {
    activeRef.current = activeId
  }, [activeId])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    if (!activeId) return
    try {
      localStorage.setItem(ACTIVE_KEY, activeId)
    } catch {
      // private mode: the selection just will not survive a reload
    }
  }, [activeId])

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

  const createFresh = useCallback((workspace?: string) => {
    void api.createSession({ workspace })
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

  const archiveSession = useCallback((id: string, archived: boolean) => {
    void api.setArchived(id, archived)
      .then((next) => {
        sessionsRef.current = sessionsRef.current.map(item =>
          item.id === id ? { ...item, archived: next.archived, updatedAt: next.updatedAt } : item)
        setSessions(sessionsRef.current)
        setSession(previous => previous && previous.id === id
          ? { ...previous, archived: next.archived, updatedAt: next.updatedAt }
          : previous)
      })
      .catch(fail)
  }, [fail])

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
    let cancelled = false
    void api.getModels()
      .then((list) => {
        if (!cancelled) setModels(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const refreshSettings = useCallback(async () => {
    try {
      const settings = await api.getSettings()
      setCommandPrefix(settings.agent?.commandPrefix ?? '～')
    } catch {
      // keep the previous prefix when settings are unavailable
    }
  }, [])

  useEffect(() => {
    void refreshSettings()
  }, [refreshSettings])

  const refreshContext = useCallback(() => {
    const id = activeRef.current
    if (!id) return
    void api.getContext(id).then(setContextInfo).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!activeId) {
      setContextInfo(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const info = await api.getContext(activeId)
        if (!cancelled) setContextInfo(info)
      } catch {
        if (!cancelled) setContextInfo(null)
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeId, session?.updatedAt])

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
        // The page may have been offline while the host restarted, so frames
        // for sessions created in that window were never delivered. Take the
        // server's list and keep anything it has not heard about yet.
        void api.listSessions()
          .then((list) => {
            const known = new Set(list.map(item => item.id))
            const next = [
              ...list,
              ...sessionsRef.current.filter(item => !known.has(item.id)),
            ].sort((a, b) => b.updatedAt - a.updatedAt)
            sessionsRef.current = next
            setSessions(next)
          })
          .catch(() => undefined)
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

  const send = useCallback((text: string, attachments: AttachmentMeta[] = []) => {
    const id = activeRef.current
    if (!id) return
    void api.sendMessage(id, text, attachments)
      .then(({ message, queued }) => {
        setSession((previous) => {
          if (!previous || previous.id !== id) return previous
          if (queued) {
            // The event stream normally carries the queue; fold the response in
            // as well so a missed frame cannot hide what the user just sent.
            const queue = previous.queued ?? []
            if (queue.some(item => item.id === message.id)) return previous
            const body = message.blocks.map(block => block.type === 'text' ? block.text : '').join('')
            const files = message.blocks.flatMap(block =>
              block.type === 'attachment' ? [block.attachment] : [])
            return {
              ...previous,
              queued: [...queue, {
                id: message.id,
                text: body,
                createdAt: message.createdAt,
                ...(files.length ? { attachments: files } : {}),
              }],
            }
          }
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

  const recentWorkspaces = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const item of sessions) {
      const workspace = item.workspace
      if (!workspace || seen.has(workspace)) continue
      seen.add(workspace)
      list.push(workspace)
    }
    return list.slice(0, 8)
  }, [sessions])

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

  const setModel = useCallback((provider: string, model: string) => {
    const id = activeRef.current
    if (!id) return
    void api.setSessionModel(id, provider, model)
      .then((next) => {
        setSession(previous => previous && previous.id === id
          ? { ...previous, provider: next.provider, model: next.model }
          : previous)
        setSessions(previous => previous.map(item => item.id === id
          ? { ...item, provider: next.provider, model: next.model }
          : item))
      })
      .catch(fail)
  }, [fail])

  const setPermission = useCallback((mode: PermissionMode, confirm = false) => {
    const id = activeRef.current
    if (!id) return
    void api.setSessionPermission(id, mode, confirm)
      .then((next) => {
        setSession(previous => previous && previous.id === id
          ? { ...previous, permission: next.permission }
          : previous)
        setSessions(previous => previous.map(item => item.id === id
          ? { ...item, permission: next.permission }
          : item))
      })
      .catch(fail)
  }, [fail])

  /**
   * Take a queued message back before its turn starts. Resolves with the
   * withdrawn entry so the caller can put its text back in the input box.
   */
  const withdrawQueued = useCallback(async (id: string, queuedId: string) => {
    try {
      const { session, queued } = await api.withdrawQueued(id, queuedId)
      setSession(previous => previous && previous.id === id ? session : previous)
      return queued
    } catch (caught) {
      fail(caught)
      return undefined
    }
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
    models,
    contextInfo,
    refreshContext,
    commandPrefix,
    refreshSettings,
    approvals,
    recentWorkspaces,
    select,
    send,
    stop,
    createSession,
    renameSession,
    deleteSession,
    archiveSession,
    forkSession,
    setMode,
    setModel,
    setPermission,
    withdrawQueued,
    resolveApproval,
    dismissError: () => setError(null),
  }
}
