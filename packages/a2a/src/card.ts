import { isIP } from 'node:net'
import { slug } from './config.ts'

export interface A2aSkill {
  id: string
  name: string
  description?: string
}

export interface A2aCard {
  name: string
  description?: string
  rpcUrl: string
  cardUrl: string
  skills: A2aSkill[]
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface A2aFetchOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  allowPrivateHosts?: boolean
  maxBytes?: number
  /** Proxy-aware fetch; defaults to the global one. */
  fetch?: FetchLike
}

const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json']

/** Fetches an Agent Card, trying both well-known paths when given a base URL. */
export async function fetchAgentCard(baseUrl: string, options: A2aFetchOptions = {}): Promise<A2aCard> {
  const candidates = baseUrl.endsWith('.json')
    ? [baseUrl]
    : CARD_PATHS.map(path => `${baseUrl.replace(/\/+$/, '')}${path}`)
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const { text, url } = await safeFetchText(candidate, options)
      const card = parseCard(text, url, baseUrl)
      if (!card) throw new Error('invalid agent card')
      return card
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('agent card unavailable')
}

function parseCard(raw: string, cardUrl: string, configuredUrl: string): A2aCard | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!data || typeof data !== 'object') return undefined
  const card = data as Record<string, unknown>
  const interfaces = Array.isArray(card.interfaces) ? card.interfaces : []
  const interfaceUrl = interfaces
    .map(entry => entry && typeof entry === 'object' ? (entry as Record<string, unknown>).url : undefined)
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  const rpcUrl = typeof card.url === 'string' && card.url.trim()
    ? card.url.trim()
    : interfaceUrl ?? configuredUrl
  const skills: A2aSkill[] = Array.isArray(card.skills)
    ? card.skills.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const skill = entry as Record<string, unknown>
      const name = typeof skill.name === 'string' ? skill.name.trim() : typeof skill.id === 'string' ? skill.id : ''
      if (!name) return []
      const id = typeof skill.id === 'string' && skill.id.trim() ? skill.id.trim() : slug(name)
      return [{
        id,
        name,
        ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
      }]
    })
    : []
  return {
    name: typeof card.name === 'string' && card.name.trim() ? card.name.trim() : configuredUrl,
    ...(typeof card.description === 'string' ? { description: card.description } : {}),
    rpcUrl,
    cardUrl,
    skills,
  }
}

export async function safeFetchText(url: string, options: A2aFetchOptions = {}): Promise<{ text: string; url: string }> {
  const maxBytes = options.maxBytes ?? 65_536
  const fetchImpl = options.fetch ?? fetch
  let current = new URL(url)
  for (let hop = 0; hop <= 3; hop += 1) {
    assertSafeUrl(current, options.allowPrivateHosts === true)
    const timeoutMs = options.timeoutMs ?? 15_000
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (options.signal) signals.push(options.signal)
    const response = await fetchImpl(current, {
      headers: options.headers,
      redirect: 'manual',
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`HTTP ${response.status}`)
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { text: await readCapped(response, maxBytes), url: current.toString() }
  }
  throw new Error('too many redirects')
}

export async function readCapped(response: Response, maxBytes: number) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error('response too large')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
}

/** Rejects non-HTTP schemes and private hosts unless explicitly allowed. */
export function assertSafeUrl(url: URL, allowPrivateHosts: boolean) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${url.protocol}`)
  }
  if (allowPrivateHosts) return
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1') {
    throw new Error('private agent address is not allowed')
  }
  const family = isIP(host)
  if (family === 4 && isPrivateIpv4(host)) throw new Error('private agent address is not allowed')
  if (family === 6 && isPrivateIpv6(host)) throw new Error('private agent address is not allowed')
}

function isPrivateIpv4(host: string) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

function isPrivateIpv6(host: string) {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase()
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80')
}
