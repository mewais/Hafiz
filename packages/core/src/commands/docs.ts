// Doc commands (§5.1): full write and section patch, validated against the kind's schema, CAS.

import { ValidationError } from '../domain/errors.js'
import type { Actor, Block, BlockId, Doc, DocType, SectionValue } from '../domain/types.js'
import { authorize } from './authz.js'
import { type CommandResult, type CoreContext, isMinor, mustBlock, runAs, writeDoc } from './tx.js'

export interface DocWriteArgs {
  block: BlockId
  type: DocType
  sections: Record<string, SectionValue>
  expectedVersion?: number
  /**
   * Refuse a write to an existing document without `expectedVersion` (the agent tool sets it, so
   * an agent never overwrites a document it has not seen). CLI and system writes leave it off.
   */
  requireVersion?: boolean
  /** doc.patch only: a missing document is created (needs the doc.write grant too). */
  create?: boolean
}

function checkVersioned(b: Block, args: DocWriteArgs): void {
  const cur = b.docVersions[args.type]
  if (!args.requireVersion || args.expectedVersion !== undefined || !cur) return
  throw new ValidationError(
    `the ${args.type} of ${b.id} already exists (version ${cur}): pass expected_version: ${cur} if you have read it, else read it first and merge.`,
    { current: cur },
  )
}

const specOf = (ctx: CoreContext, command: string, args: DocWriteArgs) => ({
  command,
  qualifier: args.type,
  major: !isMinor(ctx, args.type),
  target: `${args.block}/${args.type}`,
})

export async function docWrite(
  ctx: CoreContext,
  by: Actor,
  args: DocWriteArgs,
): Promise<CommandResult<Doc>> {
  return runAs(ctx, by, specOf(ctx, 'doc.write', args), async (t, notices) => {
    const b = await mustBlock(t, args.block)
    checkVersioned(b, args)
    return writeDoc(ctx, t, by, b, args.type, args.sections, args.expectedVersion, notices)
  })
}

export async function docPatch(
  ctx: CoreContext,
  by: Actor,
  args: DocWriteArgs,
): Promise<CommandResult<Doc>> {
  return runAs(ctx, by, specOf(ctx, 'doc.patch', args), async (t, notices) => {
    const b = await mustBlock(t, args.block)
    checkVersioned(b, args)
    const cur = await t.getDoc(b.id, args.type)
    if (!cur && args.create) authorize(ctx.config, by.role, 'doc.write', args.type)
    else if (!cur)
      throw new ValidationError(
        `no ${args.type} on ${b.id} yet; the ${args.type === 'design' ? 'designer' : args.type === 'plan' ? 'planner' : 'worker'} writes it, or use doc.write`,
      )
    const merged = { ...(cur?.sections ?? {}), ...args.sections }
    return writeDoc(ctx, t, by, b, args.type, merged, args.expectedVersion, notices)
  })
}
