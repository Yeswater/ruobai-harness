import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonl: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python',
  java: 'java',
}

export function languageOf(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return BY_EXTENSION[extension]
}

const FENCE_ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', typescript: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', javascript: 'javascript',
  json: 'json', jsonl: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', shell: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', python: 'python',
  java: 'java',
}

/** Highlight one fenced block; `undefined` for unsupported or unknown fences. */
export function highlightCode(code: string, language?: string): string | undefined {
  const name = language ? FENCE_ALIASES[language.toLowerCase()] ?? language.toLowerCase() : undefined
  if (!name || !hljs.getLanguage(name)) return undefined
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  } catch {
    return undefined
  }
}

/**
 * Re-open the `<span>`s that cross a line break so each line can be rendered
 * on its own (line numbers stay aligned, wrapping still works).
 */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  for (const line of html.split('\n')) {
    const prefix = open.join('')
    const tags = /<span[^>]*>|<\/span>/g
    for (const match of line.matchAll(tags)) {
      if (match[0] === '</span>') open.pop()
      else open.push(match[0])
    }
    lines.push(prefix + line + '</span>'.repeat(open.length))
  }
  return lines
}

/** Highlighted HTML per line, or `null` when the file type is not supported. */
export function highlightLines(code: string, path: string): string[] | null {
  const language = languageOf(path)
  if (!language) return null
  try {
    const html = hljs.highlight(code, { language, ignoreIllegals: true }).value
    return splitHighlighted(html)
  } catch {
    return null
  }
}
