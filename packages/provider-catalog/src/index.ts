/**
 * Built-in vendor knowledge: endpoints, key pages and model capabilities.
 *
 * A preset is what "just paste the key" means in the UI: endpoint, default
 * models, context window and whether a model accepts images. Anything the
 * vendor's `/models` endpoint reports wins over these entries; they exist
 * because most vendors only return ids.
 */

export type ModelInput = 'text' | 'image'

export type BalanceApi = 'deepseek' | 'moonshot' | 'openrouter' | 'siliconflow'

export interface CatalogModel {
  id: string
  name?: string
  /** Context window in tokens. */
  contextWindow?: number
  /** Per-request output cap in tokens. */
  maxOutputTokens?: number
  inputTypes?: ModelInput[]
}

export interface ProviderPreset {
  /** Stable preset key, also stored on the provider entry. */
  id: string
  name: string
  note?: string
  website?: string
  /** Console page that issues API keys. */
  keyUrl?: string
  baseUrl: string
  /** Official balance endpoint family, when the vendor has one. */
  balance?: BalanceApi
  models: CatalogModel[]
}

const textOnly: ModelInput[] = ['text']
const textAndImage: ModelInput[] = ['text', 'image']

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    website: 'https://platform.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    baseUrl: 'https://api.deepseek.com/v1',
    balance: 'deepseek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxOutputTokens: 256_000, inputTypes: textAndImage },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4-Pro', contextWindow: 1_000_000, maxOutputTokens: 256_000, inputTypes: textOnly },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot（Kimi 开放平台）',
    note: '开放平台按量计费；Kimi Code 会员订阅是另一个端点',
    website: 'https://platform.moonshot.cn',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    baseUrl: 'https://api.moonshot.cn/v1',
    balance: 'moonshot',
    models: [
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 262_144 },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    website: 'https://open.bigmodel.cn',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxOutputTokens: 131_072, inputTypes: textAndImage },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_000_000, maxOutputTokens: 131_072, inputTypes: textAndImage },
      { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 204_800, maxOutputTokens: 131_072 },
      { id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 204_800, maxOutputTokens: 131_072 },
    ],
  },
  {
    id: 'dashscope',
    name: '阿里云百炼（Qwen）',
    website: 'https://bailian.console.aliyun.com',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
      { id: 'qwen3.7-flash', name: 'Qwen3.7 Flash', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    website: 'https://platform.openai.com',
    keyUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 1_050_000, maxOutputTokens: 128_000, inputTypes: textAndImage },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 400_000, maxOutputTokens: 128_000, inputTypes: textAndImage },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 400_000, maxOutputTokens: 128_000, inputTypes: textAndImage },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    note: '聚合多家模型，模型 id 形如 openai/gpt-5；接入后点「获取模型列表」',
    website: 'https://openrouter.ai',
    keyUrl: 'https://openrouter.ai/settings/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    balance: 'openrouter',
    models: [],
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    note: '聚合站，含 DeepSeek / GLM / Kimi / Qwen',
    website: 'https://cloud.siliconflow.cn',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    baseUrl: 'https://api.siliconflow.cn/v1',
    balance: 'siliconflow',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4-Pro', contextWindow: 1_000_000, maxOutputTokens: 384_000 },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxOutputTokens: 384_000 },
      { id: 'zai-org/GLM-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxOutputTokens: 131_072, inputTypes: textAndImage },
      { id: 'moonshotai/Kimi-K2.7-Code', name: 'Kimi K2.7 Code', contextWindow: 262_144, maxOutputTokens: 131_072 },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    website: 'https://platform.minimaxi.com',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 204_800, maxOutputTokens: 64_000 },
      { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1_000_000, maxOutputTokens: 64_000, inputTypes: textAndImage },
    ],
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    website: 'https://console.x.ai',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    baseUrl: 'https://api.x.ai/v1',
    models: [
      { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500_000, maxOutputTokens: 128_000, inputTypes: textAndImage },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    note: '走 Gemini 的 OpenAI 兼容端点',
    website: 'https://aistudio.google.com',
    keyUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: textAndImage },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: textAndImage },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: textAndImage },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    note: '本机服务，通常无需密钥',
    website: 'https://ollama.com',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    note: '本机服务，通常无需密钥',
    website: 'https://lmstudio.ai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: [],
  },
]

export function presetById(id: string | undefined): ProviderPreset | undefined {
  if (!id) return undefined
  return PROVIDER_PRESETS.find(preset => preset.id === id)
}

/** Balance endpoint family, from the stored preset or the endpoint host. */
export function balanceApiFor(presetId: string | undefined, baseUrl: string | undefined): BalanceApi | undefined {
  const preset = presetById(presetId)
  if (preset?.balance) return preset.balance
  const host = hostOf(baseUrl)
  if (!host) return undefined
  if (host === 'api.deepseek.com') return 'deepseek'
  if (host === 'api.moonshot.cn' || host === 'api.moonshot.ai') return 'moonshot'
  if (host === 'openrouter.ai') return 'openrouter'
  if (host === 'api.siliconflow.cn') return 'siliconflow'
  return undefined
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return undefined
  }
}

