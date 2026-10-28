# 密钥存储：从 settings.json 里搬走

## 问题

`SettingsService.persist()` 把整个设置对象写成一棵树，其中包括：

- `llm.providers[].apiKey`（供应商密钥）
- `gitee.token`
- `mcp.servers[].env`（连接器的环境变量）

文件位置是 `.ruobai/settings.json`，权限 0644。公开视图一直只暴露 `hasApiKey`，浏览器拿不到明文；但任何能读用户目录的进程都能拿到。这一条在单机 harness 里同样成立：恶意 npm 脚本、其他 agent、备份工具。

## 约束

1. 设置服务不能依赖密钥插件：删掉 `cordis.yml` 里的 `secrets` 一行，系统仍要能启动，并退回明文存储。
2. 不引入依赖。钥匙串用系统自带的 `security` CLI，文件后端用 `node:fs`。
3. 读取路径是同步的：`apiKeyFor()` 会被模型适配器在每次请求前调用。
4. 写入不能出现在进程参数里。

## 方案

### 服务

`@ruobai/secrets` 提供 `ctx.secrets`：

| 方法 | 说明 |
| --- | --- |
| `get(key)` | 同步读内存缓存，供 `apiKeyFor()` 这类热路径使用 |
| `set(key, value)` / `delete(key)` | 串行写入后端；失败不污染后续写入 |
| `keys()` | 只返回键名，可安全记录 |

键的命名空间由使用方定义：

- `llm/<providerId>` —— 供应商密钥
- `gitee/token` —— Gitee 令牌

### 后端

| 平台 | 后端 | 说明 |
| --- | --- | --- |
| macOS | `keychain` | `security add-generic-password -U -s ruobai-harness -a <key> -w`；密码通过 **stdin 两次** 传入（两次提示），不出现在 argv。读取用 `find-generic-password -w` |
| 其他，或 `provider: file` | `file` | `.ruobai/secrets.json`，权限 0600，临时文件 + rename 原子写入 |

钥匙串无法廉价枚举，因此另存一个只含键名的索引 `.ruobai/secrets.json.keys`（0600）。索引丢了只意味着要重新输入密钥，密钥本身仍在系统钥匙串里。

### 与 settings 的接缝

`settings` 不 import `secrets`（否则形成循环），而是持有结构化接口：

```ts
interface SecretStore {
  get(key: string): string | undefined
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
```

- `apiKeyFor()` / `giteeToken()`：先问密钥库，再退回 JSON 里的旧字段与环境变量。
- `upsertProvider()` / `updateGitee()`：有密钥库时写入密钥库，JSON 中不落明文；传空字符串表示删除。
- `removeProvider()`：删除对应密钥；删除失败只记日志，不让供应商留在列表里。

### 迁移

`secrets` 注入 `settings`，在自身初始化完成后调用 `settings.adoptSecrets(store)`：

1. 遍历已有 provider 的 `apiKey` 与 `gitee.token`；
2. 密钥库中尚不存在时写入；
3. 从 JSON 中删除字段；
4. 有改动才 `commit()`（会触发 `settings/updated`，模型适配器重新解析密钥）。

写入成功后才删除明文字段，因此中途崩溃可以重跑；密钥库中已存在的值优先，不会用旧值覆盖新值。

## 失败模式

| 情况 | 行为 |
| --- | --- |
| 钥匙串不可用 / 命令失败 | 初始化失败，`secrets` fiber 进入 FAILED；设置仍能读 JSON（迁移没跑），明确暴露问题而不是静默退回明文 |
| 删除密钥失败 | 供应商仍然被移除，日志留警告；残留密钥不可用 |
| 密钥索引丢失 | 启动时读到空表；用户重新输入密钥即可（旧项仍在钥匙串） |
| 值含换行 | 拒绝写入（`security` 的 stdin 提示按行读取，会截断） |
| 卸载 `secrets` 插件 | 已在钥匙串中的密钥不会自动写回 JSON；需要重新配置。这是有意的：卸载一个安全插件不应该把密钥降级成明文 |
| MCP `env` | **本轮不迁移**。它是任意键值，混着非密钥配置；拆分需要单独的模型 |

## 验证

- `packages/secrets/tests/secrets.spec.ts`
  - 明文迁移：迁移后 JSON 无 `apiKey`，`apiKeyFor()` 仍返回原值，文件权限 0600；
  - 新密钥只进密钥库，公开视图只有 `hasApiKey`；
  - 替换与清空；
  - Gitee token 迁移与清除；
  - 未挂载插件时退回明文（可卸载性）；
  - macOS 上真实钥匙串 round-trip：写入 → 读取 → 删除，测试结束不留条目。
- `packages/settings-web/tests/settings.spec.ts`：创建供应商后 `settings.json` 不含 `sk-test`，密钥出现在隔离的密钥文件里。
- `tests/harness.ts` 用 `file` 后端挂载，测试永远不会碰开发者的登录钥匙串。

## 后续

1. MCP `env` 的“密钥 / 普通配置”分离。
2. 设置页显示当前后端（钥匙串 / 文件）与迁移结果。
3. Linux 的 `secret-tool` 后端（需要先确认可用性，不存在就继续用 0600 文件）。
