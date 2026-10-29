import { useState } from 'react'
import type { PlanProposal } from '../api.ts'
import { MarkdownPreview } from './MarkdownPreview.tsx'

interface PlanCardProps {
  proposal: PlanProposal
  onAccept: () => void
  onRevise: (feedback: string) => void
}

/**
 * The plan card: the model's implementation plan with one-click accept.
 *
 * A plan written as chat prose leaves the user with nothing to act on. The card
 * keeps the plan next to the decision, so accepting starts execution and a
 * revision goes back as the next instruction. The plan is already complete —
 * revising does not need the input box, only a line saying what to change.
 */
export function PlanCard({ proposal, onAccept, onRevise }: PlanCardProps) {
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')

  const submitRevision = () => {
    onRevise(feedback.trim())
    setRevising(false)
    setFeedback('')
  }
  const cancelRevision = () => {
    setRevising(false)
    setFeedback('')
  }

  return (
    <div className="approval plan">
      <div className="approval-head">
        <span className="approval-title">实施计划</span>
        <span className="approval-summary">{proposal.title}</span>
      </div>

      <div className="plan-body">
        <MarkdownPreview content={proposal.plan} />
      </div>

      {revising
        ? (
          <div className="plan-revise">
            <textarea
              value={feedback}
              rows={2}
              aria-label="修改意见"
              placeholder="要改什么？留空表示让模型自行调整"
              onChange={event => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  submitRevision()
                }
              }}
            />
            <div className="approval-actions">
              <button type="button" className="btn ghost" onClick={cancelRevision}>取消</button>
              <button type="button" className="btn" onClick={submitRevision}>提交修改</button>
            </div>
          </div>
        )
        : (
          <div className="approval-actions">
            <button type="button" className="btn ghost" onClick={() => setRevising(true)}>继续修改</button>
            <button type="button" className="btn" onClick={onAccept}>开始执行</button>
          </div>
        )}
    </div>
  )
}
