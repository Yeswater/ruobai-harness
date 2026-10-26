import type { Diagnostic } from '@ruobai/lint'

/** One compact block: location, rule, cause, and how to fix it. */
export function renderDiagnostics(
  diagnostics: Diagnostic[],
  layer: 'edit' | 'stop',
  round: number,
  limit = 20,
) {
  const shown = diagnostics.slice(0, limit)
  const lines = shown.map((item) => {
    const location = `${item.path}${item.line ? `:${item.line}` : ''}`
    const suggestion = item.suggestion ? `\n  修复：${item.suggestion}` : ''
    return `${location} [${item.rule}] ${item.message}${suggestion}`
  })
  return [
    `<hook-diagnostics layer="${layer}" round="${round}" new="${diagnostics.length}" shown="${shown.length}">`,
    ...lines,
    '</hook-diagnostics>',
  ].join('\n')
}

export function renderInfrastructure(ids: string[]) {
  return [
    '<hook-diagnostics layer="stop" unavailable="true">',
    `检查器不可用：${ids.join(', ')}。修复检查器或暂时关闭该层，然后重试。`,
    '</hook-diagnostics>',
  ].join('\n')
}
