import { readFile } from 'node:fs/promises'
import type { Diagnostic, DiagnosticLevel, Partition } from './types.ts'

export interface BaselineEntry {
  fingerprint: string
  rule: string
  path: string
  message: string
  level: DiagnosticLevel
}

export interface Baseline {
  version: 1
  entries: BaselineEntry[]
}

export const BASELINE_VERSION = 1

export function baselineOf(diagnostics: Diagnostic[]): Baseline {
  return {
    version: BASELINE_VERSION,
    entries: diagnostics.map((item) => ({
      fingerprint: item.fingerprint,
      rule: item.rule,
      path: item.path,
      message: item.message,
      level: item.level,
    })),
  }
}

/** A missing or unreadable baseline is not an error: everything is new. */
export async function loadBaseline(
  path: string,
): Promise<Baseline | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Baseline
    if (parsed?.version !== BASELINE_VERSION || !Array.isArray(parsed.entries))
      return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Split into new / worsened / known. Only new errors and warnings promoted to
 * errors block; known debt stays visible but never fails the gate.
 */
export function partitionDiagnostics(
  diagnostics: Diagnostic[],
  baseline: Baseline | undefined,
): Partition {
  const known = new Map<string, DiagnosticLevel>()
  for (const entry of baseline?.entries ?? [])
    known.set(entry.fingerprint, entry.level)

  const partition: Partition = {
    fresh: [],
    worsened: [],
    known: [],
    blocking: [],
  }
  for (const item of diagnostics) {
    const previous = known.get(item.fingerprint)
    if (previous === undefined) {
      partition.fresh.push(item)
      if (item.level === 'error') partition.blocking.push(item)
    } else if (previous === 'warn' && item.level === 'error') {
      partition.worsened.push(item)
      partition.blocking.push(item)
    } else {
      partition.known.push(item)
    }
  }
  return partition
}
