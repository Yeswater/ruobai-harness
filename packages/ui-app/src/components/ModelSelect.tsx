import { createPortal } from 'react-dom'
import type { ModelProvider, ProviderModel } from '../api.ts'
import { useAnchoredMenu } from './AnchoredMenu.ts'
import { BotIcon, CheckIcon, ChevronDownIcon } from './Icons.tsx'

interface ModelSelectProps {
  provider?: string
  model: string
  providers: ModelProvider[]
  open: boolean
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onChange: (provider: string, model: string) => void
}

function formatWindow(tokens?: number) {
  if (!tokens) return undefined
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

function modelDescription(model: ProviderModel) {
  const parts: string[] = []
  const window = formatWindow(model.contextWindow)
  if (window) parts.push(`${window} 上下文`)
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
  const chipLabel = currentModel?.name || model

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
        <BotIcon size={14} />
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
                        <span className="view-menu-icon"><BotIcon size={15} /></span>
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
