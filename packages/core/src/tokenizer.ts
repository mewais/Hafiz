export interface Tokenizer {
  readonly name: string
  count(text: string): number
}

/**
 * Vendor-neutral estimator. Real tokenizers differ by 10–20% between vendors, so caps and
 * budgets treat this as approximate and apply a soft zone (hafiz.yaml `tokenizer.soft_zone`).
 * Heuristic: blend of character and word counts, which tracks BPE tokenizers reasonably on
 * English prose and code.
 */
export const estimatorTokenizer: Tokenizer = {
  name: 'estimator',
  count(text: string): number {
    if (!text) return 0
    const chars = text.length
    const words = text.split(/\s+/).filter(Boolean).length
    return Math.ceil(Math.max(chars / 4, words * 1.3))
  },
}

export function countValue(tok: Tokenizer, value: unknown): number {
  return tok.count(typeof value === 'string' ? value : JSON.stringify(value))
}
