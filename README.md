# ruobai-harness

> A composable coding-agent harness built on a Cordis plugin tree.
> 一个可组合的 coding agent harness：插件树组装、追加式会话日志、可替换的沙箱与工具。

## 特点

- **没有"核心里的 if"**：`cordis.yml` 是唯一的应用定义，每个能力是一个插件包；删掉一行配置就移除一项能力。
- **会话是只追加的事件日志**：对话、轨迹、上下文占用、token 统计都是投影，原始记录可回放。
- **两道正交的边界**：沙箱（macOS Seatbelt，fail-closed）与审批互不依赖，中间用 denial / escalation 解耦。
- **为长会话设计**：分层上下文压缩（无模型裁剪 → 结构化摘要），并保持 prompt 前缀稳定以复用 KV cache。
- **浏览器只做传输**：服务端插件注册路由与推送通道，客户端通过 Slot 组合面板。

## 快速开始

需要 Node `^22.19` 或 `>=24`，以及 pnpm 11。

```bash
pnpm install
pnpm dev
```

打开 <http://localhost:4310>。没有配置真实模型时会使用离线 mock 提供方；在设置里添加 OpenAI 兼容的提供方与模型即可接入。

提交前自检：

```bash
pnpm typecheck
pnpm test
pnpm build:ui
```

## 目录

| 路径 | 内容 |
| --- | --- |
| `cordis.yml` | 插件组合方式（唯一应用定义） |
| `packages/` | 一个能力一个包（`@ruobai/<name>`） |
| `apps/cli/` | 读配置、建 Context、挂 Loader |
| `vendor/` | vendored 框架（cordis / loader / schemastery / cosmokit ...） |
| `tests/` | 全栈测试 harness |
| `docs/` | 设计文档与博客 |

## 文档

- [`AGENTS.md`](AGENTS.md)：开发规范与禁区，改动前先读。
- [`docs/protocols.md`](docs/protocols.md)：prompt 与消息协议。
- [`docs/compaction.md`](docs/compaction.md)：上下文压缩策略。
- [`docs/secrets.md`](docs/secrets.md)：密钥存储（系统钥匙串 / 0600 文件）与迁移。
- [`docs/todo.md`](docs/todo.md)：会话级任务清单，压缩后仍保留目标。
- [`docs/session-export.md`](docs/session-export.md)：会话导出为 Markdown 或事件 JSONL。
- [`docs/product-roadmap-review.md`](docs/product-roadmap-review.md)：外部产品 Roadmap 的逐条评审与取舍。
- [`docs/prompt-cache.md`](docs/prompt-cache.md)：KV cache 交互设计与实测。
- [`docs/sandbox-macos.md`](docs/sandbox-macos.md)：macOS 沙箱实现与实测附录。
- [`docs/blog/`](docs/blog/)：工程判断与取舍的记录。

## 状态

早期项目（`v0.1.0`），接口会变；版本以 tag 与 release 区分，没有长期维护的分支。

## 许可证

[MIT](LICENSE)。`vendor/` 下的第三方代码各自保留其 MIT 许可证与版权声明。
