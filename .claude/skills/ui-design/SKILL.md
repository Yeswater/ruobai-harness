---
name: ui-design
description: 改 ruobai-harness 前端界面时使用：设置页、按钮/表单/开关等基础组件、CSS token、布局对齐、滚动条、CC/DeepSeek 皮肤与明暗主题。给出入口与硬规则，细节按需打开 docs/ui-design-system.md。
---

# UI 设计规范（入口）

这不是完整手册，是路由。**先按下面的硬规则动手；需要细节时再打开 `docs/ui-design-system.md` 的对应章节。**

## 0. 30 秒路径

| 要做什么 | 看哪里 |
| --- | --- |
| 改颜色 / 间距 / 圆角 / 字体 | `docs/ui-design-system.md` §1 Token |
| 新增或调整皮肤 | 同文档 §2 皮肤契约；`design-system.css` |
| 写按钮、开关、折叠、空状态 | 同文档 §3；`components/ui/index.tsx` |
| 改设置页布局 | 同文档 §4；`components/settings/` |
| 改保存 / 交互 / 焦点 | 同文档 §5 |
| 提交前检查 | 同文档 §6 检查清单 |

代码位置固定：

- `packages/ui-app/src/design-system.css` — token、皮肤、滚动条、基础组件样式
- `packages/ui-app/src/components/ui/index.tsx` — Button / Field / Switch / Segmented / Disclosure / Notice / EmptyState / useAutosave
- `packages/ui-app/src/components/settings/` — 设置页
- `docs/ui-design-system.md` — 完整规范与理由

## 1. 硬规则

1. **只用 token 和基础组件**。颜色、间距、圆角、字号不写字面量；按钮、开关、折叠不手写第三套。
2. **皮肤只覆盖 CSS 变量**。组件里禁止 `[data-skin=...]` 分支；新增皮肤在 `preferences.ts` 登记并在 `design-system.css` 补明暗两个颜色块。
3. **设置页一个滚动容器**。正文列宽 `--content-max`，分组用 `SettingsGroup`，行用 `SettingRow`；主从页（模型、权限）用 `flush`。
4. **偏好自动保存，实体表单显式保存**。偏好改动即提交（数字防抖），供应商/规则/环境用底部粘性保存栏。
5. **四组组合都要成立**：CC / DeepSeek × 明 / 暗。改完至少各看一眼。

## 2. 最小用法

```tsx
import { Button, Field, Switch, Disclosure, EmptyState, Notice, useAutosave } from '../ui/index.tsx'

<Switch checked={on} label="启用自动检索" onChange={setOn} />
<Button variant="primary" onClick={save}>保存环境</Button>
<EmptyState title="还没有技能草稿">会话空闲后会把可复用的步骤写到这里。</EmptyState>
```

设置页行：

```tsx
<SettingsGroup label="外观">
  <SettingRow title="主题" description="跟随系统，或固定浅色 / 深色。">
    <Segmented value={theme} options={...} onChange={setTheme} label="主题" />
  </SettingRow>
</SettingsGroup>
```

打开细节前先确认：这里是否真的需要新组件？优先复用 `components/ui` 与现有 `Select` / `TokenAmountInput` / `useConfirm`。

## 3. 常见错误

- 在组件里写 `#c96442`、`12px`、`rgba(...)` — 换成 token。
- 给某个容器单独写 `::-webkit-scrollbar` — 全局已经处理，用 `no-scrollbar` 例外。
- 设置页里再套一层 `overflow: auto` — 滚动归 `settings-page-body`。
- 为 DeepSeek 皮肤改组件类名 — 只改变量。
- 空状态写「暂无数据」— 写下一步能做什么。
- 引入新的 UI 依赖 — 先看标准库或现有组件能否解决。

## 4. 验证

```bash
pnpm typecheck
pnpm test
pnpm build:ui
```

界面改动还要在设置页里实际走一遍：切换皮肤与明暗、窄窗口（≤620px）、键盘焦点、Esc 关闭。
