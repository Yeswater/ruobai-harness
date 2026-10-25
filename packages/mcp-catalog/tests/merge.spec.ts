import { describe, expect, it } from 'vitest'
import type { McpFileServer } from '@ruobai/mcp-config'
import { mergeServers, type SettingsMcpServer } from '../src/index.ts'

describe('mcp catalog merge', () => {
  it('lets file servers win and masks settings with disabled file entries', () => {
    const files: McpFileServer[] = [
      { id: 'a', command: 'file-a', source: 'file', filePath: '/w/.mcp.json' },
      { id: 'b', command: 'file-b', source: 'file', filePath: '/w/.mcp.json', disabled: true },
    ]
    const settings: SettingsMcpServer[] = [
      { id: 'a', command: 'settings-a' },
      { id: 'b', command: 'settings-b' },
      { id: 'c', command: 'settings-c' },
      { id: 'd', command: 'settings-d', disabled: true },
    ]

    const merged = mergeServers(files, settings)
    expect(merged.map(server => [server.id, server.command])).toEqual([
      ['a', 'file-a'],
      ['c', 'settings-c'],
    ])
    expect(merged.every(server => !('source' in server))).toBe(true)
  })

  it('keeps file order before settings', () => {
    const files: McpFileServer[] = [
      { id: 'z', command: 'z', source: 'file', filePath: '/w/.mcp.json' },
    ]
    const settings: SettingsMcpServer[] = [{ id: 'a', command: 'a' }]
    expect(mergeServers(files, settings).map(server => server.id)).toEqual(['z', 'a'])
  })
})
