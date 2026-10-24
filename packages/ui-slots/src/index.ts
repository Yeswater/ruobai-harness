export interface SlotEntry<C = unknown> {
  /** Unique within its slot; re-registering the same id throws. */
  id: string
  /** Lower numbers render first. Defaults to 100. */
  order?: number
  component: C
}

export interface SlotRegistry<C = unknown> {
  register(slot: string, entry: SlotEntry<C>): () => void
  list(slot: string): readonly SlotEntry<C>[]
  subscribe(listener: () => void): () => void
}

const EMPTY: readonly SlotEntry[] = Object.freeze([])

/**
 * Framework-agnostic slot registry.
 *
 * `list()` returns a stable array until the slot changes, so React's
 * `useSyncExternalStore` can compare snapshots by reference.
 */
export function createSlots<C = unknown>(): SlotRegistry<C> {
  const empty = EMPTY as readonly SlotEntry<C>[]
  const slots = new Map<string, readonly SlotEntry<C>[]>()
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  return {
    register(slot, entry) {
      const current = slots.get(slot) ?? empty
      if (current.some(item => item.id === entry.id)) {
        throw new Error(`slot "${slot}" already has an entry "${entry.id}"`)
      }
      const next = [...current, entry].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      slots.set(slot, next)
      emit()

      return () => {
        const existing = slots.get(slot)
        if (!existing) return
        const filtered = existing.filter(item => item !== entry)
        slots.set(slot, filtered)
        emit()
      }
    },

    list(slot) {
      return slots.get(slot) ?? empty
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
