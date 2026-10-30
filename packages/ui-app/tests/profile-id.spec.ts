import { describe, expect, it } from 'vitest'
import { uniqueProfileId } from '../src/components/settings/GeneralSettings.tsx'
import type { ProfileSummary } from '../src/api.ts'

const profile = (id: string): ProfileSummary => ({ id, label: id })

describe('environment profile ids', () => {
  it('slugs a latin label', () => {
    expect(uniqueProfileId('Customer A', [])).toBe('customer-a')
  })

  it('keeps CJK characters instead of emptying the id', () => {
    expect(uniqueProfileId('客户 A', [])).toBe('客户-a')
  })

  it('falls back when the label has no usable characters', () => {
    expect(uniqueProfileId('***', [])).toBe('env')
  })

  it('never collides with an existing id', () => {
    expect(uniqueProfileId('客户 A', [profile('客户-a')])).toBe('客户-a-2')
    expect(uniqueProfileId('客户 A', [profile('客户-a'), profile('客户-a-2')])).toBe('客户-a-3')
  })

  it('trims leading and trailing separators', () => {
    expect(uniqueProfileId('  Staging EU  ', [])).toBe('staging-eu')
  })
})
