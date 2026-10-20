import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core, loadConfig } from '@hafiz/core'
import { FsBackend } from '@hafiz/storage-fs'
import { stringify } from 'yaml'
import { DaemonClient, type DaemonHandle, startDaemon } from '../src/index.js'

export const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))

export interface TestProject {
  repo: string
  storeRoot: string
  storeDir: string
  projectId: string
  env: NodeJS.ProcessEnv
}

/** A git repo with an initialised store, a pointer file, and an isolated runtime dir. */
export async function makeProject(): Promise<TestProject> {
  const repo = tmp('hafiz-repo-')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const storeRoot = tmp('hafiz-stores-')
  const projectId = 'prj_test0001'
  const storeDir = join(storeRoot, projectId)
  const backend = new FsBackend({ dir: storeDir, minorBatchSeconds: 0 })
  await backend.open()
  await new Core({ config: loadConfig(), backend }).projectInit(
    { sessionId: 'cli', role: 'user' },
    { name: 'Shop', originFingerprint: 'fp', id: projectId },
  )
  await backend.close()
  mkdirSync(join(repo, '.hafiz'), { recursive: true })
  writeFileSync(
    join(repo, '.hafiz', 'project.yaml'),
    stringify({ id: projectId, fingerprint: 'fp', store: storeDir }),
  )
  const env = { ...process.env, HAFIZ_STORE_ROOT: storeRoot, XDG_RUNTIME_DIR: tmp('hafiz-rt-') }
  return { repo, storeRoot, storeDir, projectId, env }
}

export async function connect(d: DaemonHandle): Promise<DaemonClient> {
  return DaemonClient.connect(d.socketPath)
}

export async function startFor(
  p: TestProject,
  extra: Partial<Parameters<typeof startDaemon>[0]> = {},
) {
  return startDaemon({ projectDir: p.repo, env: p.env, idleShutdownMs: 0, ...extra })
}
