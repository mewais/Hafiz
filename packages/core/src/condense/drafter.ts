// Drafters (§7, opt-in, default off): cheap-model drafts for the two things agents skimp on. A
// draft is only ever returned as data; the caller turns it into a proposal or a pre-filled hint.
import type { LLMProvider, LLMUsage } from '../llm/types.js'
import { extractJson } from './condenser.js'

export interface Draft<T> {
  value: T
  usage?: LLMUsage | undefined
}

const GIST_SYSTEM = `You write the one-paragraph "gist" that is stored when a discussion thread is parked: what was being discussed and where it stands, so someone resuming later needs nothing else. Use only what the entries say. Plain text, at most {cap} tokens, no preamble. If the entries do not support a gist, reply with exactly: NONE`

const DIGEST_SYSTEM = `You draft the digest of a finished unit of work from its progress log, for the record. Use only what the log says; do not invent file names or outcomes. Reply with one JSON object and nothing else:
{"outcome": "<what was achieved, 1-3 sentences>", "interface_delta": ["<change to what other blocks depend on>"] or ["none"], "pointers": [{"label": "<short>", "ref": "<file path, commit or PR from the log>"}], "lessons": ["<optional>"]}`

export class Drafters {
  constructor(private readonly provider: LLMProvider) {}

  async gist(
    thread: { title: string; entries: Array<{ text: string }> },
    capTokens: number,
  ): Promise<Draft<string> | null> {
    const entries = thread.entries.map((e, i) => `${i + 1}. ${e.text}`).join('\n')
    const r = await this.provider.complete({
      system: GIST_SYSTEM.replace('{cap}', String(capTokens)),
      prompt: `Thread: ${thread.title}\n\nEntries:\n${entries || '(none)'}`,
      maxTokens: capTokens * 2 + 100,
    })
    const text = r.text.trim()
    if (!text || text === 'NONE') return null
    return { value: text, usage: r.usage }
  }

  async digest(
    block: { id: string; title: string },
    progress: Array<{ kind: string; text: string; refs: string[] }>,
  ): Promise<Draft<Record<string, unknown>> | null> {
    const log = progress
      .map((p) => `- [${p.kind}] ${p.text}${p.refs.length ? ` (${p.refs.join(', ')})` : ''}`)
      .join('\n')
    const r = await this.provider.complete({
      system: DIGEST_SYSTEM,
      prompt: `Block: ${block.title} [${block.id}]\n\nProgress log:\n${log || '(empty)'}`,
      maxTokens: 700,
      json: true,
    })
    const json = extractJson(r.text)
    if (!json) return null
    try {
      const o = JSON.parse(json) as Record<string, unknown>
      return typeof o.outcome === 'string' && o.outcome.trim() ? { value: o, usage: r.usage } : null
    } catch {
      return null
    }
  }
}
