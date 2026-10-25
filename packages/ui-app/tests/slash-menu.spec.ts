import { describe, expect, it } from 'vitest'
import { filterSlashCommands } from '../src/components/SlashMenu.tsx'
import type { SkillSummary } from '../src/api.ts'

const skill: SkillSummary = {
  name: 'review',
  description: 'Review a change',
  source: 'project',
  root: '.ruobai/skills',
  path: '.ruobai/skills/review/SKILL.md',
  bundle: true,
  userInvocable: true,
  modelInvocable: true,
}

describe('slash commands', () => {
  it('offers manual compaction next to the core commands', () => {
    const compact = filterSlashCommands('comp', [])
    expect(compact.map(item => item.id)).toEqual(['compact'])
  })

  it('keeps skills after the static commands', () => {
    const all = filterSlashCommands('', [skill])
    expect(all.some(item => item.id === 'compact')).toBe(true)
    expect(all.at(-1)).toMatchObject({ id: 'skill:review', skill: true })
  })
})
