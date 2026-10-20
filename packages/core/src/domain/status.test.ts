import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import { block } from '../store/conformance.js'
import { GuardError, InvalidTransitionError } from './errors.js'
import { StatusMachine, type TransitionContext } from './status.js'

const cfg = loadConfig()
const sm = new StatusMachine(cfg.policies.status)
const ctx = (over: Partial<TransitionContext>): TransitionContext => ({
  block: block('a', 'root', { status: 'active' }),
  to: 'done',
  children: [],
  threads: [],
  digest: null,
  args: {},
  confirmDonePolicy: 'auto',
  ...over,
})

describe('status machine', () => {
  it('rejects transitions not in the table', () => {
    expect(() =>
      sm.check(ctx({ block: block('a', 'root', { status: 'planned' }), to: 'done' })),
    ).toThrow(InvalidTransitionError)
    expect(() =>
      sm.check(ctx({ block: block('a', 'root', { status: 'dropped' }), to: 'active' })),
    ).toThrow(InvalidTransitionError)
  })
  it('done needs a digest, no open threads, closed children', () => {
    expect(() => sm.check(ctx({}))).toThrow(GuardError)
    const withDigest = ctx({ args: { digestProvided: true } })
    expect(sm.check(withDigest)).toEqual({ proceed: true, needsConfirmation: false })
    expect(() =>
      sm.check(
        ctx({
          args: { digestProvided: true },
          threads: [
            {
              id: 't',
              blockId: 'a',
              title: 'x',
              status: 'open',
              entries: [],
              createdAt: '',
              updatedAt: '',
              by: { sessionId: 's', role: 'w' },
            },
          ],
        }),
      ),
    ).toThrow(/open thread/)
    expect(() =>
      sm.check(
        ctx({ args: { digestProvided: true }, children: [block('c', 'a', { status: 'active' })] }),
      ),
    ).toThrow(/child block/)
  })
  it('ask policy requests confirmation; confirmed proceeds', () => {
    expect(sm.check(ctx({ args: { digestProvided: true }, confirmDonePolicy: 'ask' }))).toEqual({
      proceed: false,
      needsConfirmation: true,
    })
    expect(
      sm.check(ctx({ args: { digestProvided: true, confirmed: true }, confirmDonePolicy: 'ask' }))
        .proceed,
    ).toBe(true)
  })
  it('reopen requires a reason; stale digest blocks re-close without a fresh one', () => {
    const done = block('a', 'root', { status: 'done' })
    expect(() => sm.check(ctx({ block: done, to: 'active' }))).toThrow(/reason/)
    expect(sm.check(ctx({ block: done, to: 'active', args: { reason: 'bug' } })).proceed).toBe(true)
    const stale = block('a', 'root', { status: 'active', digestStale: true })
    const digest = {
      blockId: 'a',
      type: 'digest' as const,
      version: 1,
      sections: {},
      updatedAt: '',
      by: { sessionId: 's', role: 'w' },
    }
    expect(() => sm.check(ctx({ block: stale, digest }))).toThrow(/stale/)
    expect(sm.check(ctx({ block: stale, digest, args: { digestProvided: true } })).proceed).toBe(
      true,
    )
  })
  it('blocked requires blocked_on', () => {
    expect(() => sm.check(ctx({ to: 'blocked' }))).toThrow(/blocked_on/)
    expect(sm.check(ctx({ to: 'blocked', args: { blockedOn: { kind: 'user' } } })).proceed).toBe(
      true,
    )
  })
})
