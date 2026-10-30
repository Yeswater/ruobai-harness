import type { BalanceApi } from '@ruobai/provider-catalog'

export interface BalanceLine {
  label: string
  amount: string
  currency?: string
}

export interface ProviderBalance {
  available: boolean
  currency?: string
  total?: string
  items: BalanceLine[]
  updatedAt: number
}

const TIMEOUT_MS = 10_000

export class BalanceError extends Error {}

/** Query one vendor's official balance endpoint. */
export async function queryBalance(
  api: BalanceApi,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ProviderBalance> {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const fetchedAt = Date.now()

  if (api === 'deepseek') return deepseek(base, apiKey, combined, fetchedAt)
  if (api === 'moonshot') return moonshot(base, apiKey, combined, fetchedAt)
  if (api === 'openrouter') return openrouter(base, apiKey, combined, fetchedAt)
  return siliconflow(base, apiKey, combined, fetchedAt)
}

async function getJson(url: string, apiKey: string, signal: AbortSignal): Promise<any> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/abort|timeout/i.test(message)) throw new BalanceError('查询超时')
    throw new BalanceError(`网络错误：${message}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new BalanceError('密钥无效或没有余额查询权限')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new BalanceError(`余额接口返回 HTTP ${response.status}${text ? `：${text.slice(0, 160)}` : ''}`)
  }
  try {
    return await response.json()
  } catch {
    throw new BalanceError('余额接口返回的不是 JSON')
  }
}

/** The balance endpoint sits on the account root, outside the OpenAI layer. */
function deepseekRoot(baseUrl: string) {
  return baseUrl.replace(/\/(v1|beta|anthropic)$/i, '')
}

async function deepseek(baseUrl: string, apiKey: string, signal: AbortSignal, at: number) {
  const payload = await getJson(`${deepseekRoot(baseUrl)}/user/balance`, apiKey, signal)
  const infos: any[] = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
  const items: BalanceLine[] = []
  for (const info of infos) {
    const currency = typeof info?.currency === 'string' ? info.currency : undefined
    if (info?.topped_up_balance !== undefined) {
      items.push({ label: '充值余额', amount: money(info.topped_up_balance), ...(currency ? { currency } : {}) })
    }
    if (info?.granted_balance !== undefined) {
      items.push({ label: '赠送余额', amount: money(info.granted_balance), ...(currency ? { currency } : {}) })
    }
  }
  const first = infos[0]
  if (!first && items.length === 0) throw new BalanceError('余额接口没有返回账户信息')
  return {
    available: payload?.is_available !== false,
    ...(typeof first?.currency === 'string' ? { currency: first.currency } : {}),
    ...(first?.total_balance !== undefined ? { total: money(first.total_balance) } : {}),
    items,
    updatedAt: at,
  }
}

async function moonshot(baseUrl: string, apiKey: string, signal: AbortSignal, at: number) {
  const payload = await getJson(`${baseUrl}/users/me/balance`, apiKey, signal)
  const data = payload?.data ?? payload
  const available = data?.available_balance
  if (available === undefined) throw new BalanceError('余额接口没有返回账户信息')
  const items: BalanceLine[] = []
  if (data.cash_balance !== undefined) items.push({ label: '现金余额', amount: money(data.cash_balance), currency: 'CNY' })
  if (data.voucher_balance !== undefined) items.push({ label: '代金券', amount: money(data.voucher_balance), currency: 'CNY' })
  return {
    available: Number(available) > 0,
    currency: 'CNY',
    total: money(available),
    items,
    updatedAt: at,
  }
}

async function openrouter(baseUrl: string, apiKey: string, signal: AbortSignal, at: number) {
  const payload = await getJson(`${baseUrl}/credits`, apiKey, signal)
  const data = payload?.data ?? payload
  const credits = Number(data?.total_credits)
  const used = Number(data?.total_usage)
  if (!Number.isFinite(credits) || !Number.isFinite(used)) throw new BalanceError('余额接口没有返回账户信息')
  const remaining = credits - used
  return {
    available: remaining > 0,
    currency: 'USD',
    total: money(remaining),
    items: [
      { label: '已用', amount: money(used), currency: 'USD' },
      { label: '总充值', amount: money(credits), currency: 'USD' },
    ],
    updatedAt: at,
  }
}

async function siliconflow(baseUrl: string, apiKey: string, signal: AbortSignal, at: number) {
  const payload = await getJson(`${baseUrl}/user/info`, apiKey, signal)
  const data = payload?.data ?? payload
  const total = data?.totalBalance ?? data?.balance
  if (total === undefined) throw new BalanceError('余额接口没有返回账户信息')
  const items: BalanceLine[] = []
  if (data.balanceCharged !== undefined) items.push({ label: '充值余额', amount: money(data.balanceCharged), currency: 'CNY' })
  if (data.balanceVoucher !== undefined) items.push({ label: '赠送余额', amount: money(data.balanceVoucher), currency: 'CNY' })
  return {
    available: Number(total) > 0,
    currency: 'CNY',
    total: money(total),
    items,
    updatedAt: at,
  }
}

function money(value: unknown): string {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return String(value ?? '')
  return number.toFixed(2)
}
