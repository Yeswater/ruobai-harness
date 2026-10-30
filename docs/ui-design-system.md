# 前端设计系统与皮肤规范

本文件定义 ui-app 的基础视觉语言：token、皮肤契约、基础组件、设置页布局规则与交互约定。新增页面或皮肤时按这里执行，不要另起一套类名和间距。

**Agent 入口**：`.claude/skills/ui-design/SKILL.md`。Claude Code 与 RuoBai 的 skills 插件都从项目 `.claude/skills` 发现它——先加载简短路由，需要细节时再回到本文件对应章节。

代码位置：

- `packages/ui-app/src/design-system.css` — token、皮肤、滚动条、基础组件样式
- `packages/ui-app/src/components/ui/index.tsx` — Button / Field / Switch / Segmented / Disclosure / Notice / EmptyState / useAutosave
- `packages/ui-app/src/preferences.ts` — 皮肤选择与持久化
- `packages/ui-app/src/components/settings/` — 设置页各面板

## 1. Token

所有间距、圆角、字号走变量，不写字面量。文档中的数值是 CC 皮肤的默认值；DeepSeek 皮肤只改圆角与颜色。

### 间距

| Token | 值 | 用途 |
| --- | --- | --- |
| `--sp-1` | 4px | 图标与文字、紧邻元素 |
| `--sp-2` | 6px | 字段标签与控件 |
| `--sp-3` | 8px | 按钮内距、列表项内距 |
| `--sp-4` | 12px | 卡片内距、表单行间距 |
| `--sp-5` | 16px | 区块内距 |
| `--sp-6` | 20px | 页面纵向节奏 |
| `--sp-7` | 24px | 分组之间 |
| `--sp-8` | 32px | 大区块 |

### 字号

| Token | 值 | 用途 |
| --- | --- | --- |
| `--fs-2xs` | 10.5px | 元信息、路径、徽标 |
| `--fs-xs` | 11.5px | 说明文字、分组标题 |
| `--fs-sm` | 12.5px | 正文、控件、列表主文本 |
| `--fs-md` | 13.5px | 强调正文 |
| `--fs-lg` | 15px | 小节标题 |
| `--fs-xl` | 19px | 页面标题 |

### 圆角与控件

- `--r-xs` 5px / `--r-sm` 7px / `--r-md` 10px / `--r-lg` 12px / `--r-xl` 16px
- `--control-h` 32px，`--control-h-sm` 27px，`--control-h-lg` 36px
- `--dur-1` 120ms / `--dur-2` 180ms，`--ease` 统一缓动
- `--focus-ring` 统一焦点环；不要各写 outline

### 页面节奏

- `--page-pad-x` 28px：页面左右安全区
- `--content-max` 720px：设置页正文最大宽度
- `--row-gap` 28px：行内文案与控件的间距

## 2. 皮肤契约

皮肤挂在 `<html data-skin="...">` 上，主题挂在 `data-theme="light|dark"`。两轴正交：四组组合都必须成立。

皮肤必须覆盖的变量：

```
--bg --panel --sidebar --text --muted --faint
--border --border-strong --hairline
--accent --accent-strong --accent-soft --accent-contrast
--user-bubble --tool-bg --ok --warn --danger --shadow
--r-xs --r-sm --r-md --r-lg --r-xl
```

规则：

1. **组件只读变量，不读品牌名**。禁止 `[data-skin="deepseek"] .button { … }` 这类皮肤分支；皮肤只提供变量。
2. 新皮肤的浅色/深色各写一个块，选择器用 `html[data-skin="<id>"][data-theme="dark"]`，保证优先级高于 `styles.css` 的 `:root`。
3. 加一个皮肤：在 `preferences.ts` 的 `UiSkin` 与 `SKINS` 里登记，在 `design-system.css` 里补两个颜色块。设置页的皮肤选择器会自动出现。
4. 强调色只用于：选中态、主按钮、焦点环、图标高亮。不要用强调色做大面积背景。

当前皮肤：

- `cc`：暖中性色（`#f7f7f5` / `#191918`），强调 `#c96442` / `#d97757`，圆角偏大。
- `deepseek`：冷中性色（`#ffffff` / `#101114`），强调 `#4d6bfe` / `#7b91ff`，圆角偏小、密度更高。

