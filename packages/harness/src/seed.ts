// Pre-seed a project's block tree through the daemon, as the human (role `user`), so a task can
// start from a realistic multi-level tree without a model building it first. Designs and plans
// are the task's own sections (validated by Core against the block kind's schema), so a seeded
// tree reads like one a designer and a planner wrote: the consumes entries derive the edges.
import type { DaemonClient } from '@hafiz/gateway-mcp'
import type { SeedNode } from './tasks.js'

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
      ...(n.design ? { design: n.design } : {}),
      ...(n.plan ? { plan: n.plan } : {}),
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
