import { describe, expect, it } from 'vitest'
import { ExprError, evaluate, identifiers, parseExpr } from './expr.js'

describe('compliance expressions', () => {
  const v = { files_written: 3, progress: 0, turns: 30, a: 1, b: 0 }

  it('evaluates comparisons, && || ! and parentheses', () => {
    expect(evaluate('files_written > 0 && progress == 0', v)).toBe(true)
    expect(evaluate('files_written > 0 && progress != 0', v)).toBe(false)
    expect(evaluate('turns >= 30', v)).toBe(true)
    expect(evaluate('turns < 30 || a', v)).toBe(true)
    expect(evaluate('!(turns > 10) || b', v)).toBe(false)
    expect(evaluate('a && (b || turns <= 30)', v)).toBe(true)
    expect(evaluate('1.5 < 2', v)).toBe(true)
  })

  it('precedence: && binds tighter than ||, comparison tighter than both', () => {
    expect(evaluate('b || a && a', v)).toBe(true)
    expect(evaluate('b && a || a', v)).toBe(true)
    expect(evaluate('b == 0 && a == 1', v)).toBe(true)
  })

  it('reads unknown identifiers as 0 and lists the ones it reads', () => {
    expect(evaluate('nope > 0', v)).toBe(false)
    expect(evaluate('nope == 0', v)).toBe(true)
    expect([...identifiers(parseExpr('a > b && c'))].sort()).toEqual(['a', 'b', 'c'])
  })

  it('does not let identifiers reach object prototypes', () => {
    expect(evaluate('constructor == 0 && __proto__ == 0 && toString == 0', v)).toBe(true)
  })

  it.each([
    'process.exit(1)',
    'constructor.constructor("return 1")()',
    'a.b > 1',
    'a = 1',
    '"x" == "x"',
    'a ? b : 1',
    'a + 1 > 1',
    '`x`',
    'a > ',
    '(a',
    'a b',
    '',
    '1; 2',
    'a & b',
    'require("fs")',
    '[1]',
  ])('rejects %j', (src) => {
    expect(() => parseExpr(src)).toThrow(ExprError)
  })
})
