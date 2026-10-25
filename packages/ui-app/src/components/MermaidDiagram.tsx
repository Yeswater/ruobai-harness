import { useEffect, useId, useState } from 'react'

/** Lazily renders a Mermaid diagram and follows the app's light/dark theme. */
export function MermaidDiagram({ code }: { code: string }) {
  const reactId = useId()
  const id = `mmd-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light')

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme ?? 'light')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
          fontFamily: 'inherit',
        })
        await mermaid.parse(code)
        const rendered = await mermaid.render(id, code)
        if (!cancelled) setSvg(rendered.svg)
      } catch (caught) {
        if (cancelled) return
        setSvg(null)
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, theme, id])

  if (error) {
    return (
      <div className="mermaid-block error">
        <div className="mermaid-error">图表渲染失败：{error}</div>
        <pre className="md-code"><code>{code}</code></pre>
      </div>
    )
  }
  return svg
    ? <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />
    : <div className="mermaid-block"><span className="mermaid-loading">渲染图表…</span></div>
}
