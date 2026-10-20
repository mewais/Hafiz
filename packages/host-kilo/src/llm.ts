// LLM provider `kilo` (hafiz.yaml `llm.condenser.provider: kilo`, `llm.drafters.provider: kilo`):
// the condenser and drafters run through Kilo itself, so their cost lands in Kilo's usage for the
// session they work for. The daemon relays each request to this plugin (`llm.complete` over the
// plugin's daemon connection); the plugin opens a child session of the condensed session
// (`parentID`), prompts the hidden `hafiz-condenser` agent synchronously with every tool denied,
// and hands the reply text back. Core parses it with the same condenser/drafter parsers as any
// other provider. Hafiz never manages that child session (see SessionRegistry.ignore).
import { LLMError, type LLMRequest, type LLMResult, type LLMSettings } from '@hafiz/core'
import type { KiloClient, KiloConfig, KiloMessageWithParts } from './kilo.js'

/** The hidden agent the relayed calls run as. */
export const CONDENSER_AGENT = 'hafiz-condenser'

const AGENT_PROMPT =
  'You are a text-processing function inside Hafiz. You have no tools. Follow the system ' +
  'instructions exactly and reply with only the requested output: no preamble, no code fence ' +
  'unless asked.'

const TITLES: Record<NonNullable<LLMRequest['purpose']>, string> = {
  condense: 'Hafiz: condense',
  gist: 'Hafiz: thread gist',
  digest: 'Hafiz: digest draft',
}

/** True when hafiz.yaml routes the condenser or the (enabled) drafters through Kilo. */
export function usesKiloLlm(llm: {
  condenser: { provider: string }
  drafters: { provider: string; enabled: boolean }
}): boolean {
  return (
    llm.condenser.provider === 'kilo' || (llm.drafters.enabled && llm.drafters.provider === 'kilo')
  )
}

/** `provider/model` → Kilo's model reference; undefined = the agent's (or Kilo's) default. */
export function kiloModel(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!model || model === 'cheap') return undefined
  const i = model.indexOf('/')
  if (i <= 0 || i === model.length - 1) return undefined
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) }
}

/** Register the hidden agent (config hook). A user entry of that name refines it; tools stay denied. */
export function installCondenserAgent(cfg: KiloConfig, model?: string): void {
  cfg.agent ??= {}
  const ref = kiloModel(model)
  cfg.agent[CONDENSER_AGENT] = {
    description: 'Hafiz condenser and drafters (internal; runs in a child session, no tools)',
    mode: 'primary',
    hidden: true,
    prompt: AGENT_PROMPT,
    ...(ref ? { model: `${ref.providerID}/${ref.modelID}` } : {}),
    ...(cfg.agent[CONDENSER_AGENT] ?? {}),
    permission: { '*': 'deny' },
  }
}

export interface KiloLlmDeps {
  client: KiloClient | undefined
  directory: string
  /** Mark a Kilo session as not Hafiz's to manage (called before it is prompted). */
  ignore: (sessionId: string) => void
  /** Child session → system text, read by `condenserSystemHook` while the prompt runs. */
  systems?: Map<string, string>
}

function replyText(m: KiloMessageWithParts): string {
  return m.parts
    .filter((p) => p.type === 'text' && !p.synthetic && !p.ignored && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}

/**
 * `experimental.chat.system.transform` for the hidden agent's child sessions: Kilo prefixes every
 * agent prompt with its persona, environment block and instructions, none of which a text
 * function wants, and no agent or `session.prompt` option turns that off. The array is replaced
 * with the agent prompt and the request's own system text.
 */
export function condenserSystemHook(systems: ReadonlyMap<string, string>) {
  return async (i: { sessionID?: string }, o: { system: string[] }): Promise<void> => {
    const own = i.sessionID ? systems.get(i.sessionID) : undefined
    if (own !== undefined) o.system.splice(0, o.system.length, `${AGENT_PROMPT}\n\n${own}`)
  }
}

/** One relayed completion: a child session of `req.sessionId`, prompted synchronously. */
export async function kiloComplete(
  deps: KiloLlmDeps,
  settings: LLMSettings,
  req: LLMRequest,
): Promise<LLMResult> {
  const session = deps.client?.session
  if (!session?.create || !session.prompt)
    throw new LLMError('kilo: the plugin has no Kilo client to run the model with')
  const query = { directory: deps.directory }
  const created = await session.create({
    body: {
      ...(req.sessionId ? { parentID: req.sessionId } : {}),
      title: TITLES[req.purpose ?? 'condense'],
    },
    query,
  })
  const child = created?.data?.id
  if (!child)
    throw new LLMError(`kilo: could not create a child session: ${String(created?.error)}`)
  deps.ignore(child)
  const model = kiloModel(settings.model)
  const text = req.json ? `${req.prompt}\n\nReply with the JSON object only.` : req.prompt
  deps.systems?.set(child, req.system)
  const res = await session
    .prompt({
      path: { id: child },
      body: {
        agent: CONDENSER_AGENT,
        ...(model ? { model } : {}),
        system: req.system,
        tools: {},
        parts: [{ type: 'text', text }],
      },
      query,
    })
    .finally(() => deps.systems?.delete(child))
  const msg = res?.data
  if (!msg?.info) throw new LLMError(`kilo: prompt failed: ${String(res?.error ?? 'no reply')}`)
  if (msg.info.error)
    throw new LLMError(`kilo: model error: ${JSON.stringify(msg.info.error).slice(0, 300)}`)
  const out = replyText(msg)
  if (!out.trim()) throw new LLMError('kilo: the reply has no text')
  const t = msg.info.tokens
  const read = t?.cache?.read ?? 0
  const write = t?.cache?.write ?? 0
  return {
    text: out,
    ...(t
      ? {
          usage: {
            inputTokens: t.input + read + write,
            outputTokens: t.output + (t.reasoning ?? 0),
            ...(read ? { cacheReadTokens: read } : {}),
            ...(write ? { cacheWriteTokens: write } : {}),
          },
        }
      : {}),
  }
}

/** The handler the plugin registers with the daemon for `llm.complete`. */
export function kiloRelayHandler(deps: KiloLlmDeps) {
  return async (method: string, params: Record<string, unknown>): Promise<LLMResult> => {
    if (method !== 'llm.complete' || params.provider !== 'kilo')
      throw new LLMError(`kilo plugin: cannot serve ${method} for '${String(params.provider)}'`)
    return kiloComplete(deps, params.settings as LLMSettings, params.request as LLMRequest)
  }
}
