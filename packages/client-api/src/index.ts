import type { ComponentType, createElement } from 'react'

export interface SlotEntry {
  id: string
  order?: number
  component: ComponentType<any>
}

export interface Slots {
  register(slot: string, entry: SlotEntry): () => void
  list(slot: string): readonly SlotEntry[]
}

/** Runtime handed to client plugins loaded by `client-modules`. */
export interface ClientApi {
  React: typeof import('react')
  h: typeof createElement
  slots: Slots
}

/** Shape of a client plugin module's default export. */
export type ClientPlugin = (api: ClientApi) => void