## 3. 基础组件

从 `components/ui` 导入。类名统一 `ui-` 前缀。

| 组件 | 说明 |
| --- | --- |
| `Button` | `variant`: default / primary / ghost / danger，`small` 紧凑尺寸 |
| `IconButton` | 方形图标按钮，必须有 `aria-label` 和 `title` |
| `Field` | label + 控件 + hint/error，纵向排列 |
| `Switch` | `role="switch"`，必须传 `label`；不要再用三套手写开关 |
| `Segmented` | 2–4 个互斥选项；传 `label` 给组 |
| `Disclosure` | 折叠面板；标题 + 计数，展开后正文 |
| `Notice` | neutral / ok / error 行内提示 |
| `EmptyState` | 空状态：一句结论 + 一句下一步 |
| `useAutosave` | 防抖自动保存，返回 state / error / schedule / flush；卸载时冲刷 |

使用约定：

- 一行一个主操作。破坏性操作用 `danger` 且放在最左。
- 控件文案是动作本身（「保存环境」而不是「确定」）。
- 图标按钮必须有可访问名称；纯图标切换用 `aria-pressed`。
- 空状态必须给出下一步，不写「暂无数据」。

## 4. 设置页布局

结构固定为：左侧分类导航 + 右侧页面头 + 单一滚动正文。

```
settings-modal
└─ settings-shell
   ├─ settings-nav           分类、搜索
   └─ settings-content
      ├─ settings-page-head  标题、说明、当前状态、关闭
      └─ settings-page-body  唯一的滚动容器
```

规则：

1. **一个页面只有一个滚动容器**。面板不要再套 `overflow: auto`；主从页（模型、权限）用 `flush`，内部列表和表单各自滚动。
2. 正文列宽由 `--content-max` 控制，左右 padding 用 `max(--page-pad-x, (100% - 720px) / 2)` 自动居中。
3. 分组用 `SettingsGroup`（小标题 + 卡片），行用 `SettingRow`（左文案、右控件）。控件列宽 190px 起，选择器 210px。
4. 行内文案与控件基线对齐；`SettingRow` 是两列 grid，窄屏自动堆叠。
5. 需要整行宽度的控件（皮肤选择、预览）用 `.setting-row.stacked`。
6. 次级信息折叠：模型列表按模型折叠、内置规则折叠、查找位置折叠。默认展开的只能是当前正在编辑的内容。
7. 长页面不要底部固定保存栏；状态用 `ui-status` 行内展示。

### 保存策略

- **偏好项自动保存**（通用、知识库开关、插件开关）：改动即提交，数字输入 450ms 防抖，失败显示行内错误。
- **实体表单显式保存**（供应商、权限规则、环境档案）：表单可能有半填状态，保存按钮放在表单底部粘性栏，旁边显示错误/提示。
- **危险默认值二次确认**：如「完全权限设为默认」，用确认弹窗，确认后才写入。

### 滚动条

全局规则：默认透明，容器 hover 时出现细滚动条；`no-scrollbar` 用于纯装饰性横条。不要再为单个容器写 `::-webkit-scrollbar`。

## 5. 交互与可访问性

- 焦点：所有可交互元素有可见焦点环，用 `--focus-ring`。
- 键盘：Esc 关闭弹窗；弹窗内层下拉先消费 Esc；设置每个页签切换后滚回顶部。
- 动效：只用于状态变化（展开、保存、切换），`prefers-reduced-motion` 下全部近似关闭。
- 文案：说明写「做什么 + 影响范围」，不写实现细节；错误说清发生了什么、怎么修。
- 颜色：正文与背景对比度 ≥ 4.5:1；状态不能只靠颜色，配文字。

## 6. 新增页面检查清单

- [ ] 只使用 token，没有新增颜色/间距字面量
- [ ] 使用 `components/ui` 的基础组件，没有手写开关、按钮、提示
- [ ] 一个滚动容器；主从页用 `flush`
- [ ] 每行文案与控件对齐；窄屏可用
- [ ] 偏好项自动保存；实体表单显式保存并有粘性操作栏
- [ ] 空状态有下一步；错误可恢复
- [ ] 两套皮肤 × 两种主题下都检查过
- [ ] `pnpm typecheck` + `pnpm test` + `pnpm build:ui`
