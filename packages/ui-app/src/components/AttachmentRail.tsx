import { useEffect, useState } from 'react'
import type { AttachmentMeta } from '@ruobai/chat-protocol'
import { formatBytes } from '../attachments.ts'
import { CloseIcon, FileTextIcon } from './Icons.tsx'

interface AttachmentRailProps {
  attachments: AttachmentMeta[]
  onRemove?: (id: string) => void
}

export function AttachmentRail({ attachments, onRemove }: AttachmentRailProps) {
  const [preview, setPreview] = useState<AttachmentMeta | null>(null)

  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  if (!attachments.length) return null

  return (
    <>
      <div className="attachment-rail">
        {attachments.map(attachment => attachment.kind === 'image' && attachment.data
          ? (
            <div
              key={attachment.id}
              className="attachment-thumb"
              role="button"
              tabIndex={0}
              title={`${attachment.name} · ${formatBytes(attachment.size)} · 点击预览`}
              onClick={() => setPreview(attachment)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setPreview(attachment)
                }
              }}
            >
              <img src={`data:${attachment.mime};base64,${attachment.data}`} alt={attachment.name} />
              {onRemove
                ? (
                  <button
                    type="button"
                    className="attachment-remove"
                    aria-label={`移除 ${attachment.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onRemove(attachment.id)
                    }}
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

      {preview?.data
        ? (
          <div
            className="image-preview"
            role="dialog"
            aria-modal="true"
            aria-label={preview.name}
            onClick={() => setPreview(null)}
          >
            <figure className="image-preview-inner" onClick={event => event.stopPropagation()}>
              <img
                src={`data:${preview.mime};base64,${preview.data}`}
                alt={preview.name}
              />
              <figcaption>{preview.name} · {formatBytes(preview.size)}</figcaption>
            </figure>
            <button
              type="button"
              className="image-preview-close"
              aria-label="关闭预览"
              onClick={() => setPreview(null)}
            >
              <CloseIcon size={16} />
            </button>
          </div>
        )
        : null}
    </>
  )
}