/** Canonical metadata indexed by id and by the vendor-prefixed tail. */
const META = new Map<string, CatalogModel>()
for (const preset of PROVIDER_PRESETS) {
  for (const model of preset.models) {
    addMeta(model.id, model)
    const tail = model.id.split('/').pop()
    if (tail && tail !== model.id) addMeta(tail, model)
  }
}

function addMeta(key: string, model: CatalogModel) {
  const normalized = normalizeId(key)
  if (normalized && !META.has(normalized)) META.set(normalized, model)
}

function normalizeId(raw: string): string {
  return raw.trim().toLowerCase().replace(/:(free|beta|latest|extended)$/i, '')
}

/**
 * Curated capabilities for a model id.
 *
 * Exact match only (including the `vendor/tail` form): a near miss such as
 * `glm-4.7-flashx` must not inherit `glm-4.7-flash`'s vision flag.
 */
export function matchModelMeta(rawId: string): CatalogModel | undefined {
  const id = normalizeId(rawId)
  if (!id) return undefined
  const direct = META.get(id)
  if (direct) return direct
  const tail = id.split('/').pop()!
  return META.get(tail)
}

function positiveInt(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function inputTypesOf(row: Record<string, any>): ModelInput[] | undefined {
  const explicit = row.input_types ?? row.inputTypes
  if (Array.isArray(explicit)) {
    const types = explicit.filter((item): item is ModelInput => item === 'text' || item === 'image')
    if (types.length) return [...new Set(types)]
  }

  const declared = [
    row.input_modalities,
    row.architecture?.input_modalities,
  ].find(value => Array.isArray(value)) as unknown[] | undefined
  const tokens = new Set<string>()
  if (declared) for (const item of declared) if (typeof item === 'string') tokens.add(item.toLowerCase())

  const modality = stringOf(row.architecture?.modality) ?? stringOf(row.modality)
  if (modality) {
    for (const part of modality.split(/[+,\->]+/)) tokens.add(part.trim().toLowerCase())
  }

  if (row.supports_vision === true || row.capabilities?.vision === true) tokens.add('image')
  if (tokens.size) {
    const types: ModelInput[] = tokens.has('image') ? ['text', 'image'] : ['text']
    return types
  }
  return undefined
}

function rowInfo(row: Record<string, any>): Partial<CatalogModel> {
  const contextWindow = positiveInt(
    row.context_length
    ?? row.context_window
    ?? row.max_context_length
    ?? row.max_input_tokens
    ?? row.limits?.context_window
    ?? row.top_provider?.context_length,
  )
  const maxOutputTokens = positiveInt(
    row.max_output_tokens
    ?? row.max_completion_tokens
    ?? row.max_output
    ?? row.limits?.max_output_tokens
    ?? row.top_provider?.max_completion_tokens,
  )
  const name = stringOf(row.name) ?? stringOf(row.display_name) ?? stringOf(row.displayName)
  const inputTypes = inputTypesOf(row)
  return {
    ...(name ? { name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(inputTypes ? { inputTypes } : {}),
  }
}

/**
 * Normalize a `/models` response into entries the form can store.
 *
 * Vendor metadata and the curated catalog are merged field by field; the
 * endpoint wins because a new context window is more current than a preset.
 */
export function modelsFromPayload(payload: unknown, presetId?: string): CatalogModel[] {
  const rows = Array.isArray((payload as any)?.data)
    ? (payload as any).data
    : Array.isArray((payload as any)?.models)
      ? (payload as any).models
      : Array.isArray(payload)
        ? payload
        : []

  const seen = new Set<string>()
  const result: CatalogModel[] = []
  for (const raw of rows) {
    const row = typeof raw === 'string' ? { id: raw } : raw
    const id = stringOf(row?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)

    const fromEndpoint = rowInfo(row)
    const fromCatalog = matchModelMeta(id) ?? presetById(presetId)?.models.find(model => model.id.toLowerCase() === id.toLowerCase())
    const merged: CatalogModel = { id }
    const name = fromEndpoint.name ?? fromCatalog?.name
    if (name) merged.name = name
    const contextWindow = fromEndpoint.contextWindow ?? fromCatalog?.contextWindow
    if (contextWindow) merged.contextWindow = contextWindow
    const maxOutputTokens = fromEndpoint.maxOutputTokens ?? fromCatalog?.maxOutputTokens
    if (maxOutputTokens) merged.maxOutputTokens = maxOutputTokens
    const inputTypes = fromEndpoint.inputTypes ?? fromCatalog?.inputTypes
    if (inputTypes?.length) merged.inputTypes = [...inputTypes]
    result.push(merged)
  }
  return result
}

export default PROVIDER_PRESETS
