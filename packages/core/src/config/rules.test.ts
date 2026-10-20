// Golden checks on the rules files: they are the protocol contract agents follow, so every tool
// they name must exist and be callable by that role, and the vocabulary they cite (progress kinds,
// step statuses, standing levels, zooms) must match the config.
import { describe, expect, it } from 'vitest'
import { TOOL_SPECS, toolName, toolsForRole } from '../commands/catalogue.js'
import { loadConfig, rulesFor } from './load.js'

const config = loadConfig()
const agentRoles = Object.keys(config.roles.roles).filter((r) => r !== 'user')
const mentioned = (text: string) => [...new Set(text.match(/\bhafiz_[a-z_]+\b/g) ?? [])]

describe('rules files', () => {
  it.each(agentRoles)('%s rules mention only tools the role has', (role) => {
    const text = rulesFor(config, role)
    const has = new Set(toolsForRole(config, role).map((t) => toolName(t.spec.command)))
    const all = new Set(TOOL_SPECS.map((s) => toolName(s.command)))
    const names = mentioned(text)
    expect(names.length).toBeGreaterThan(3)
    for (const n of names) {
      expect(all.has(n), `${role}: ${n} is not a tool`).toBe(true)
      expect(has.has(n), `${role}: ${n} is not in the ${role} allowlist`).toBe(true)
    }
  })

  it.each(agentRoles)('%s rules are concise and carry the shared protocol', (role) => {
    const own = config.rules[config.roles.roles[role]?.rules as string] ?? ''
    expect(own.trim().split('\n').length).toBeLessThanOrEqual(60)
    const text = rulesFor(config, role)
    for (const s of [
      '<hafiz',
      '<hafiz-floor>',
      '<hafiz-delta>',
      '<hafiz-unfiled>',
      'hafiz_block_read',
    ])
      expect(text).toContain(s)
  })

  it('the user role gets only its own file', () => {
    expect(rulesFor(config, 'user')).not.toContain('<hafiz-delta>')
  })

  it('cite the configured vocabulary', () => {
    const worker = rulesFor(config, 'worker')
    for (const k of config.logs.progress.kinds.filter((k) => k !== 'report'))
      expect(worker).toContain(`\`${k}\``)
    for (const s of config.logs.step.statuses.filter((s) => s !== 'todo'))
      expect(worker).toContain(`\`${s}\``)
    expect(worker).toContain('```hafiz-report')
    const manager = rulesFor(config, 'manager')
    for (const s of config.logs.decision.standing) expect(manager).toContain(`\`${s}\``)
    expect(manager).toContain('hafiz:block=<block-id>')
    for (const z of ['INTERFACE', 'DESIGN']) expect(Object.keys(config.zooms.zooms)).toContain(z)
  })
})
