import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'
import { queryBalance } from '../src/balances.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  while (cleanups.length) await cleanups.pop()!()
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('balance adapters', () => {
  it('reads DeepSeek balance from the account root, not the /v1 layer', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '65.66', topped_up_balance: '65.66', granted_balance: '0.00' }],
    }))

    const balance = await queryBalance('deepseek', 'https://api.deepseek.com/v1', 'sk-test')
    expect(String(spy.mock.calls[0][0])).toBe('https://api.deepseek.com/user/balance')
    expect(balance).toMatchObject({
      available: true,
      currency: 'CNY',
      total: '65.66',
      items: [
        { label: '充值余额', amount: '65.66', currency: 'CNY' },
        { label: '赠送余额', amount: '0.00', currency: 'CNY' },
      ],
    })
  })

  it('reads Moonshot, OpenRouter and SiliconFlow payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      data: { available_balance: 12.5, cash_balance: 10, voucher_balance: 2.5 },
    }))
    expect(await queryBalance('moonshot', 'https://api.moonshot.cn/v1', 'sk')).toMatchObject({
      currency: 'CNY',
      total: '12.50',
      available: true,
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: { total_credits: 20, total_usage: 5 } }))
    expect(await queryBalance('openrouter', 'https://openrouter.ai/api/v1', 'sk')).toMatchObject({
      currency: 'USD',
      total: '15.00',
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      data: { totalBalance: 3.2, balanceCharged: 1, balanceVoucher: 2.2 },
    }))
    expect(await queryBalance('siliconflow', 'https://api.siliconflow.cn/v1', 'sk')).toMatchObject({
      total: '3.20',
      items: [
        { label: '充值余额', amount: '1.00' },
        { label: '赠送余额', amount: '2.20' },
      ],
    })
  })

  it('turns auth failures into a readable error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'bad key' }, 401))
    await expect(queryBalance('deepseek', 'https://api.deepseek.com/v1', 'sk')).rejects.toThrow('密钥无效')
  })
})

describe('llm balance service', () => {
  it('connects a vendor from a preset and serves balance plus today tokens over HTTP', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const harness: Harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url

    // Balance calls go to the vendor; everything else still reaches the harness.
    const original = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://api.deepseek.com/user/balance') {
        return Promise.resolve(json({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '65.66' }],
        }))
      }
      return original(input, init)
    })

    const created = await (await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'deepseek', apiKey: 'sk-test' }),
    })).json() as { settings: { llm: { activeProvider?: string; providers: Array<any> } } }

    const provider = created.settings.llm.providers.find(item => item.id === 'deepseek')
    expect(provider).toMatchObject({
      preset: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      hasApiKey: true,
    })
    expect(provider.models[0]).toMatchObject({ id: 'deepseek-flash', contextWindow: 1_000_000 })
    expect(created.settings.llm.activeProvider).toBe('deepseek')

    const session = harness.ctx.sessions.create({ title: 'usage' })
    harness.ctx.sessions.append(session.id, 'message/assistant', {
      id: 'm1',
      parts: [{ type: 'text', text: 'hi' }],
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
    })

    const overview = await (await fetch(`${base}/api/llm/overview?refresh=1`)).json() as any
    expect(overview.providers).toEqual([
      expect.objectContaining({
        id: 'deepseek',
        active: true,
        state: 'ok',
        balance: expect.objectContaining({ currency: 'CNY', total: '65.66' }),
      }),
    ])
    expect(overview.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      totalTokens: 150,
      calls: 1,
    })
  })

  it('reports missing keys and vendors without a balance endpoint', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const harness: Harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url

    await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'zhipu', apiKey: 'sk-test' }),
    })
    await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'siliconflow' }),
    })

    const overview = await (await fetch(`${base}/api/llm/overview?refresh=1`)).json() as any
    const byId = new Map<string, any>(overview.providers.map((item: any) => [item.id, item]))
    expect(byId.get('zhipu')).toMatchObject({ state: 'unsupported', hasKey: true })
    expect(byId.get('siliconflow')).toMatchObject({ state: 'no-key' })
    // The seeded DeepSeek provider has no key either.
    expect(byId.get('deepseek')).toMatchObject({ state: 'no-key' })
  })
})
