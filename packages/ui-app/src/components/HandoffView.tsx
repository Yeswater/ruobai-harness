import { useEffect, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type HandoffManifest } from '../api.ts'
import { MarkdownPreview } from './MarkdownPreview.tsx'

/**
 * Preview of the handoff bundle: the five artifacts the customer receives.
 *
 * Everything is read from `/api/handoff`, which folds existing projections — this
 * view cannot change the delivery, only show what would be handed over.
 */
export function HandoffView({ session }: { session: ChatSession | null }) {
  const [manifest, setManifest] = useState<HandoffManifest | null>(null)
  const [active, setActive] = useState('ACCEPTANCE.md')
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) {
      setManifest(null)
      return
    }
    let cancelled = false
    setError(null)
    void api.handoff(session.id)
      .then((next) => {
        if (cancelled) return
        setManifest(next)
        setActive(next.artifacts.some(artifact => artifact.name === active) ? active : next.artifacts[0]?.name ?? 'ACCEPTANCE.md')
      })
      .catch((caught) => {
        if (cancelled) return
        setManifest(null)
        setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [session?.id, session?.messages.length])

  useEffect(() => {
    if (!session || !manifest) return
    let cancelled = false
    void api.handoffArtifact(session.id, active)
      .then((text) => {
        if (!cancelled) setContent(text)
      })
      .catch(() => {
        if (!cancelled) setContent('')
      })
    return () => {
      cancelled = true
    }
  }, [session?.id, active, manifest])

  if (!session) return <div className="trajectory-empty">请先选择一个会话。</div>
  if (error) return <div className="trajectory-empty">交接包不可用：{error}</div>
  if (!manifest) return <div className="trajectory-empty">生成中…</div>

  return (
    <div className="handoff-view">
      <div className="handoff-head">
        <span className="handoff-title">交接包</span>
        <span className="handoff-meta">
          {manifest.artifacts.length} 个产物 · {manifest.generatedFrom.eventCount} 条事件 · upToSeq {manifest.generatedFrom.upToSeq}
        </span>
      </div>
      <div className="handoff-body">
        <ul className="handoff-list">
          {manifest.artifacts.map(artifact => (
            <li key={artifact.name}>
              <button
                className={`handoff-item ${artifact.name === active ? 'active' : ''}`}
                onClick={() => setActive(artifact.name)}
                title={`sha256 ${artifact.sha256.slice(0, 12)}`}
              >
                <span className="handoff-item-name">{artifact.name}</span>
                <span className="handoff-item-size">{formatBytes(artifact.bytes)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="handoff-preview">
          {active.endsWith('.json')
            ? <pre className="handoff-json">{content}</pre>
            : <MarkdownPreview content={content} />}
        </div>
      </div>
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}
