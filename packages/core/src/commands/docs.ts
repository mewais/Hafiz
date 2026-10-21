// Doc commands (§5.1): full write and section patch, validated against the kind's schema, CAS.

import type { Actor, BlockId, Doc, DocType, SectionValue } from '../domain/types.js'
import { type CommandResult, type CoreContext, isMinor, mustBlock, runAs, writeDoc } from './tx.js'

export interface DocWriteArgs {
  block: BlockId
  type: DocType
  sections: Record<string, SectionValue>
  expectedVersion?: number
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
    const cur = await t.getDoc(b.id, args.type)
    const merged = { ...(cur?.sections ?? {}), ...args.sections }
    return writeDoc(ctx, t, by, b, args.type, merged, args.expectedVersion, notices)
  })
}
