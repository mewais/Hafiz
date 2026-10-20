// Golden-file comparison. `UPDATE_GOLDEN=1 pnpm test` rewrites the files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { ViewResult } from '../engine.js'

export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '__golden__')

/** Compare against a golden file; writes it first when updating (or when missing outside CI). */
export function expectGolden(name: string, actual: string): void {
  const file = join(GOLDEN_DIR, name)
  if (process.env.UPDATE_GOLDEN || (!existsSync(file) && !process.env.CI)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, actual)
  }
  expect(actual).toBe(readFileSync(file, 'utf8'))
}

/** A view as a reviewable golden: envelope, floor, then the manifest in a trailing comment. */
export function viewGolden(
  v: Pick<ViewResult, 'text' | 'floorText' | 'manifest' | 'budget' | 'tokens' | 'floorTokens'>,
): string {
  const rows = v.manifest.map(
    (m) => `${m.block.padEnd(28)} ${m.relation.padEnd(10)} ${m.zoom.padEnd(9)} ${m.tokens}`,
  )
  return [
    v.text,
    ...(v.floorText ? ['', v.floorText] : []),
    '',
    '<!-- manifest',
    `budget ${v.budget} · view ${v.tokens} tokens · floor ${v.floorTokens} tokens`,
    ...rows,
    '-->',
    '',
  ].join('\n')
}
