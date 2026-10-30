import type { EventVisibility, SessionEvent } from './types.ts'

/**
 * Default visibility per event type.
 *
 * The default is `internal`, not `client`: a plugin that forgets to declare
 * visibility makes an export poorer, never leakier. Only plugin code may set
 * the field — tools cannot, or the model could polish its own audit trail.
 */
const RULES: Array<[RegExp, EventVisibility]> = [
  [/^message\/(user|assistant)$/, 'client'],
  [/^tool\/(call|result)$/, 'internal'],
  [
    /^(file\/(change|revert)|hooks|sandbox|approval|plan|todo|contract|delivery|projection|gate)(\/|$)/,
    'internal',
  ],
  [/^(settings|secrets|mcp\/config)(\/|$)/, 'secret'],
]

export function inferVisibility(type: string): EventVisibility {
  for (const [pattern, visibility] of RULES) {
    if (pattern.test(type)) return visibility
  }
  return 'internal'
}

/** Whether an event may leave the harness for the given scope. */
export function visibleTo(event: SessionEvent, scope: 'client' | 'internal'): boolean {
  if (scope === 'internal') return true
  return (event.visibility ?? inferVisibility(event.type)) === 'client'
}
