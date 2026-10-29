import { useEffect, useState } from 'react'
import type { CommitProposal } from '../api.ts'

interface CommitCardProps {
  proposal: CommitProposal
  onCommit: (message: string) => void
  onDismiss: () => void
}

/**
 * The commit card: a message is already written, so accepting is one click.
 *
 * It replaces asking the agent "should I commit?" in the transcript — that costs
 * a model round trip and buries the decision in conversation. Here the message
 * is editable, the alternatives are chips, and the file list stays visible so
 * the user sees what the commit will contain.
 */
export function CommitCard({ proposal, onCommit, onDismiss }: CommitCardProps) {
  const [message, setMessage] = useState(proposal.message)
  // A new proposal replaces the previous one's text; the user's edit belongs to
  // the diff it was written for.
  useEffect(() => setMessage(proposal.message), [proposal.id, proposal.message])

  const submit = () => {
    const value = message.trim()
    if (value) onCommit(value)
  }
  const files = proposal.files
  const shown = files.slice(0, 4)
  const hidden = files.length - shown.length

  return (
    <div className="approval commit">
      <div className="approval-head">
        <span className="approval-title">提交这次的改动</span>
        <span className="approval-summary">
          {files.length} 个文件
          {proposal.stat.add || proposal.stat.del ? ` · +${proposal.stat.add} −${proposal.stat.del}` : ''}
        </span>
      </div>

      <div className="commit-files">
        {shown.map(path => <code key={path}>{path}</code>)}
        {hidden > 0 ? <code>… 还有 {hidden} 个</code> : null}
      </div>

      <div className="commit-message">
        <input
          value={message}
          aria-label="提交说明"
          onChange={event => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
      </div>

      {proposal.skipped.length
        ? (
          <div className="commit-skipped">
            已排除 {proposal.skipped.length} 个 harness 自身状态文件（{proposal.skipped.slice(0, 2).join('、')}
            {proposal.skipped.length > 2 ? ' 等' : ''}）
          </div>
        )
        : null}

      {proposal.candidates.length > 1
        ? (
          <div className="commit-candidates">
            {proposal.candidates.map(candidate => (
              <button
                key={candidate}
                type="button"
                className={`chip ${candidate === message ? 'active' : ''}`}
                onClick={() => setMessage(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>
        )
        : null}

      <div className="approval-actions">
        <button type="button" className="btn ghost" onClick={onDismiss}>稍后</button>
        <button type="button" className="btn" disabled={!message.trim()} onClick={submit}>提交</button>
      </div>
    </div>
  )
}
