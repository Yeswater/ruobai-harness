import { useEffect, useId, useRef, useState } from 'react'
import { mermaidRenderId, serializeMermaidRender } from '../mermaid-render.ts'

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/**
 * 渲染 Mermaid 图。
 *
 * 两个坑都在这里处理：
 * - `mermaid.render` 不传容器时会先往 `document.body` 尾部插一个**可见**的临时 div，
 *   图表在页面底部闪现一次（就是肉眼看到的"闪动"）。所以永远渲染到离屏 stage 里。
 * - 渲染期间保留上一张图，等新图序列化好再一次性替换，避免高度在 loading 和 SVG 之间反复跳。
 */
export function MermaidDiagram({ code }: { code: string }) {
  const baseId = mermaidRenderId(useId())
  const renderSeq = useRef(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState(currentTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let cancelled = false
    // 每轮渲染一个全新 id：已展示的旧图还在 DOM 里，同 id 会让 mermaid 内部的
    // document 级选择器操作到旧 svg 上。
    const id = `${baseId}-${++renderSeq.current}`
    setError(null)
    void serializeMermaidRender(async () => {
      if (cancelled) return
      const mermaid = (await import('mermaid')).default
      if (cancelled) return
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        fontFamily: 'inherit',
      })
      // 先 parse：语法错误直接走错误分支，而不是拿到半张图。
      await mermaid.parse(code)
      const rendered = await mermaid.render(id, code, stage)
      if (!cancelled) setSvg(rendered.svg)
    })
      .catch(caught => {
        if (cancelled) return
        setSvg(null)
        setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        // mermaid 会把临时 div 留在容器里；清掉，免得下一次渲染撞 id。
        // 已取消的轮次不清：接手的那一轮开始时自己会清，否则会误清掉新图。
        if (!cancelled) stage.replaceChildren()
      })
    return () => {
      cancelled = true
    }
  }, [code, theme, baseId])

  return (
    <div className="mermaid-host">
      {/* 离屏渲染台：mermaid 需要真实挂载的文字尺寸，但不能让它出现在页面里。 */}
      <div className="mermaid-stage" ref={stageRef} aria-hidden="true" />
      {error
        ? (
          <div className="mermaid-block error" key="error">
            <div className="mermaid-error">图表渲染失败：{error}</div>
            <pre className="md-code"><code>{code}</code></pre>
          </div>
        )
        : svg
        ? <div className="mermaid-block" key="figure" dangerouslySetInnerHTML={{ __html: svg }} />
        : <div className="mermaid-block" key="loading"><span className="mermaid-loading">渲染图表…</span></div>}
    </div>
  )
}
