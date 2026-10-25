import yaml from 'js-yaml'

export interface SkillFrontmatter {
  name?: string
  description?: string
  disableModelInvocation: boolean
  userInvocable: boolean
}

export interface SkillDocument {
  meta: SkillFrontmatter
  body: string
}

/** Splits `---` frontmatter from a SKILL.md body without trusting its YAML. */
export function parseSkillDocument(raw: string): SkillDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^﻿/, ''))
  if (!match) {
    return { meta: { disableModelInvocation: false, userInvocable: true }, body: raw.trim() }
  }
  let data: unknown
  try {
    data = yaml.load(match[1]!)
  } catch {
    data = undefined
  }
  const front = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
  const rawName = front.name
  const rawDescription = front.description ?? front['when-to-use']
  return {
    meta: {
      name: typeof rawName === 'string' ? rawName.trim() : undefined,
      description: typeof rawDescription === 'string' ? rawDescription.trim() : undefined,
      disableModelInvocation: front['disable-model-invocation'] === true,
      userInvocable: front['user-invocable'] !== false,
    },
    body: (match[2] ?? '').trim(),
  }
}

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
