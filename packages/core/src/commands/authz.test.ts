import { describe, expect, it } from 'vitest'
import { isAllowed } from './authz.js'

describe('isAllowed', () => {
  it('supports exact, qualified and namespace patterns', () => {
    expect(isAllowed(['block.create'], 'block.create', 'x')).toBe(true)
    expect(isAllowed(['doc.write:design'], 'doc.write', 'plan')).toBe(false)
    expect(isAllowed(['block.*'], 'block.read')).toBe(true)
    expect(isAllowed(['block.*'], 'edge.add')).toBe(false)
  })

  it('treats * as allow everything', () => {
    expect(isAllowed(['*'], 'doc.write', 'design')).toBe(true)
    expect(isAllowed(['*'], 'anything.at_all')).toBe(true)
    expect(isAllowed([], 'block.read')).toBe(false)
  })
})
