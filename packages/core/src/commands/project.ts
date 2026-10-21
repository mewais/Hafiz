// Project-level writes: initialisation and schema migration. Both are CLI-only system writes
// (no session exists yet, or the user runs the migration), never agent tools.

import { ValidationError } from '../domain/errors.js'
import { opaqueId, slugId } from '../domain/ids.js'
import {
  type Actor,
  type Block,
  type BlockId,
  DOC_TYPES,
  type Doc,
  type DocType,
  type Project,
  type SectionValue,
} from '../domain/types.js'
import { type CommandResult, type CoreContext, mustBlock, runSystem, writeDoc } from './tx.js'

export interface ProjectInitArgs {
  name: string
  originFingerprint: string
  rootDesign?: Record<string, SectionValue>
  id?: string
  /** The repo already has code: the designer describes it before new work (onboarding). */
  onboarding?: boolean
}

export async function projectInit(
  ctx: CoreContext,
  by: Actor,
  args: ProjectInitArgs,
): Promise<CommandResult<{ project: Project; root: Block }>> {
  const spec = { command: 'project.init', major: true, target: 'project' }
  return runSystem(ctx, by, spec, async (t, notices) => {
    if (await t.getProject()) throw new ValidationError('project already initialised')
    const now = ctx.clock.now()
    const root: Block = {
      id: slugId(args.name),
      parentId: null,
      title: args.name,
      kind: 'root',
      status: 'active',
      order: 0,
      version: 0,
      docVersions: { design: 0, plan: 0, digest: 0 },
      createdAt: now,
      updatedAt: now,
    }
    await t.putBlock(root, -1)
    const project: Project = {
      id: args.id ?? opaqueId('prj', 4),
      name: args.name,
      originFingerprint: args.originFingerprint,
      rootBlockId: root.id,
      schemaSetVersion: ctx.config.hafiz.schema_version,
      epoch: 0,
      ...(args.onboarding ? { onboarding: 'pending' as const } : {}),
      createdAt: now,
    }
    await t.putProject(project)
    if (args.rootDesign) await writeDoc(ctx, t, by, root, 'design', args.rootDesign, 0, notices)
    return { project, root }
  })
}

export interface SchemaMigrateArgs {
  to: string
  docs: Array<{ block: BlockId; type: DocType; sections: Record<string, SectionValue> }>
}

/** Apply a planned schema migration atomically: rewrite the docs, then re-pin the project. */
export async function schemaMigrate(
  ctx: CoreContext,
  by: Actor,
  args: SchemaMigrateArgs,
): Promise<CommandResult<{ migrated: number }>> {
  const spec = {
    command: 'schema.migrate',
    major: true,
    target: 'project',
    message: `hafiz: migrate schema set to version ${args.to}`,
  }
  return runSystem(ctx, by, spec, async (t, notices) => {
    const project = await t.getProject()
    if (!project) throw new ValidationError('project not initialised')
    for (const d of args.docs) {
      const b = await mustBlock(t, d.block)
      await writeDoc(ctx, t, by, b, d.type, d.sections, undefined, notices)
    }
    await t.putProject({ ...project, schemaSetVersion: args.to })
    return { migrated: args.docs.length }
  })
}

/** Every stored doc (current versions), for migration planning and doctor checks. */
export async function allDocs(ctx: CoreContext): Promise<{ blocks: Block[]; docs: Doc[] }> {
  const blocks = await ctx.backend.read.listBlocks()
  const docs: Doc[] = []
  for (const b of blocks)
    for (const type of DOC_TYPES) {
      const d = await ctx.backend.read.getDoc(b.id, type)
      if (d) docs.push(d)
    }
  return { blocks, docs }
}
