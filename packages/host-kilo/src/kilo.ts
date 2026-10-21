// The slice of the Kilo plugin API (@kilocode/plugin 7.8.x) this adapter uses, typed structurally
// so the package needs no runtime dependency on Kilo. Verified against the installed type
// definitions and the CLI bundle; see docs/HOST-MATRIX.md §3.3.

/** Kilo's in-process SDK client (v1, `@kilocode/sdk`); only the calls the adapter makes. */
export interface KiloClient {
  session?: {
    messages?: (o: {
      path: { id: string }
      query?: { directory?: string }
    }) => Promise<{ data?: KiloMessageWithParts[] } | undefined>
    create?: (o: {
      body?: { parentID?: string; title?: string }
      query?: { directory?: string }
    }) => Promise<{ data?: KiloSession; error?: unknown } | undefined>
    /** Synchronous: resolves with the finished assistant message. */
    prompt?: (o: {
      path: { id: string }
      body: {
        agent?: string
        model?: { providerID: string; modelID: string }
        system?: string
        tools?: Record<string, boolean>
        parts: Array<{ type: 'text'; text: string }>
      }
      query?: { directory?: string }
    }) => Promise<{ data?: KiloMessageWithParts; error?: unknown } | undefined>
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
  cost?: number
  error?: unknown
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

/** `ToolContext` of `@kilocode/plugin`'s `tool()` (only the fields the adapter reads). */
export interface KiloToolContext {
  sessionID: string
  messageID: string
  agent: string
  directory?: string
  worktree?: string
  abort?: AbortSignal
  [k: string]: unknown
}

export type KiloToolResult =
  | string
  | { title?: string; output: string; metadata?: Record<string, unknown> }

/**
 * A plugin tool: `args` is a Zod (v4) raw shape. Kilo builds `z.object(args)` for validation and
 * JSON Schema; it accepts any object whose values carry `_zod`, so our own zod copy works.
 * Permission key = the tool's id (the key in `Hooks.tool`).
 */
export interface KiloToolDefinition {
  description: string
  args: Record<string, unknown>
  // biome-ignore lint/suspicious/noExplicitAny: args are validated by Kilo against `args`
  execute(args: any, context: KiloToolContext): Promise<KiloToolResult>
}

export interface Hooks {
  dispose?: () => Promise<void>
  tool?: Record<string, KiloToolDefinition>
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
  /** Before a tool runs (also Kilo's own, e.g. `task`, `bash`): mutate `args` or throw to veto. */
  'tool.execute.before'?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>
  /**
   * Each tool definition sent to the model, every request; no session in the input. Built-in
   * tools carry an Effect Schema in `parameters`; a replaced one is converted to JSON Schema.
   */
  'tool.definition'?: (
    input: { toolID: string },
    output: { description: string; parameters: unknown; jsonSchema?: unknown },
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
