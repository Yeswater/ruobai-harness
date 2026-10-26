# Markdown 预览里的 Mermaid 渲染

文件预览（`packages/ui-app/src/components/MarkdownPreview.tsx`）把 ```` ```mermaid ```` 代码块交给
`MermaidDiagram` 渲染。图表曾经在每次出现时"闪一下"——页面底部冒出一张图又被抹掉，同时
已渲染的图会莫名重绘。这份笔记记录根因与现在的做法。

## 根因

三条独立的坑，任何一条都会表现为闪动。

1. **`mermaid.render(id, code)` 不传容器时会往 `document.body` 插可见节点。**
   `mermaid` 12 的 `renderDiagram`（`dist/mermaid.core.mjs`）里，`svgContainingElement` 为
   `undefined` 时走 `root = select('body')` + `appendDivSvgG(root, id, 'd' + id)`，这个临时
   `<div>` 没有任何隐藏样式，`width: 100%` 的 SVG 在 body 尾部边画边撑开，序列化完成才
   `removeTempElements()`。于是每次渲染都能在页面底部看到一次完整图表，并伴随滚动条跳动。

2. **`components` 表每次渲染新建就是一次卸载重挂。**
   `react-markdown` 把 `components[tag]` 直接当元素类型用；写成内联箭头函数时，父组件
   （`FileBrowser` 随 SSE / 选中态重渲染）每刷新一次，元素类型就变一次，React 卸载整棵
   子树再挂一棵新的 → `MermaidDiagram` 的 `state` 归零 → 回到"渲染图表…" → 再渲染一次。
   父组件刷新几次就闪几次。`remarkPlugins={[remarkGfm]}` 同理会触发整篇 Markdown 重新解析。

3. **Mermaid 的 config / theme 是模块级全局状态。**
   多张图并发渲染时 `initialize()` 会互相覆盖（字号、主题、class 定义串味）；同一 id 重渲染
   时，已展示的旧 `<svg>` 还在文档里，mermaid 内部按 id 做的选择器会操作到旧节点上。

## 现在的做法

- 组件内固定一个**离屏 stage**（`.mermaid-stage`：`position: absolute; left: -100000px;
  width: 1000px`），渲染永远传第三个参数 `mermaid.render(id, code, stage)`，所以临时 div 只
  存在于视口之外。不能用 `display: none` / `visibility: hidden` 的极端形式：mermaid 依赖真实
  布局量文字宽度，`getBBox` 拿不到尺寸会让标签换行和节点宽度算错。
- `serializeMermaidRender`（`src/mermaid-render.ts`）：全局串行队列，前一张图结束（含失败）
  才开始下一张，保证 `initialize()` 不被打断。
- 每轮渲染用 `baseId + 自增序号` 的**全新 id**，与页面上已展示的旧 svg 不撞。
- 渲染期间保留上一张图，成功后才替换；`markdownComponents` / `remarkPlugins` 提升为模块级
  常量，父组件重渲染不再导致重挂。

首次出现时仍会有一次高度跳变（"渲染图表…"占位 → 实际图表），这是占位问题，和闪动不同，
暂时保留。

## 验证

- `packages/ui-app/tests/mermaid-render.spec.ts`：id 净化（React 18 的 `:r0:` / 19 的 `«r0»`）、
  队列串行且失败不断链。
- `pnpm typecheck`、`pnpm test packages/ui-app/tests`、`pnpm build:ui`。
- 真实浏览器验证需要跑起 harness 打开一份带 mermaid 的 md：本机沙箱禁止执行外部浏览器
  二进制与监听端口，这项只能人工确认（预期：页面底部不再出现临时图表，滚动条不跳）。
