// Hermetic test environment: point every user-level path Hafiz reads at a fresh empty temp dir so a
// developer's real ~/.hafiz, ~/.config/kilo, or runtime dir can never leak into a run. Values already
// in the outer environment are deliberately overwritten (even an exported HAFIZ_HOME), so the suite is
// hermetic wherever it runs. Tests that set these vars themselves in a spawned env still win. Workers
// and the child processes they spawn (daemon, CLI, bundle tests) inherit this env.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function setup(): () => void {
  // Short root: unix socket paths under XDG_RUNTIME_DIR are length-limited.
  const root = mkdtempSync(join(tmpdir(), 'hfz-'))
  const isolate = (name: string, sub: string): void => {
    const dir = join(root, sub)
    mkdirSync(dir, { recursive: true })
    process.env[name] = dir
  }
  isolate('HAFIZ_HOME', 'home')
  isolate('HAFIZ_STORE_ROOT', 'stores')
  isolate('XDG_CONFIG_HOME', 'xdg-config')
  isolate('XDG_RUNTIME_DIR', 'rt')
  return () => rmSync(root, { recursive: true, force: true })
}
