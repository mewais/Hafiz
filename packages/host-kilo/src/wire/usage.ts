// Token usage read off model responses as they pass the embedded proxy, for cost instrumentation
// (§7). Nothing is buffered beyond one partial SSE line (or, for a non-streamed JSON body, the
// body itself up to a cap): the bytes reach Kilo untouched and in order; this only looks.
import { StringDecoder } from 'node:string_decoder'

export type UsageFormat = 'openai-chat' | 'anthropic-messages'

/** Uncached input, output, and cache traffic, whatever the vendor calls them. */
export interface WireUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type Json = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' ? (v as Json) : undefined)

/** OpenAI `usage`: prompt_tokens includes cached ones, so cached are split out of `input`. */
export function fromOpenAi(u: unknown): Partial<WireUsage> | undefined {
  const x = obj(u)
  if (!x) return undefined
  const prompt = num(x.prompt_tokens)
  const cached = num(obj(x.prompt_tokens_details)?.cached_tokens) ?? 0
  const out: Partial<WireUsage> = { cacheRead: cached }
  if (prompt !== undefined) out.input = Math.max(0, prompt - cached)
  const completion = num(x.completion_tokens)
  if (completion !== undefined) out.output = completion
  return prompt === undefined && completion === undefined ? undefined : out
}

/** Anthropic `usage`: input_tokens excludes cache reads and writes. */
export function fromAnthropic(u: unknown): Partial<WireUsage> | undefined {
  const x = obj(u)
  if (!x) return undefined
  const out: Partial<WireUsage> = {}
  const set = (k: keyof WireUsage, v: unknown) => {
    const n = num(v)
    if (n !== undefined) out[k] = n
  }
  set('input', x.input_tokens)
  set('output', x.output_tokens)
  set('cacheRead', x.cache_read_input_tokens)
  set('cacheWrite', x.cache_creation_input_tokens)
  return Object.keys(out).length ? out : undefined
}

const MAX_JSON_BYTES = 8 * 1024 * 1024

export class UsageTap {
  private readonly sse: boolean
  private readonly decoder = new StringDecoder('utf8')
  private line = ''
  private json: Buffer[] = []
  private jsonBytes = 0
  private usage: Partial<WireUsage> | undefined

  constructor(
    private readonly format: UsageFormat,
    contentType: string | undefined,
  ) {
    this.sse = /text\/event-stream/i.test(contentType ?? '')
  }

  push(chunk: Buffer): void {
    if (!this.sse) {
      if (this.jsonBytes <= MAX_JSON_BYTES) {
        this.json.push(chunk)
        this.jsonBytes += chunk.length
      }
      return
    }
    this.line += this.decoder.write(chunk)
    let i = this.line.indexOf('\n')
    while (i >= 0) {
      this.onLine(this.line.slice(0, i))
      this.line = this.line.slice(i + 1)
      i = this.line.indexOf('\n')
    }
    // a pathological endless line without a newline must not grow without bound
    if (this.line.length > MAX_JSON_BYTES) this.line = ''
  }

  private merge(u: Partial<WireUsage> | undefined) {
    if (u) this.usage = { ...this.usage, ...u }
  }

  private onLine(raw: string) {
    const line = raw.trim()
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data.includes('usage')) return
    try {
      const ev = JSON.parse(data) as Json
      if (this.format === 'openai-chat') this.merge(fromOpenAi(ev.usage))
      else {
        // message_start carries input and cache figures, message_delta the final output count
        this.merge(fromAnthropic(obj(ev.message)?.usage))
        this.merge(fromAnthropic(ev.usage))
      }
    } catch {}
  }

  /** The usage seen, or undefined when the response carried none. Call once, at end of body. */
  result(): WireUsage | undefined {
    if (this.sse) {
      this.line += this.decoder.end()
      if (this.line) this.onLine(this.line)
      this.line = ''
    } else if (this.jsonBytes <= MAX_JSON_BYTES && this.json.length) {
      try {
        const body = JSON.parse(Buffer.concat(this.json).toString('utf8')) as Json
        this.merge(
          this.format === 'openai-chat' ? fromOpenAi(body.usage) : fromAnthropic(body.usage),
        )
      } catch {}
      this.json = []
    }
    const u = this.usage
    if (!u) return undefined
    return {
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
    }
  }
}
