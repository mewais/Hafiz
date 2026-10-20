// The one shaping function both RequestShaper implementations share (ARCHITECTURE §6.5): for a
// session, fetch envelope + floor (`context.for`), the delta (`context.delta`) and the unfiled
// summary, run core's `shapeTail` + `assemble`, and hand back the system addition plus the
// rewritten turns. Wire adapters map those onto the host's request format.
import { createHash } from 'node:crypto'
import {
  assemble,
  type Config,
  type Conversation,
  estimatorTokenizer,
  shapeTail,
  type Tokenizer,
  type Turn,
  tailPolicy,
} from '@hafiz/core'

/** Turn ids the shaper inserts; adapters emit these as new user messages. */
export const INSERTED_PREFIX = 'hafiz-'

export function isInserted(t: Turn): boolean {
  return t.id?.startsWith(INSERTED_PREFIX) === true
}

/** What the shaper needs from the daemon for one host session. */
export interface SessionSource {
  /** Whether requests for this session are shaped at all. */
  isManaged(sessionId: string): boolean
  view(sessionId: string, model?: string): Promise<{ envelope: string; floor: string } | null>
  delta(sessionId: string): Promise<string>
  unfiled(sessionId: string): Promise<string | undefined>
}

export interface ShapeInput {
  sessionId: string
  model?: string | undefined
  /** Host conversation. `system` is not rewritten; the addition is returned separately. */
  conversation: Conversation
  /** Which parts to compute (the hooks shaper does system and tail in separate calls). */
  parts?: { system?: boolean; tail?: boolean }
}

export interface Shaped {
  /** Envelope + floor, to append after the host's own system content. '' when not computed. */
  systemAddition: string
  /** Rewritten turns: original ids kept, inserted turns carry `hafiz-*` ids. */
  turns: Turn[]
  /** Ids of turns whose content was replaced by a stub. */
  stubbed: string[]
  /** Inclusive range the condenser should fold (M5); reported, not acted on here. */
  condense?: { fromIndex: number; toIndex: number }
}

export interface ShaperOptions {
  config: Config
  source: SessionSource
  tokenizer?: Tokenizer
  /** Delta ledger entries kept per session. */
  ledgerCap?: number
}

interface DeltaRecord {
  /** Fingerprint of the user turn the delta was delivered in front of. */
  anchor: string
  text: string
}

const fingerprint = (t: Turn) =>
  createHash('sha256').update(`${t.role}\0${t.content}`).digest('hex').slice(0, 16)

/** Context window for a model name: longest `windows` key that prefixes it, else `default`. */
export function windowFor(config: Config, model?: string): number {
  const w = config.hafiz.windows
  if (model) {
    const keys = Object.keys(w)
      .filter((k) => k !== 'default' && model.startsWith(k))
      .sort((a, b) => b.length - a.length)
    if (keys[0]) return w[keys[0]] as number
  }
  return w.default ?? 200000
}

/**
 * Deltas are delivered once by the daemon (its cursor advances), but a request rebuilds the
 * whole conversation every time. To keep the prefix byte-stable for prompt caching, each
 * delivered delta is remembered with the user turn it preceded and re-inserted there on every
 * later request.
 */
export class ConversationShaper {
  private readonly ledgers = new Map<string, DeltaRecord[]>()
  private readonly tok: Tokenizer
  private readonly cap: number

  constructor(private readonly opts: ShaperOptions) {
    this.tok = opts.tokenizer ?? estimatorTokenizer
    this.cap = opts.ledgerCap ?? 64
  }

  isManaged(sessionId: string): boolean {
    return this.opts.source.isManaged(sessionId)
  }

  /** null → not a managed session; pass the request through untouched. */
  async shape(input: ShapeInput): Promise<Shaped | null> {
    const { source, config } = this.opts
    const { sessionId, model } = input
    if (!source.isManaged(sessionId)) return null
    const want = { system: true, tail: true, ...input.parts }

    let systemAddition = ''
    if (want.system) {
      const v = await source.view(sessionId, model)
      if (!v) return null
      systemAddition = assemble({
        envelope: v.envelope,
        floor: v.floor,
        tail: { system: '', turns: [] },
      }).system
    }
    if (!want.tail) return { systemAddition, turns: input.conversation.turns, stubbed: [] }

    const original = input.conversation.turns
    const shaped = shapeTail(
      { system: '', turns: original },
      { policy: tailPolicy(config), window: windowFor(config, model), tokenizer: this.tok },
    )
    const stubbed = shaped.stubbed.map((i) => original[i]?.id ?? String(i))
    const ledger = this.ledgers.get(sessionId) ?? []
    let turns = reinsert(shaped.conversation.turns, ledger)

    const [delta, unfiled] = await Promise.all([source.delta(sessionId), source.unfiled(sessionId)])
    if (delta.trim()) {
      const anchor = newestUser(turns)
      if (anchor) {
        ledger.push({ anchor: fingerprint(anchor), text: delta })
        while (ledger.length > this.cap) ledger.shift()
        this.ledgers.set(sessionId, ledger)
      }
    }
    turns = assemble({
      envelope: '',
      tail: { system: '', turns },
      ...(delta.trim() ? { delta } : {}),
      ...(unfiled ? { unfiled } : {}),
    }).turns
    return {
      systemAddition,
      turns,
      stubbed,
      ...(shaped.condense ? { condense: shaped.condense } : {}),
    }
  }

  /** Forget a session's delta ledger (session ended). */
  forget(sessionId: string): void {
    this.ledgers.delete(sessionId)
  }
}

function newestUser(turns: Turn[]): Turn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] as Turn
    if (t.role === 'user' && !isInserted(t)) return t
  }
  return undefined
}

/** Put remembered deltas back in front of the user turns they were delivered with. */
function reinsert(turns: Turn[], ledger: DeltaRecord[]): Turn[] {
  if (!ledger.length) return turns
  const byAnchor = new Map<string, string[]>()
  for (const r of ledger) byAnchor.set(r.anchor, [...(byAnchor.get(r.anchor) ?? []), r.text])
  const out: Turn[] = []
  const used = new Set<string>()
  for (const t of turns) {
    if (t.role === 'user' && !isInserted(t)) {
      const key = fingerprint(t)
      const texts = used.has(key) ? undefined : byAnchor.get(key)
      if (texts) {
        used.add(key)
        for (const content of texts) out.push({ role: 'user', content, id: 'hafiz-delta' })
      }
    }
    out.push(t)
  }
  return out
}
