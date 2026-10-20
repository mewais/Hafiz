import { describe, expect, it } from 'vitest'
import { PACKAGE } from './index.js'

describe('scaffold', () => {
  it('exports the package name', () => {
    expect(PACKAGE).toBe('@hafiz/core')
  })
})
