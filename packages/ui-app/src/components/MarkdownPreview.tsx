import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ReactNode } from 'react'
import { highlightCode } from '../file-highlight.ts'
import { MermaidDiagram } from './MermaidDiagram.tsx'

/** 引用稳定：新数组会让 react-markdown 重建 processor，整篇重新解析。 */
const remarkPlugins = [remarkGfm]

export function markdownHeadingId(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

function plainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return plainText((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

/**
 * 组件表必须是模块级常量：react-markdown 把 `components[tag]` 直接当元素类型用，
 * 内联箭头函数每次渲染都是新类型 → 整棵子树卸载重挂 → Mermaid 图重渲染并闪一下。
 */
const markdownComponents: Components = {
  // Block code is fully rendered by the `code` override below.
  pre: ({ children }) => <>{children}</>,
  h1: ({ children }) => <h1 id={markdownHeadingId(plainText(children))}>{children}</h1>,
  h2: ({ children }) => <h2 id={markdownHeadingId(plainText(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={markdownHeadingId(plainText(children))}>{children}</h3>,
  code: ({ className, children }) => {
    const text = String(children ?? '').replace(/\n$/, '')
    const language = /language-([\w+-]+)/.exec(className ?? '')?.[1]?.toLowerCase()
    if (language === 'mermaid') return <MermaidDiagram code={text} />
    if (!language && !text.includes('\n')) {
      return <code className={className}>{children}</code>
    }
    const html = language ? highlightCode(text, language) : undefined
    return (
      <pre className="md-code">
        {html
          ? <code dangerouslySetInnerHTML={{ __html: html }} />
          : <code>{text}</code>}
      </pre>
    )
  },
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

/** Read-only Markdown rendering used by the file preview. */
export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="file-markdown">
      <Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>
        {content}
      </Markdown>
    </div>
  )
}
