import type { ApprovalDecision, ApprovalRequest } from '../api.ts'

interface ApprovalCardProps {
  request: ApprovalRequest
  onResolve: (decision: ApprovalDecision) => void
}

export function ApprovalCard({ request, onResolve }: ApprovalCardProps) {
  return (
    <div className="approval">
      <div className="approval-head">
        <span className="approval-title">需要确认</span>
        <span className="approval-tool">{request.tool}</span>
        <span className="approval-summary">{request.summary}</span>
      </div>

      {request.diff ? (
        <div className="approval-diff">
          {request.diff.split('\n').map((line, index) => {
            const kind = line.startsWith('+++') || line.startsWith('---')
              ? 'meta'
              : line.startsWith('+')
                ? 'add'
                : line.startsWith('-') ? 'del' : 'context'
            return <div key={index} className={`diff-line ${kind}`}>{line || ' '}</div>
          })}
        </div>
      ) : null}

      <div className="approval-actions">
        <button className="btn ghost danger" onClick={() => onResolve('deny')}>拒绝</button>
        <button className="btn ghost" onClick={() => onResolve('always')}>始终允许</button>
        <button className="btn" onClick={() => onResolve('allow')}>允许一次</button>
      </div>
    </div>
  )
}
