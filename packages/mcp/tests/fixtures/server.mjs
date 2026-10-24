// Minimal MCP server used by the tests. Speaks newline-delimited JSON-RPC.
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the given text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Pretend to write a note',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'fail',
    description: 'Always returns an error result',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Never answers',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_tool',
    description: 'Adds a tool and announces it',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'extra',
    description: 'Only present after add_tool',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    hidden: true,
  },
  {
    name: 'crash',
    description: 'Exits the server',
    inputSchema: { type: 'object', properties: {} },
  },
]

let extra = false

function toolList() {
  return TOOLS.filter(tool => !tool.hidden || (tool.name === 'extra' && extra))
    .map(({ hidden, ...tool }) => tool)
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      },
    })
    return
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: toolList() } })
    return
  }

  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo:${args.text}` }] } })
    } else if (name === 'add') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] } })
    } else if (name === 'write_note') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `wrote:${args.text}` }] } })
    } else if (name === 'fail') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } })
    } else if (name === 'slow') {
      // Intentionally never responds; the client timeout must fire.
    } else if (name === 'add_tool') {
      extra = true
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'added' }] } })
    } else if (name === 'crash') {
      process.exit(1)
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${name}` } })
    }
    return
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not supported: ${method}` } })
  }
})

// Ignore the initialized notification and anything else.
lines.on('close', () => process.exit(0))
