// The slice of the Kilo plugin API (@kilocode/plugin 7.8.x) this adapter uses, typed structurally
// so the package needs no runtime dependency on Kilo. Verified against the installed type
// definitions and the CLI bundle; see docs/HOST-MATRIX.md §3.3.

/** Kilo's in-process SDK client; only the calls the adapter makes. */
export interface KiloClient {
  session?: {
    messages?: (o: {
      path: { id: string }
      query?: { directory?: string }
    }) => Promise<{ data?: KiloMessageWithParts[] } | undefined>
  }
}

export interface PluginInput {
  client?: KiloClient
  directory: string
  worktree?: string
  project?: unknown
  serverUrl?: URL
}

export type PluginOptions = Record<string, unknown>

export interface KiloModel {
  id: string
  providerID: string
  api?: { id?: string; url?: string; npm?: string }
}

export interface KiloSession {
  id: string
  parentID?: string
  agent?: string
  title?: string
  directory?: string
}

export interface KiloEvent {
  id?: string
  type: string
  properties?: Record<string, unknown>
}

export interface KiloMessageInfo {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  agent?: string
  time?: { created: number; completed?: number }
  tokens?: {
    input: number
    output: number
    reasoning?: number
    cache?: { read: number; write: number }
  }
  [k: string]: unknown
}

export interface KiloPart {
  id?: string
  sessionID?: string
  messageID?: string
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  tool?: string
  callID?: string
  state?: { status: string; output?: string; [k: string]: unknown }
  [k: string]: unknown
}

export interface KiloMessageWithParts {
  info: KiloMessageInfo
  parts: KiloPart[]
}

/** Kilo's config object as the `config` hook sees it (mutated in place). */
export interface KiloConfig {
  agent?: Record<string, Record<string, unknown> | undefined>
  mcp?: Record<string, Record<string, unknown>>
  command?: Record<string, Record<string, unknown>>
  provider?: Record<string, { options?: Record<string, unknown>; [k: string]: unknown } | null>
  permission?: string | Record<string, unknown>
  compaction?: Record<string, unknown>
  [k: string]: unknown
}

export interface Hooks {
  dispose?: () => Promise<void>
  config?: (cfg: KiloConfig) => Promise<void>
  event?: (input: { event: KiloEvent }) => Promise<void>
  'chat.message'?: (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: { agent?: string; [k: string]: unknown }; parts: KiloPart[] },
  ) => Promise<void>
  'chat.headers'?: (
    input: { sessionID: string; agent: string; model: KiloModel },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  'tool.execute.after'?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>
  'experimental.chat.system.transform'?: (
    input: { sessionID?: string; model: KiloModel },
    output: { system: string[] },
  ) => Promise<void>
  'experimental.chat.messages.transform'?: (
    input: Record<string, never>,
    output: { messages: KiloMessageWithParts[] },
  ) => Promise<void>
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

/** The module shape Kilo's loader prefers: `export default { id, server }`. */
export interface PluginModule {
  id: string
  server: Plugin
}
