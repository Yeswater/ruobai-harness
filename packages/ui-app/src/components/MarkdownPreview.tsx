import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightCode } from '../file-highlight.ts'
import { MermaidDiagram } from './MermaidDiagram.tsx'

/** Read-only Markdown rendering used by the file preview. */
export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="file-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Block code is fully rendered by the `code` override below.
          pre: ({ children }) => <>{children}</>,
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
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}
