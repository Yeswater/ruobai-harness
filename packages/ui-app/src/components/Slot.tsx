import { useSyncExternalStore } from 'react'
import { slots } from '../slots.ts'

/** Renders every component registered into one slot, in order. */
export function Slot({ name, props }: { name: string; props?: Record<string, unknown> }) {
  const entries = useSyncExternalStore(slots.subscribe, () => slots.list(name))
  return (
    <>
      {entries.map((entry) => {
        const Component = entry.component
        return <Component key={entry.id} {...props} />
      })}
    </>
  )
}
