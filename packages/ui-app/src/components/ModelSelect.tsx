import { createPortal } from 'react-dom'
import type { ModelProvider } from '../api.ts'
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

export function ModelSelect({
  provider, model, providers, open, disabled, onOpenChange, onChange,
}: ModelSelectProps) {
  const { triggerRef, menuRef, position } = useAnchoredMenu({
    open,
    onClose: () => onOpenChange(false),
    width: 280,
  })

  const currentProvider = provider && providers.some(item => item.id === provider)
    ? provider
    : providers.find(item => item.models.includes(model))?.id
  const currentProviderLabel = providers.find(item => item.id === currentProvider)?.name

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
        title={currentProviderLabel ? `${currentProviderLabel} / ${model}` : model}
      >
        <BotIcon size={13} />
        <span>{model}</span>
        <ChevronDownIcon size={11} />
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
                    {item.models.map(name => (
                      <button
                        key={`${item.id}:${name}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.id === currentProvider && name === model}
                        className={`view-menu-row ${item.id === currentProvider && name === model ? 'selected' : ''}`}
                        onClick={() => pick(item.id, name)}
                      >
                        <span className="view-menu-icon"><BotIcon size={15} /></span>
                        <span className="view-menu-text">
                          <span className="view-menu-title">{name}</span>
                        </span>
                        {item.id === currentProvider && name === model ? <CheckIcon size={14} /> : null}
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
