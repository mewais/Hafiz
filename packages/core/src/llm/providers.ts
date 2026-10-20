import {
  LLMError,
  type LLMProvider,
  type LLMRelay,
  type LLMRequest,
  type LLMResult,
  type LLMSettings,
} from './types.js'

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface ProviderEnv {
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
  /** Carries relayed providers (`kilo`) to the process that can run them. */
  relay?: LLMRelay
}

/** Providers that run in a host process, not in the daemon: requests go through an LLMRelay. */
export const RELAYED_PROVIDERS = ['kilo'] as const

/**
 * provider `kilo`: the model runs inside Kilo, through the Kilo plugin (a hidden agent in a child
 * session of the condensed session), so Kilo bills it to that session's family. `model` is a Kilo
 * `provider/model`. The daemon has no Kilo client of its own; the plugin registers as the relay.
 */
export class RelayedProvider implements LLMProvider {
  constructor(
    readonly name: string,
    private readonly s: LLMSettings,
    private readonly relay?: LLMRelay,
  ) {}
  get model(): string {
    return this.s.model
  }
  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResult> {
    if (!this.relay)
      throw new LLMError(`llm provider '${this.name}' runs only inside its host's plugin`)
    return this.relay.complete(this.name, this.s, req, signal)
  }
}

/** The same provider with fixed request metadata (session, purpose) added to every call. */
export function withRequestMeta(
  p: LLMProvider,
  meta: Pick<LLMRequest, 'sessionId' | 'purpose'>,
): LLMProvider {
  return {
    name: p.name,
    model: p.model,
    complete: (req, signal) => p.complete({ ...req, ...meta }, signal),
  }
}

/** provider `none`: condensation and drafting are off. */
export class NoneProvider implements LLMProvider {
  readonly name = 'none'
  readonly model = ''
  async complete(): Promise<LLMResult> {
    throw new LLMError('no LLM provider is configured (llm.*.provider is none)')
  }
}

export const providerEnabled = (s: Pick<LLMSettings, 'provider'>): boolean => s.provider !== 'none'

/**
 * provider `fake`: deterministic, for tests. Answers with `respond(req)` (string, or an object
 * that is JSON-encoded), or, by default, an extractive summary of the condenser prompt: the
 * previous summary plus one line per user turn, newest kept within `maxChars`.
 */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake'
  readonly requests: LLMRequest[] = []
  constructor(
    readonly model = 'fake',
    private readonly respond?: (req: LLMRequest, n: number) => unknown,
    private readonly maxChars = 2000,
  ) {}
  async complete(req: LLMRequest): Promise<LLMResult> {
    this.requests.push(req)
    // a responder that returns undefined falls back to the extractive default
    const out = this.respond?.(req, this.requests.length) ?? this.extract(req.prompt)
    const text = typeof out === 'string' ? out : JSON.stringify(out)
    return {
      text,
      usage: {
        inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
    }
  }
  private extract(prompt: string): string {
    const section = (tag: string) =>
      new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)?.[1] ?? ''
    const prev = section('previous_summary').replace(/^\(none\)$/, '')
    const lines = prev ? prev.split('\n') : []
    for (const m of section('turns').matchAll(/^\[user #\d+\] (.*)$/gm))
      lines.push(`- user: ${(m[1] as string).slice(0, 80)}`)
    let text = lines.join('\n')
    while (text.length > this.maxChars && lines.length > 1) {
      lines.shift()
      text = lines.join('\n')
    }
    return JSON.stringify({ summary: text, proposals: [] })
  }
}

async function post(
  f: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs)
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (e) {
    throw new LLMError(`request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  const text = await res.text()
  if (!res.ok)
    throw new LLMError(`${url} answered ${res.status}: ${text.slice(0, 300)}`, res.status)
  try {
    return JSON.parse(text)
  } catch {
    throw new LLMError(`${url} answered non-JSON: ${text.slice(0, 120)}`, res.status)
  }
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function need(s: LLMSettings, env: NodeJS.ProcessEnv, what: string): string {
  if (!s.model || s.model === 'cheap')
    throw new LLMError(`${what}: set llm.*.model to a real model id (got '${s.model}')`)
  if (!s.api_key_env)
    throw new LLMError(`${what}: set llm.*.api_key_env to the key's variable name`)
  const key = env[s.api_key_env]
  if (!key) throw new LLMError(`${what}: environment variable ${s.api_key_env} is not set`)
  return key
}

/** OpenAI Chat Completions wire format: OpenAI, OpenRouter, vLLM, Ollama, LM Studio, … */
export class OpenAiCompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible'
  readonly model: string
  constructor(
    private readonly s: LLMSettings,
    private readonly io: ProviderEnv = {},
  ) {
    this.model = s.model
  }
  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResult> {
    const key = need(this.s, this.io.env ?? process.env, 'openai-compatible')
    const base = (this.s.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    const out = obj(
      await post(
        this.io.fetch ?? (fetch as unknown as FetchLike),
        `${base}/chat/completions`,
        { authorization: `Bearer ${key}` },
        {
          model: this.model,
          max_tokens: req.maxTokens,
          temperature: 0,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt },
          ],
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        },
        (this.s.timeout_seconds ?? 60) * 1000,
        signal,
      ),
    )
    const choice = obj((out.choices as unknown[] | undefined)?.[0])
    const text = obj(choice.message).content
    if (typeof text !== 'string') throw new LLMError('openai-compatible: response has no content')
    const u = obj(out.usage)
    const cached = n(obj(u.prompt_tokens_details).cached_tokens)
    return {
      text,
      usage: {
        inputTokens: n(u.prompt_tokens),
        outputTokens: n(u.completion_tokens),
        ...(cached ? { cacheReadTokens: cached } : {}),
      },
    }
  }
}

/** Anthropic Messages API. */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly model: string
  constructor(
    private readonly s: LLMSettings,
    private readonly io: ProviderEnv = {},
  ) {
    this.model = s.model
  }
  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResult> {
    const key = need(this.s, this.io.env ?? process.env, 'anthropic')
    const base = (this.s.base_url ?? 'https://api.anthropic.com').replace(/\/+$/, '')
    const out = obj(
      await post(
        this.io.fetch ?? (fetch as unknown as FetchLike),
        `${base}/v1/messages`,
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        {
          model: this.model,
          max_tokens: req.maxTokens,
          temperature: 0,
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
        },
        (this.s.timeout_seconds ?? 60) * 1000,
        signal,
      ),
    )
    const text = ((out.content as unknown[] | undefined) ?? [])
      .map(obj)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    if (!text) throw new LLMError('anthropic: response has no text content')
    const u = obj(out.usage)
    const read = n(u.cache_read_input_tokens)
    const write = n(u.cache_creation_input_tokens)
    return {
      text,
      usage: {
        inputTokens: n(u.input_tokens) + read + write,
        outputTokens: n(u.output_tokens),
        ...(read ? { cacheReadTokens: read } : {}),
        ...(write ? { cacheWriteTokens: write } : {}),
      },
    }
  }
}

export function createProvider(s: LLMSettings, io: ProviderEnv = {}): LLMProvider {
  switch (s.provider) {
    case 'none':
      return new NoneProvider()
    case 'fake':
      return new FakeProvider(s.model || 'fake')
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(s, io)
    case 'anthropic':
      return new AnthropicProvider(s, io)
    case 'kilo':
      return new RelayedProvider('kilo', s, io.relay)
    default:
      throw new LLMError(
        `unknown llm provider '${s.provider}' (none | fake | openai-compatible | anthropic | kilo)`,
      )
  }
}
