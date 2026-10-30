# 供应商接入与余额用量

状态：已实现（`@ruobai/provider-catalog`、`@ruobai/llm-balance`、`@ruobai/llm-balance-web`）。

## 问题

接入一家模型厂商原本要手填四件事：请求地址、模型 id、上下文窗口、是否支持图片。前两项能从 OpenAI 兼容的 `/models` 拿到，后两项几乎没有任何厂商会返回；用户只能在厂商文档里逐个核对，填错时表现是上下文占用比例失真、图片附件被静默拒绝。

余额同理：厂商控制台能看到余额，但只有少数厂商把它做成了公开 API。没有统一接口，也没有可以"猜"的字段——DeepSeek 的 `balance_infos[].total_balance` 是字符串，Moonshot 是 `available_balance` 数字，OpenRouter 只给总额度和已用额度。

## 约束

- 只接 OpenAI 兼容协议（`@ruobai/llm-openai`），不新增协议客户端。
- 密钥只写不读：余额查询在 Host 进程里用 `ctx.settings.apiKeyFor()`，密钥不经过浏览器。
- 余额失败必须可见：不能把查询失败显示成 ¥0，也不能拿控制台页面抓取兜底。
- 不引入新依赖；余额查询用标准 `fetch`。

## 方案

### 1. 内置厂商目录（`packages/provider-catalog`）

纯数据包，导出 `PROVIDER_PRESETS`：厂商 id、名称、控制台地址、OpenAI 兼容 baseUrl、可领取密钥的页面、精选模型（含 `contextWindow` / `maxOutputTokens` / `inputTypes`），以及该厂商的余额接口族。

当前收录：DeepSeek、Moonshot（开放平台）、智谱 GLM、阿里云百炼、OpenAI、OpenRouter、硅基流动、MiniMax、xAI Grok、Google Gemini（OpenAI 兼容端点）、Ollama、LM Studio。

`POST /api/providers` 接受 `{ preset, apiKey }`：服务端补齐地址、名称和精选模型，浏览器只需给一个 Key。同一 preset 再次接入会更新原来那条配置，而不是在列表里排第二个 DeepSeek。

### 2. 模型元数据回填

`GET /api/providers/:id/models` 拉取后走 `modelsFromPayload()`：

1. 先读端点返回的结构化字段：`context_length`、`max_context_length`、`max_output_tokens`、`architecture.input_modalities`、`supports_vision` 等（OpenRouter、硅基流动会返回）。
2. 缺失字段用目录里的精选条目补齐（DeepSeek、GLM、Kimi 等只返回 id 的端点是这条路径）。
3. 端点值优先于目录值：新上下文窗口比内置表更可信。

匹配只做精确 id 和 `vendor/tail` 形式的精确匹配，不做模糊匹配。`glm-4.7-flashx` 不会继承 `glm-4.7-flash` 的图片能力——按相似度猜能力会把纯文本模型标成多模态。

### 3. 余额查询（`packages/llm-balance`）

`LlmBalanceService.overview(force)` 返回：

- 每个已配置供应商的状态：`ok` / `no-key` / `unsupported` / `error`，以及余额明细；
- 今日 token 用量：扫描当天 `message/assistant` 事件里的 `usage`，四个计数器相加。

支持的厂商与端点：

| 厂商 | 端点 | 解析 |
| --- | --- | --- |
| DeepSeek | `GET {root}/user/balance` | `balance_infos[]`，字符串金额；`/v1` 要剥掉 |
| Moonshot | `GET {base}/users/me/balance` | `available_balance` / `cash_balance` / `voucher_balance` |
| OpenRouter | `GET {base}/credits` | `total_credits - total_usage` |
| 硅基流动 | `GET {base}/user/info` | `totalBalance` / `balanceCharged` / `balanceVoucher` |

其余厂商返回 `unsupported`，界面显示"该厂商暂未提供余额接口"。这是刻意留白：没有公开 API 的厂商不去猜，也不做网页抓取。

厂商识别优先用保存的 `preset`，没有时看 baseUrl 域名（兼容手工配置的老条目，例如本地已有的 `id: openai` 但地址是 `api.deepseek.com` 的情况）。

缓存：余额 5 分钟，今日用量 15 秒；`?refresh=1` 强制刷新。前端每 5 分钟拉一次，与卡片上的"前台每 5 分钟更新"一致。

### 4. 界面

- 设置 → 模型：新增"快速接入"区，选厂商、填 Key、点"接入并获取模型"；随后自动拉模型、回填能力并设为当前供应商。模型卡片显示 `上下文 / 输出 / 支持图片` 摘要。
- 侧栏底部账户卡片：当前供应商余额 + 今日 Token。点击打开"模型余额与额度"浮层，列出全部供应商、刷新按钮和"模型设置"入口；没有配置 Key 的供应商显示"未配置凭据"。

## 失败模式

- **余额地址拼错**：DeepSeek 余额接口在账号根上（`api.deepseek.com/user/balance`），挂在 `/v1` 下的 OpenAI 兼容层没有这个路由。`deepseekRoot()` 负责剥掉 `/v1`。
- **端点字段变了**：只认白名单字段；不认识就退回目录条目或留空，不会把 `context_length: null` 写成 0。
- **模型列表拉取失败但 Key 有效**：快速接入仍保存供应商与精选模型，提示里说明拉取失败，不阻断接入。
- **查询超时**：10 秒超时，状态为 `error` 并显示原因；不返回旧缓存冒充新结果（缓存未过期时本来就复用）。
- **环境变量 Key**：`apiKeyFor()` 按 preset 查 `DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY` 等，没有 Key 也能从环境接入；`hasApiKey` 与余额查询都走同一条解析。

## 验证

- `packages/provider-catalog/tests/catalog.spec.ts`：preset 唯一性、`vendor/tail` 匹配、拒绝近似 id、端点字段覆盖目录值、余额接口识别。
- `packages/llm-balance/tests/balance.spec.ts`：四家余额解析、401 文案、`preset + key` 接入、今日用量聚合、无 Key / 无接口状态。
- `packages/settings-web/tests/settings.spec.ts`：原有供应商 CRUD 与 `/models` 行为未变。
- 本机实测：现有 DeepSeek 配置（地址 `api.deepseek.com/v1`）经 `GET /api/llm/overview` 返回真实余额 `¥64.22` 与当日 token 合计；浏览器中侧栏卡片与浮层渲染正常。

## 已知边界

- 精选模型与上下文窗口是静态数据，会随厂商发版过期；"获取模型列表"只更新出现在列表里的模型，已有同 id 的条目保留用户手填值。
- 今日 Token 是全局汇总，不按供应商拆分；事件里只有 usage，没有 provider/model 归属。
- Kimi Code 会员订阅端点（`api.kimi.com/coding/v1`）与开放平台是两套 Key 和模型 id，目前目录只收开放平台；订阅用户可手工添加，余额显示为"暂无接口"。
