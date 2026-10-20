import type { Config, DocSchema } from '../config/schema.js'
import { CapExceededError, ValidationError } from '../domain/errors.js'
import type { DocType, SectionValue } from '../domain/types.js'
import { countValue, type Tokenizer } from '../tokenizer.js'

export interface Notice {
  level: 'info' | 'warn'
  text: string
}

export interface ValidationOutcome {
  sections: Record<string, SectionValue>
  notices: Notice[]
}

/** Resolve the doc schema for a block kind. Falls back to the default kind's mapping. */
export function schemaFor(config: Config, kind: string, type: DocType): DocSchema {
  const k = config.kinds.kinds[kind] ?? config.kinds.kinds[config.kinds.default_kind]
  const name = k?.schemas[type]
  if (!name) throw new ValidationError(`kind '${kind}' has no '${type}' document`, { kind, type })
  const s = config.schemas[name]
  if (!s) throw new ValidationError(`schema '${name}' not found`, { schema: name })
  return s
}

function checkFormat(name: string, format: string, v: unknown): void {
  const bad = (expect: string) =>
    new ValidationError(`section '${name}' must be ${expect}`, { section: name, format })
  switch (format) {
    case 'prose':
      if (typeof v !== 'string') throw bad('a string')
      return
    case 'list':
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
        throw bad('a list of strings')
      return
    case 'refs':
      if (
        !Array.isArray(v) ||
        !v.every((x) => x && typeof x === 'object' && 'label' in x && 'ref' in x)
      )
        throw bad('a list of {label, ref}')
      return
    case 'steps':
      if (
        !Array.isArray(v) ||
        !v.every((x) => x && typeof x === 'object' && 'id' in x && 'title' in x)
      )
        throw bad('a list of {id, title, notes?}')
      if (new Set((v as { id: string }[]).map((s) => s.id)).size !== v.length)
        throw new ValidationError(`section '${name}' has duplicate step ids`, { section: name })
      return
    case 'structured':
      if (!v || typeof v !== 'object' || Array.isArray(v))
        throw bad('an object (provides/consumes/contracts)')
      return
  }
}

/**
 * Strict validation for writes: required sections present, no unknown sections, formats correct,
 * caps respected (soft zone → notice; beyond → CapExceededError unless policy says warn).
 */
export function validateDoc(
  config: Config,
  tok: Tokenizer,
  schema: DocSchema,
  sections: Record<string, SectionValue>,
  opts: { capOverrides?: Record<string, number> } = {},
): ValidationOutcome {
  const known = new Map(schema.sections.map((s) => [s.name, s]))
  const unknown = Object.keys(sections).filter((n) => !known.has(n))
  if (unknown.length)
    throw new ValidationError(
      `unknown section(s): ${unknown.join(', ')}. Allowed: ${[...known.keys()].join(', ')}`,
      { unknown },
    )
  const missing = schema.sections.filter((s) => s.required && !(s.name in sections))
  if (missing.length)
    throw new ValidationError(
      `missing required section(s): ${missing.map((s) => s.name).join(', ')}`,
      {
        missing: missing.map((s) => s.name),
      },
    )

  const notices: Notice[] = []
  const soft = config.hafiz.tokenizer.soft_zone
  for (const [name, value] of Object.entries(sections)) {
    const def = known.get(name)
    if (!def) continue
    checkFormat(name, def.format, value)
    const cap = opts.capOverrides?.[name] ?? def.cap
    const measured = countValue(tok, value)
    if (measured > cap * (1 + soft)) {
      const remedy =
        schema.type === 'design'
          ? 'Split detail into child blocks or move it to progress notes.'
          : 'Tighten the text or split the block.'
      if (config.policies.caps.on_exceeded === 'reject')
        throw new CapExceededError(name, measured, cap, remedy)
      notices.push({ level: 'warn', text: `section '${name}' is ${measured} tokens (cap ${cap})` })
    } else if (measured > cap) {
      notices.push({
        level: 'info',
        text: `section '${name}' is ${measured} tokens, over the ${cap} cap but within tolerance; consider trimming.`,
      })
    }
  }
  return { sections, notices }
}

/** Lenient validation for reads: never throws; reports problems as notices. */
export function lintDoc(schema: DocSchema, sections: Record<string, SectionValue>): Notice[] {
  const known = new Set(schema.sections.map((s) => s.name))
  const out: Notice[] = []
  for (const s of schema.sections)
    if (s.required && !(s.name in sections))
      out.push({ level: 'warn', text: `missing required section '${s.name}'` })
  for (const n of Object.keys(sections))
    if (!known.has(n)) out.push({ level: 'info', text: `unknown section '${n}' (kept)` })
  return out
}
