// LLMProvider SPI: the one narrow door through which Core asks a model anything (condenser,
// drafters). Implementations are tiny `fetch` clients; no vendor SDKs.

export interface LLMRequest {
  system: string
  prompt: string
  maxTokens: number
  /** Ask for a JSON object where the wire format supports it; callers still parse defensively. */
  json?: boolean
  /** The Hafiz session the call is made for (relayed providers attribute the cost to it). */
  sessionId?: string
  /** What the call is for; relayed providers use it to label the work. */
  purpose?: 'condense' | 'gist' | 'digest'
}

export interface LLMUsage {
  /** Prompt tokens as billed, cache reads and writes included. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface LLMResult {
  text: string
  usage?: LLMUsage
}

export interface LLMProvider {
  readonly name: string
  readonly model: string
  complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResult>
}

/**
 * Where relayed providers (`kilo`) run: a process other than the daemon that registered itself
 * for the provider (the Kilo plugin). The daemon implements it over the plugin's connection.
 */
export interface LLMRelay {
  complete(
    provider: string,
    settings: LLMSettings,
    req: LLMRequest,
    signal?: AbortSignal,
  ): Promise<LLMResult>
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'LLMError'
  }
}

/** `hafiz.yaml llm.condenser` / `llm.drafters`. */
export interface LLMSettings {
  provider: string
  model: string
  base_url?: string | undefined
  api_key_env?: string | undefined
  max_tokens?: number | undefined
  timeout_seconds?: number | undefined
}
