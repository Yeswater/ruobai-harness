import { fingerprintOf, normalizePath } from './fingerprint.ts'
import type { Diagnostic, DiagnosticLevel } from './types.ts'

/** Pull one stream out of the shell executor's rendered content. */
export function sectionOf(content: string, name: 'stdout' | 'stderr') {
  const marker = `--- ${name} ---\n`
  const start = content.indexOf(marker)
  if (start < 0) return ''
  const rest = content.slice(start + marker.length)
  const next = rest.search(/\n--- (stdout|stderr) ---\n/)
  return (next < 0 ? rest : rest.slice(0, next)).trimEnd()
}

function positionOf(source: string, offset: number) {
  const clamped = Math.max(0, Math.min(offset, source.length))
  const before = source.slice(0, clamped)
  return {
    line: before.split('\n').length,
    column: clamped - before.lastIndexOf('\n'),
  }
}

function levelOf(value: unknown): DiagnosticLevel {
  return value === 'error' ? 'error' : 'warn'
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.content === 'string') return record.content
    if (Array.isArray(record.elements))
      return record.elements.map(textOf).filter(Boolean).join(' ')
  }
  return ''
}

interface BiomeLocation {
  path?: string | { file?: string }
  start?: { line?: number; column?: number }
  span?: number[]
  sourceCode?: string
}

interface BiomeDiagnostic {
  category?: string
  rule?: string
  severity?: string
  message?: unknown
  description?: unknown
  location?: BiomeLocation
}

/**
 * Biome's `--reporter=json` output. The shape has changed across majors, so
 * every field is read defensively; a parse failure yields no diagnostics
 * rather than failing the gate. 2.x reports `location.start`; older builds
 * reported a byte span plus the source.
 */
export function parseBiome(json: string, root: string): Diagnostic[] {
  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    return []
  }
  const diagnostics = (payload as { diagnostics?: unknown })?.diagnostics
  if (!Array.isArray(diagnostics)) return []

  const result: Diagnostic[] = []
  for (const raw of diagnostics) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as BiomeDiagnostic
    const location = item.location ?? {}
    const pathValue = location.path
    const file = typeof pathValue === 'string' ? pathValue : pathValue?.file
    if (typeof file !== 'string' || !file) continue

    let position: { line: number; column?: number } | undefined
    if (location.start && typeof location.start.line === 'number') {
      position = {
        line: location.start.line,
        ...(typeof location.start.column === 'number'
          ? { column: location.start.column }
          : {}),
      }
    } else if (location.sourceCode && Array.isArray(location.span)) {
      const offset = Number(location.span[0])
      if (Number.isFinite(offset)) {
        position = positionOf(location.sourceCode, offset)
      }
    }

    const rule = String(item.category ?? item.rule ?? 'biome')
    const message = textOf(item.description) || textOf(item.message) || rule
    const path = normalizePath(file, root)
    result.push({
      path,
      ...(position ? { line: position.line, column: position.column } : {}),
      rule,
      level: levelOf(item.severity),
      message,
      fingerprint: fingerprintOf(rule, path, message),
    })
  }
  return result
}

/** `tsc --pretty false`: `src/a.ts(12,5): error TS2322: ...`. */
export function parseTsc(text: string, root: string): Diagnostic[] {
  const result: Diagnostic[] = []
  for (const line of text.split('\n')) {
    const match = /^(.*?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(
      line.trim(),
    )
    if (!match) continue
    const path = normalizePath(match[1]!, root)
    const rule = match[5]!
    const message = match[6]!.trim()
    result.push({
      path,
      line: Number(match[2]),
      column: Number(match[3]),
      rule,
      level: levelOf(match[4]),
      message,
      fingerprint: fingerprintOf(rule, path, message),
    })
  }
  return result
}

/** Last resort: one diagnostic per non-empty line of output. */
export function parsePlain(
  text: string,
  root: string,
  id: string,
): Diagnostic[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((message) => {
      const path = normalizePath('.', root)
      return {
        path,
        rule: id,
        level: 'error' as const,
        message,
        fingerprint: fingerprintOf(id, path, message),
      }
    })
}
