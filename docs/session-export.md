# 会话导出

## 需求与边界

把一段会话带出 harness：贴进 issue、归档、给外部工具回放。两件事分开做：

| 形式 | 面向 | 来源 |
| --- | --- | --- |
| Markdown | 人读 | `ctx.chat` 投影（浏览器看到的同一份折叠结果） |
| JSONL | 机器回放 | `ctx.sessions` 原始事件日志 |

只读：不调用模型、不改变会话、不影响轨迹。

## 接口

```
GET /api/export/session/:id.md           # 也可以 ?format=md
GET /api/export/session/:id?format=jsonl # 也可以 :id.jsonl
```

- `Content-Disposition` 同时给 ASCII 兜底名与 RFC 5987 的 `filename*`，中文标题不会变成乱码。
- 未知会话 404；不支持的格式 400；非 GET 405。
- 文件名会去掉路径分隔符与控制字符，最多 60 字符。

## Markdown 结构

````markdown
# <标题>

- 会话 ID：`…`
- 模型：provider/model
- 模式：agent
- 工作区：`…`
- 导出时间：ISO

## 用户
正文
> 附件：name（mime，字节数）

## 助手
正文
<details><summary>思考</summary>…</details>
<details><summary>工具 read_file</summary>

```json
{…}
```

```text
输出（最多 4000 字符）
```

</details>
````

设计取舍：

- **用 chat 投影而不是重新折叠事件**：浏览器的 transcript 已经是一份经过设计的分层折叠结果，导出跟它保持一致，避免出现“界面和导出不一样”。
- **工具输出折叠**：交互记录里最占篇幅的是工具输出；`<details>` 保留内容但不打断阅读。
- 截断标记带原始字符数，避免误以为输出只有这么长。
- 思考内容保留但默认折叠：它是过程记录的一部分，不是结论。

## 失败模式

| 情况 | 行为 |
| --- | --- |
| `session-export` 未挂载 | 接口 404；命令面板的“导出当前会话”只在有消息时出现，点了会打开错误页 |
| 会话正在运行 | 导出当前已落日志的部分；进行中的块按已收到的内容输出 |
| 图片附件 | 只导出元信息，不内嵌 base64（Markdown 会膨胀数倍，且可能含敏感画面） |
| 工具输出极大 | 每块截断到 4000 字符 |

## 验证

`packages/session-export/tests/export.spec.ts`：

- Markdown 含标题、用户正文、思考折叠、工具调用与输出、会话 id；
- JSONL 行数与事件顺序正确，`message/user` 内容可解析；
- 未知会话 404、未知格式 400、POST 405。

## 后续

- 导出为单文件 HTML（内联样式）。
- 子代理会话并入父会话的选项。
