import { createPortal } from 'react-dom'
import type { ModelProvider, ProviderModel } from '../api.ts'
import { useAnchoredMenu } from './AnchoredMenu.ts'
import { CheckIcon, ChevronDownIcon } from './Icons.tsx'
import { formatTokens } from './ContextCard.tsx'

interface ModelSelectProps {
  provider?: string
  model: string
  providers: ModelProvider[]
  open: boolean
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onChange: (provider: string, model: string) => void
}

function modelDescription(model: ProviderModel) {
  const parts: string[] = []
  if (model.contextWindow) parts.push(`${formatTokens(model.contextWindow)} 上下文`)
  if (model.inputTypes?.length) {
    parts.push(model.inputTypes.map(type => type === 'image' ? '图片' : '文本').join(' / '))
  }
  return parts.join(' · ')
}

export function ModelSelect({
  provider, model, providers, open, disabled, onOpenChange, onChange,
}: ModelSelectProps) {
  const { triggerRef, menuRef, position } = useAnchoredMenu({
    open,
    onClose: () => onOpenChange(false),
    width: 300,
  })

  const currentProvider = provider && providers.some(item => item.id === provider)
    ? provider
    : providers.find(item => item.models.some(entry => entry.id === model))?.id
  const currentProviderLabel = providers.find(item => item.id === currentProvider)?.name
  const currentModel = providers.find(item => item.id === currentProvider)
    ?.models.find(entry => entry.id === model)
  // A session may still carry a model id from a provider that was removed
  // (including the old mock adapter); showing it would advertise a model the
  // user cannot use.
  const chipLabel = !currentProvider ? '未配置模型' : currentModel?.name || model

  const pick = (nextProvider: string, nextModel: string) => {
    onOpenChange(false)
    if (nextProvider === currentProvider && nextModel === model) return
    onChange(nextProvider, nextModel)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-chip model-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        title={currentProviderLabel ? `${currentProviderLabel} / ${chipLabel}` : chipLabel}
      >
        <span>{chipLabel}</span>
        <ChevronDownIcon size={12} />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="view-menu model-menu"
              role="menu"
              aria-label="模型"
              style={{
                left: position.left,
                width: position.width,
                ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
              }}
            >
              {providers.some(item => item.models.length)
                ? providers.filter(item => item.models.length).map(item => (
                  <div key={item.id}>
                    <div className="view-menu-label">
                      {item.name}
                      {item.note ? <span className="model-provider-note">{item.note}</span> : null}
                    </div>
                    {item.models.map(entry => (
                      <button
                        key={`${item.id}:${entry.id}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.id === currentProvider && entry.id === model}
                        className={`view-menu-row ${item.id === currentProvider && entry.id === model ? 'selected' : ''}`}
                        onClick={() => pick(item.id, entry.id)}
                      >
                        <span className="view-menu-text">
                          <span className="view-menu-title">{entry.name || entry.id}</span>
                          {modelDescription(entry)
                            ? <span className="view-menu-desc">{modelDescription(entry)}</span>
                            : null}
                        </span>
                        {item.id === currentProvider && entry.id === model ? <CheckIcon size={14} /> : null}
                      </button>
                    ))}
                  </div>
                ))
                : <div className="view-menu-empty">暂无可用模型</div>}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
