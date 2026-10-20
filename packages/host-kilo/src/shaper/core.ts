// The one shaping function both RequestShaper implementations share (ARCHITECTURE §6.5): for a
// session, fetch envelope + floor (`context.for`), the delta (`context.delta`) and the unfiled
// summary, run core's `shapeTail` + `assemble`, and hand back the system addition plus the
// rewritten turns. Wire adapters map those onto the host's request format.
import { createHash } from 'node:crypto'
import {
  assemble,
  type CondenseCursor,
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
  unfiled(sessionId: string): Promise<UnfiledState | undefined>
  /**
   * Ask the daemon to condense `turns` (ending at `through`) into the unfiled summary. Resolves
   * when done; the shaper never waits for it. Absent → condensation is off for this source.
   */
  condense?(sessionId: string, req: CondenseRequest): Promise<unknown>
}

/** What the daemon holds about a session's condensed past. */
export interface UnfiledState {
  summary?: string | undefined
  /** Last condensed turn; everything up to and including it is dropped from the tail. */
  cursor?: CondenseCursor | undefined
  /** `hafiz checkpoint` asked for a condensation at the next shaping. */
  checkpoint?: boolean | undefined
}

export interface CondenseRequest {
  turns: Array<{ role: string; content: string; toolName?: string }>
  through: CondenseCursor
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
  /** Inclusive range (in the host conversation) a condensation was started for. */
  condense?: { fromIndex: number; toIndex: number }
  /** Leading host turns already covered by the unfiled summary and left out of `turns`. */
  covered: number
}

export interface ShaperOptions {
  config: Config
  source: SessionSource
  tokenizer?: Tokenizer
  /** Delta ledger entries kept per session. */
  ledgerCap?: number
  log?: (line: string) => void
}

interface DeltaRecord {
  /** Fingerprint of the user turn the delta was delivered in front of. */
  anchor: string
  text: string
}

export const fingerprint = (t: Turn) =>
  createHash('sha256').update(`${t.role}\0${t.content}`).digest('hex').slice(0, 16)

/**
 * Index of the last condensed turn in the host conversation, or -1 when it cannot be found
 * (then nothing is dropped: the summary is redundant, never lossy). The stored index is a hint;
 * the content fingerprint decides, nearest match to the hint winning.
 */
export function locateCursor(turns: readonly Turn[], cursor: CondenseCursor | undefined): number {
  if (!cursor) return -1
  const at = turns[cursor.index]
  if (at && fingerprint(at) === cursor.fingerprint) return cursor.index
  let best = -1
  turns.forEach((t, i) => {
    if (fingerprint(t) !== cursor.fingerprint) return
    if (best < 0 || Math.abs(i - cursor.index) < Math.abs(best - cursor.index)) best = i
  })
  return best
}

/** Slice for `/hafiz-checkpoint`: everything before the newest user turn, ending on a turn boundary. */
function checkpointSlice(turns: readonly Turn[]): number | undefined {
  let newestUser = -1
  for (let i = turns.length - 1; i >= 0; i--)
    if ((turns[i] as Turn).role === 'user') {
      newestUser = i
      break
    }
  return newestUser >= 2 ? newestUser - 1 : undefined
}

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
  private readonly condensing = new Map<string, Promise<void>>()
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
    if (!want.tail)
      return { systemAddition, turns: input.conversation.turns, stubbed: [], covered: 0 }

    const original = input.conversation.turns
    const [delta, state] = await Promise.all([source.delta(sessionId), source.unfiled(sessionId)])
    // Turns the unfiled summary already covers leave the tail. The cut follows the stored
    // fingerprint, so it is identical on every request until the next condensation moves it.
    const covered = locateCursor(original, state?.cursor) + 1
    const live = original.slice(covered)
    const shaped = shapeTail(
      { system: '', turns: live },
      { policy: tailPolicy(config), window: windowFor(config, model), tokenizer: this.tok },
    )
    const stubbed = shaped.stubbed.map((i) => live[i]?.id ?? String(i))
    const ledger = this.ledgers.get(sessionId) ?? []
    let turns = reinsert(shaped.conversation.turns, ledger)

    let condense = shaped.condense
    if (!condense && state?.checkpoint) {
      const to = checkpointSlice(shaped.conversation.turns)
      if (to !== undefined) condense = { fromIndex: 0, toIndex: to }
    }
    const started = condense
      ? this.startCondense(sessionId, shaped.conversation.turns, original, covered, condense)
      : undefined

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
      ...(state?.summary ? { unfiled: state.summary } : {}),
    }).turns
    return {
      systemAddition,
      turns,
      stubbed,
      covered,
      ...(started ? { condense: started } : {}),
    }
  }

  /**
   * Fire-and-forget: the current request proceeds with the un-condensed tail, the next one finds
   * the summary and the new cut. One condensation per session at a time; with the provider
   * `none` the tail simply grows (the host's own compaction stays on, see install.ts).
   */
  private startCondense(
    sessionId: string,
    shapedTurns: readonly Turn[],
    original: readonly Turn[],
    covered: number,
    range: { fromIndex: number; toIndex: number },
  ): { fromIndex: number; toIndex: number } | undefined {
    const { source, config } = this.opts
    if (config.hafiz.llm.condenser.provider === 'none' || !source.condense) return undefined
    if (this.condensing.has(sessionId)) return undefined
    const last = original[covered + range.toIndex]
    if (!last) return undefined
    const turns = shapedTurns.slice(range.fromIndex, range.toIndex + 1).map((t) => ({
      role: t.role,
      content: t.content,
      ...(t.toolName ? { toolName: t.toolName } : {}),
    }))
    const through = { index: covered + range.toIndex, fingerprint: fingerprint(last) }
    const p = source
      .condense(sessionId, { turns, through })
      .then(() => undefined)
      .catch((e) => this.opts.log?.(`hafiz: condensation for ${sessionId} failed: ${String(e)}`))
      .finally(() => this.condensing.delete(sessionId))
    this.condensing.set(sessionId, p)
    return { fromIndex: covered + range.fromIndex, toIndex: covered + range.toIndex }
  }

  /** Resolves when no condensation is running (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.condensing.size) await Promise.all([...this.condensing.values()])
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
