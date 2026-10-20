import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it } from 'vitest'
import { readLock } from '../src/index.js'
import { makeProject } from './helpers.js'

// End to end through the built CLI: `hafiz mcp --role worker` over stdio, daemon spawned on demand.
it('hafiz mcp serves a role over stdio and starts the daemon', async () => {
  const bin = join(import.meta.dirname, '../../cli/dist/bin.js')
  if (!existsSync(bin)) return // run `pnpm build` first
  const p = await makeProject()
  const env = { ...p.env, HAFIZ_SESSION_ID: 'stdio-w', HAFIZ_AGENT: 'tester' } as Record<
    string,
    string
  >
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp', '--role', 'worker', '--project', p.repo],
    env,
    cwd: p.repo,
  })
  const client = new Client({ name: 't', version: '0' })
  try {
    await client.connect(transport)
    const tools = (await client.listTools()).tools.map((t) => t.name)
    expect(tools).toContain('hafiz_block_request_done')
    expect(tools).not.toContain('hafiz_block_set_status')
    const r = (await client.callTool({ name: 'hafiz_context_for', arguments: {} })) as {
      content: Array<{ text: string }>
    }
    expect(r.content[0]?.text).toContain('Shop')
  } finally {
    await client.close()
    const lock = readLock(p.storeDir)
    if (lock) process.kill(lock.pid, 'SIGTERM')
    for (let i = 0; i < 50 && readLock(p.storeDir); i++)
      await new Promise((r) => setTimeout(r, 100))
  }
}, 30000)
