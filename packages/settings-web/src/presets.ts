/**
 * Starting points for the provider form.
 *
 * Only endpoints and model ids we are confident about are prefilled: an
 * aggregator's catalog changes without notice, and a stale id in a template is
 * worse than an empty list (the form's "拉取模型" fills it from the provider).
 */
export interface ProviderPreset {
  id: string
  name: string
  note?: string
  website?: string
  baseUrl: string
  models: Array<{ id: string }>
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    website: 'https://platform.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    website: 'https://platform.openai.com',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    note: '聚合多家模型；模型 id 形如 openai/gpt-4.1',
    website: 'https://openrouter.ai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    website: 'https://platform.moonshot.cn',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [],
  },
  {
    id: 'zhipu',
    name: '智谱开放平台',
    website: 'https://open.bigmodel.cn',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [],
  },
  {
    id: 'dashscope',
    name: '通义千问（兼容模式）',
    website: 'https://dashscope.aliyun.com',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    note: '本机服务，通常无需密钥',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    note: '本机服务，通常无需密钥',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: [],
  },
]
