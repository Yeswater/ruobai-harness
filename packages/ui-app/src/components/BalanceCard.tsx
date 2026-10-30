import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type LlmOverview, type LlmProviderOverview } from '../api.ts'
import { useEscapeKey } from '../useEscapeKey.ts'
import { ChevronRightIcon, RefreshIcon, WalletIcon } from './Icons.tsx'

interface BalanceCardProps {
  /** Opens the model settings tab. */
  onOpenModelSettings: () => void
}

const POLL_MS = 5 * 60_000
const POPOVER_WIDTH = 420

/**
 * Sidebar account card: the active provider's official balance and today's
 * token total. Balance is fetched by the host, so the key never reaches here.
 */
export function BalanceCard({ onOpenModelSettings }: BalanceCardProps) {
  const [overview, setOverview] = useState<LlmOverview | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true)
    try {
      setOverview(await api.llmOverview(refresh))
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
    const timer = setInterval(() => void load(false), POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const left = Math.min(rect.right + 10, window.innerWidth - POPOVER_WIDTH - 8)
      setPosition({
        left: Math.max(8, left),
        bottom: Math.max(8, window.innerHeight - rect.bottom + 4),
      })
    }
    update()
    const onPointer = (event: MouseEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return
      if (triggerRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEscapeKey(() => setOpen(false), open)

  const providers = overview?.providers ?? []
  const active = providers.find(provider => provider.active)
  const visible = Boolean(overview) && providers.some(provider => provider.hasKey || provider.active)
  if (!visible) return null

  const usage = overview!.usage
  const activeBalance = active?.state === 'ok' ? active.balance : undefined

  return (
    <div className="balance-card-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`balance-card ${open ? 'open' : ''}`}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label="查看模型余额与今日用量"
      >
        <span className="balance-card-icon"><WalletIcon size={18} /></span>
        <span className="balance-card-body">
          <span className="balance-card-title">{active?.name ?? '模型'}</span>
          <span className="balance-card-amount">
            {activeBalance ? moneyText(activeBalance) : active ? stateText(active) : '未接入模型'}
          </span>
          <span className="balance-card-sub">
            {activeBalance ? '账户余额' : active?.state === 'unsupported' ? '无余额接口' : '点击查看详情'}
          </span>
          <span className="balance-card-usage">
            今日 Token <b>{compactNumber(usage.totalTokens)}</b>
          </span>
        </span>
        <span className="balance-card-chevron"><ChevronRightIcon size={14} /></span>
      </button>

      {open && position
        ? createPortal(
          <div
            ref={popoverRef}
            className="balance-popover"
            style={{ left: position.left, bottom: position.bottom, width: POPOVER_WIDTH }}
            role="dialog"
            aria-label="模型余额与额度"
          >
            <div className="balance-popover-head">
              <span>模型余额与额度</span>
              <button
                type="button"
                className="icon-btn subtle"
                onClick={() => void load(true)}
                disabled={busy}
                aria-label="刷新余额"
                title="刷新"
              >
                <span className={busy ? 'spin' : undefined}><RefreshIcon size={15} /></span>
              </button>
            </div>

            <div className="balance-popover-list">
              {failed ? <div className="balance-row-error">余额服务不可用</div> : null}
              {providers.map(provider => <BalanceRow key={provider.id} provider={provider} />)}
              {providers.length === 0 ? <div className="balance-row-muted">还没有配置供应商</div> : null}
            </div>

            <div className="balance-popover-foot">
              <span>前台每 5 分钟更新</span>
              <button
                type="button"
                className="btn ghost compact"
                onClick={() => {
                  setOpen(false)
                  onOpenModelSettings()
                }}
              >
                模型设置
              </button>
            </div>
          </div>,
          document.body,
        )
        : null}
    </div>
  )
}

function BalanceRow({ provider }: { provider: LlmProviderOverview }) {
  return (
    <div className={`balance-row ${provider.active ? 'active' : ''}`}>
      <div className="balance-row-head">
        <span className="balance-row-name">{provider.name}</span>
        <span className="balance-row-tag">{provider.active ? '当前' : provider.preset ?? ''}</span>
      </div>

      {provider.state === 'ok' && provider.balance ? (
        <>
          <div className="balance-row-line">
            <strong>{moneyText(provider.balance)}</strong>
            <span>账户余额</span>
          </div>
          {provider.balance.items.map((item, index) => (
            <div className="balance-row-item" key={`${item.label}-${index}`}>
              <span>{item.label}</span>
              <span>{symbolOf(item.currency)}{item.amount}</span>
            </div>
          ))}
          <div className="balance-row-time">{formatTime(provider.balance.updatedAt)}</div>
        </>
      ) : provider.state === 'error' ? (
        <div className="balance-row-error">{provider.message ?? '查询失败'}</div>
      ) : provider.state === 'no-key' ? (
        <div className="balance-row-muted">未配置凭据</div>
      ) : provider.state === 'unsupported' ? (
        <div className="balance-row-muted">{provider.hasKey ? '该厂商暂未提供余额接口' : '未配置凭据'}</div>
      ) : null}
    </div>
  )
}

function stateText(provider: LlmProviderOverview) {
  if (provider.state === 'no-key') return '未配置凭据'
  if (provider.state === 'unsupported') return '暂无余额'
  if (provider.state === 'error') return '查询失败'
  return '—'
}

function moneyText(balance: { total?: string; currency?: string }) {
  if (!balance.total) return '—'
  return `${symbolOf(balance.currency)}${balance.total}`
}

function symbolOf(currency?: string) {
  if (currency === 'CNY' || currency === 'RMB') return '¥'
  if (currency === 'USD') return '$'
  if (currency === 'EUR') return '€'
  return ''
}

/** 1024-based, matching the context meter, with a B tier for long-running days. */
function compactNumber(value: number) {
  const units: Array<[number, string]> = [[1024 ** 4, 'T'], [1024 ** 3, 'B'], [1024 ** 2, 'M'], [1024, 'K']]
  for (const [size, suffix] of units) {
    if (Math.abs(value) >= size) return `${(value / size).toFixed(1).replace(/\.0$/, '')}${suffix}`
  }
  return String(Math.round(value))
}

function formatTime(at: number) {
  const date = new Date(at)
  const day = date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return `更新于 ${day} ${time}`
}
