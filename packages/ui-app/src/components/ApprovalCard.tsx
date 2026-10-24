import type { ApprovalDecision, ApprovalRequest } from '../api.ts'
import { DiffView } from './DiffView.tsx'

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

      {request.diff ? <DiffView diff={request.diff} /> : null}

      {request.subject && !request.guard ? (
        <div className="approval-remember">
          始终允许将记住这条{request.subject.kind === 'command' ? '命令' : '路径'}：
          <code>{request.subject.value}</code>
        </div>
      ) : null}

      {request.guard ? (
        <div className="approval-remember forced">
          {request.guard}。此操作每次都需要确认。
        </div>
      ) : null}

      <div className="approval-actions">
        <button className="btn ghost danger" onClick={() => onResolve('deny')}>拒绝</button>
        {request.guard ? null : (
          <button className="btn ghost" onClick={() => onResolve('always')}>始终允许</button>
        )}
        <button className="btn" onClick={() => onResolve('allow')}>允许一次</button>
      </div>
    </div>
  )
}
