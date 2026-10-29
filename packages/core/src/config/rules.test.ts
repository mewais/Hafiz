// Golden checks on the rules files: they are the protocol contract agents follow, so every tool
// they name must exist and be callable by that role, the vocabulary they cite (progress kinds,
// step statuses, standing levels) must match the config, and they must stay short enough to sit
// in every request.
import { describe, expect, it } from 'vitest'
import { TOOL_SPECS, toolsForRole } from '../commands/tools.js'
import { estimatorTokenizer } from '../tokenizer.js'
import { agentRoleNames, COMMON_RULES, loadConfig, rulesFor } from './load.js'

const config = loadConfig()
const agentRoles = agentRoleNames(config)
const mentioned = (text: string) => [...new Set(text.match(/\bhafiz_[a-z_]+\b/g) ?? [])]
const own = (role: string) => (config.rules[config.roles.roles[role]?.rules as string] ?? '').trim()
/** Host tools outside the catalogue a role's rules may name (none: tracking is the first block). */
const HOST_TOOLS: Record<string, string[]> = {}

describe('rules files', () => {
  it.each(agentRoles)('%s rules mention only tools the role has (on Kilo)', (role) => {
    const text = rulesFor(config, role)
    const has = new Set([
      ...toolsForRole(config, role, 'kilo').map((t) => t.spec.name),
      ...(HOST_TOOLS[role] ?? []),
    ])
    const all = new Set([...TOOL_SPECS.map((s) => s.name), ...Object.values(HOST_TOOLS).flat()])
    const names = mentioned(text)
    expect(names.length).toBeGreaterThan(3)
    for (const n of names) {
      expect(all.has(n), `${role}: ${n} is not a tool`).toBe(true)
      expect(has.has(n), `${role}: ${n} is not in the ${role} allowlist`).toBe(true)
    }
  })

  it.each(agentRoles)('%s rules fit their budget and carry the shared protocol', (role) => {
    expect(estimatorTokenizer.count(own(role))).toBeLessThanOrEqual(450)
    const text = rulesFor(config, role)
    for (const s of [
      '<hafiz',
      '<hafiz-floor>',
      '<hafiz-delta>',
      '<hafiz-unfiled>',
      '<hafiz-notices>',
      '[elided:',
      'hafiz_block_read',
    ])
      expect(text).toContain(s)
  })

  it('the shared rules fit their budget', () => {
    expect(estimatorTokenizer.count((config.rules[COMMON_RULES] ?? '').trim())).toBeLessThanOrEqual(
      300,
    )
  })

  it('the user role gets only its own file', () => {
    expect(rulesFor(config, 'user')).not.toContain('<hafiz-delta>')
  })

  it('the viewer is a person, not an agent: own file only, read-only', () => {
    expect(agentRoles).not.toContain('viewer')
    expect(rulesFor(config, 'viewer')).not.toContain('<hafiz-delta>')
    expect(config.roles.roles.viewer).toMatchObject({ agent: false, read_only: true })
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
  })

  it('leave tool mechanics to the descriptions: no argument names, no marker syntax', () => {
    for (const role of agentRoles) {
      const text = own(role)
      expect(text, role).not.toMatch(/hafiz:block=|expected_version|confirmed: true/)
    }
  })
})
