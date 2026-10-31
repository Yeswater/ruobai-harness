import { useState } from 'react'

type TokenUnit = 'K' | 'M'

// Token counts are decimal, not binary: 1M means 1,000,000 exactly, which is
// what vendors publish and what the context meter compares against.
const FACTORS: Record<TokenUnit, number> = { K: 1_000, M: 1_000_000 }

interface TokenAmountInputProps {
  value?: number
  onChange: (value?: number) => void
  ariaLabel?: string
}

/** Token count with a K/M unit selector; the parent stores the token value. */
export function TokenAmountInput({ value, onChange, ariaLabel }: TokenAmountInputProps) {
  const [unit, setUnit] = useState<TokenUnit>(() => value && value >= FACTORS.M ? 'M' : 'K')
  const factor = FACTORS[unit]
  const display = value === undefined ? '' : Number((value / factor).toFixed(3))

  return (
    <div className="token-amount">
      <input
        type="number"
        min={0}
        step="any"
        value={display}
        placeholder={unit === 'M' ? '例如 1' : '例如 128'}
        aria-label={ariaLabel}
        onChange={(event) => {
          const next = Number(event.target.value)
          onChange(event.target.value && Number.isFinite(next) && next > 0
            ? Math.round(next * factor)
            : undefined)
        }}
      />
      <select
        value={unit}
        aria-label="单位"
        onChange={event => setUnit(event.target.value as TokenUnit)}
      >
        <option value="K">K</option>
        <option value="M">M</option>
      </select>
    </div>
  )
}
