import { describe, expect, it } from 'vitest'
import {
  balanceApiFor, matchModelMeta, modelsFromPayload, PROVIDER_PRESETS, presetById,
} from '../src/index.ts'

describe('provider catalog', () => {
  it('has unique preset keys and usable endpoints', () => {
    const ids = PROVIDER_PRESETS.map(preset => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl).toMatch(/^https?:\/\//)
      const modelIds = preset.models.map(model => model.id)
      expect(new Set(modelIds).size).toBe(modelIds.length)
    }
  })

  it('matches curated metadata across vendor-prefixed ids', () => {
    expect(matchModelMeta('DeepSeek-V4-Pro')).toMatchObject({ contextWindow: 1_000_000 })
    expect(matchModelMeta('deepseek-ai/DeepSeek-V4-Pro')).toMatchObject({ contextWindow: 1_000_000 })
    expect(matchModelMeta('zai-org/GLM-5.2')?.inputTypes).toEqual(['text', 'image'])
  })

  it('does not fall back to a near miss', () => {
    expect(matchModelMeta('glm-5.3-flash-x')).toBeUndefined()
    expect(matchModelMeta('totally-unknown')).toBeUndefined()
  })

  it('merges endpoint fields over curated metadata', () => {
    const models = modelsFromPayload({
      data: [
        { id: 'glm-5.2', context_length: 123_456 },
        { id: 'vendor/deepseek-v4-pro', name: 'V4 Pro', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'unknown-model', context_window: '64000', max_output_tokens: 8_192 },
      ],
    })

    expect(models).toEqual([
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 123_456, maxOutputTokens: 131_072, inputTypes: ['text', 'image'] },
      { id: 'vendor/deepseek-v4-pro', name: 'V4 Pro', contextWindow: 1_000_000, maxOutputTokens: 256_000, inputTypes: ['text', 'image'] },
      { id: 'unknown-model', contextWindow: 64_000, maxOutputTokens: 8_192 },
    ])
  })

  it('takes plain id lists and deduplicates', () => {
    expect(modelsFromPayload({ models: ['a', 'a', { id: 'b' }] })).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(modelsFromPayload(undefined)).toEqual([])
  })

  it('resolves balance endpoints from presets and hostnames', () => {
    expect(balanceApiFor('deepseek', undefined)).toBe('deepseek')
    expect(balanceApiFor(undefined, 'https://api.deepseek.com/v1')).toBe('deepseek')
    expect(balanceApiFor(undefined, 'https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(balanceApiFor(undefined, 'https://open.bigmodel.cn/api/paas/v4')).toBeUndefined()
    expect(presetById('nope')).toBeUndefined()
  })
})
