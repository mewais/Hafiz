import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, loadConfig } from '@hafiz/core'
import { ConversationShaper, type SessionSource } from '../src/index.js'

export const ENVELOPE =
  '<hafiz hash="3f9c2a7d1b04" role="worker">\n# Shop [blk_root] active\n## Payments [blk_pay] active · focus\nDesign: round to cents at the boundary.\n</hafiz>'
export const FLOOR = '<hafiz-floor>\n- never: store card numbers (blk_root)\n</hafiz-floor>'

/** A fixture as Kilo sends it: compact JSON (what JSON.stringify of the SDK body produces). */
export function fixture(name: string): string {
  const raw = readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
  return JSON.stringify(JSON.parse(raw))
}

export interface FakeSource extends SessionSource {
  deltas: string[]
  unfiledText?: string
  calls: string[]
}

/** A daemon stand-in: session `s1` is managed, everything else is not. */
export function fakeSource(o: { deltas?: string[]; unfiled?: string } = {}): FakeSource {
  const src: FakeSource = {
    deltas: o.deltas ?? [],
    calls: [],
    isManaged: (id) => id === 's1',
    view: async (id) => {
      src.calls.push(`view:${id}`)
      return { envelope: ENVELOPE, floor: FLOOR }
    },
    delta: async () => src.deltas.shift() ?? '',
    unfiled: async () => src.unfiledText,
  }
  if (o.unfiled) src.unfiledText = o.unfiled
  return src
}

/** Default config with tail overrides. */
export function configWith(tail: Partial<Config['tail']['tail']> = {}): Config {
  const c = loadConfig()
  return { ...c, tail: { ...c.tail, tail: { ...c.tail.tail, ...tail } } }
}

export function shaperFor(source: SessionSource, config: Config = loadConfig()) {
  return new ConversationShaper({ config, source })
}
