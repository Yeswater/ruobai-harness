import type { AttachmentMeta } from '@ruobai/chat-protocol'
import { formatBytes } from '../attachments.ts'
import { CloseIcon, FileTextIcon } from './Icons.tsx'

interface AttachmentRailProps {
  attachments: AttachmentMeta[]
  onRemove?: (id: string) => void
}

export function AttachmentRail({ attachments, onRemove }: AttachmentRailProps) {
  if (!attachments.length) return null

  return (
    <div className="attachment-rail">
      {attachments.map(attachment => attachment.kind === 'image' && attachment.data
        ? (
          <div
            key={attachment.id}
            className="attachment-thumb"
            title={`${attachment.name} · ${formatBytes(attachment.size)}`}
          >
            <img src={`data:${attachment.mime};base64,${attachment.data}`} alt={attachment.name} />
            {onRemove
              ? (
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`移除 ${attachment.name}`}
                  onClick={() => onRemove(attachment.id)}
                >
                  <CloseIcon size={10} />
                </button>
              )
              : null}
          </div>
        )
        : (
          <div key={attachment.id} className="attachment-chip" title={attachment.path ?? attachment.name}>
            <FileTextIcon size={13} />
            <span className="attachment-name">{attachment.name}</span>
            <span className="attachment-size">{formatBytes(attachment.size)}</span>
            {onRemove
              ? (
                <button
                  type="button"
                  className="attachment-remove inline"
                  aria-label={`移除 ${attachment.name}`}
                  onClick={() => onRemove(attachment.id)}
                >
                  <CloseIcon size={10} />
                </button>
              )
              : null}
          </div>
        ))}
    </div>
  )
}
