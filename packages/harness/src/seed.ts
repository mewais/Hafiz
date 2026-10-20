// Pre-seed a project's block tree through the daemon, as the human (role `user`), so a task can
// start from a realistic multi-level tree without a model building it first.
import type { DaemonClient } from '@hafiz/gateway-mcp'
import type { SeedNode } from './tasks.js'

const design = (purpose: string) => ({
  purpose,
  scope: ['in: the behaviour described by the purpose', 'out: everything else'],
  interface: { provides: [], consumes: [] },
})
const plan = (steps: string[]) => ({
  steps: steps.map((title, i) => ({ id: `s${i + 1}`, title })),
  acceptance: ['tests pass'],
})
const digest = {
  outcome: 'Seeded as already done.',
  interface_delta: ['none'],
  pointers: [{ label: 'seed', ref: 'harness' }],
}

/** Create `nodes` under `parent`. Returns `{b.<as>}` variables: block ids by `as` name. */
export async function seedTree(
  client: DaemonClient,
  parent: string,
  nodes: readonly SeedNode[],
  vars: Record<string, string> = {},
): Promise<Record<string, string>> {
  for (const n of nodes) {
    const { result } = await client.dispatch<{ id: string }>('block.create', {
      parent,
      title: n.title,
      ...(n.kind ? { kind: n.kind } : {}),
      ...(n.purpose ? { design: design(n.purpose) } : {}),
      ...(n.steps ? { plan: plan(n.steps) } : {}),
    })
    const id = result.id
    if (n.as) vars[n.as] = id
    for (const d of n.decisions ?? [])
      await client.dispatch('decision.record', {
        block: id,
        title: d.title,
        decision: d.decision,
        ...(d.standing ? { standing: d.standing } : {}),
      })
    // top-down: activating a block activates its ancestors, so parents go first
    if (n.status === 'active' || n.status === 'done')
      await client.dispatch('block.set_status', { id, status: 'active' })
    await seedTree(client, id, n.children ?? [], vars)
    if (n.status === 'done')
      await client.dispatch('block.set_status', { id, status: 'done', digest })
  }
  return vars
}
