import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const bin = join(root, 'packages/hafiz/dist/hafiz.js')
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))

beforeAll(() => {
  // Bundles from the tsc output; `pnpm build` has produced it by the time tests run.
  execFileSync(process.execPath, [join(root, 'scripts/bundle.mjs'), 'hafiz'], { stdio: 'pipe' })
}, 60_000)

describe('published bundle: hafiz', () => {
  it('is a single executable with no @hafiz imports left and the default config beside it', () => {
    const text = readFileSync(bin, 'utf8')
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true)
    const specifiers = [...text.matchAll(/^import .*? from "([^"]+)"/gm)].map((m) => m[1])
    expect(specifiers.filter((s) => !s?.startsWith('node:'))).toEqual([])
    expect(existsSync(join(root, 'packages/hafiz/dist/config/default/hafiz.yaml'))).toBe(true)
  })

  it('runs init, sqlite stores, doctor, install and a daemon-backed command from the bundle', async () => {
    const repo = tmp('hafiz-bundle-repo-')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const env = {
      ...process.env,
      HAFIZ_STORE_ROOT: tmp('hafiz-bundle-stores-'),
      HAFIZ_HOME: tmp('hafiz-bundle-home-'),
      HOME: tmp('hafiz-bundle-userhome-'),
      XDG_RUNTIME_DIR: tmp('hafiz-bundle-rt-'),
    }
    const hafiz = (...args: string[]) =>
      execFileSync(process.execPath, [bin, ...args], { cwd: repo, env, encoding: 'utf8' })

    expect(hafiz('--help')).toContain('usage: hafiz <command>')
    expect(hafiz('init', 'Shop', '--backend', 'sqlite')).toContain('initialised project')
    expect(hafiz('tree')).toMatch(/\[active\] shop-\w+ — Shop \(root\)/)
    expect(hafiz('install', 'kilo')).toContain('installed hafiz-kilo')
    expect(hafiz('doctor')).toContain('clean (sqlite backend)')

    const daemon = spawn(process.execPath, [bin, 'daemon', '--project', repo], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    try {
      await new Promise<void>((resolve, reject) => {
        daemon.stderr.on('data', (d: Buffer) => d.toString().includes('listening') && resolve())
        daemon.once('exit', (c) => reject(new Error(`daemon exited ${c}`)))
      })
      expect(hafiz('direct', 'Never touch the ledger.', '--kind', 'never')).toContain(
        'recorded standing decision',
      )
      expect(hafiz('doctor')).toMatch(/ok\s+daemon\s+pid \d+ answers/)
      expect(hafiz('status')).toContain('sessions:')
    } finally {
      daemon.kill('SIGTERM')
    }
  }, 60_000)
})
