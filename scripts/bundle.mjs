// Builds the two publishable packages from the tsc output of the workspace:
//   packages/hafiz        -> dist/hafiz.js        one executable: CLI + daemon + MCP gateway
//   packages/kilo-plugin  -> dist/index.js        the Kilo plugin (`export default { id, server }`)
// Each bundle inlines every @hafiz/* package and the npm dependencies, so a published package has
// no runtime dependencies. The default configuration (YAML + rules) is copied next to the entry.
// Usage: node scripts/bundle.mjs [hafiz|kilo-plugin ...]   (run `tsc -b` first)
import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = (name) => join(root, 'packages', name)

// Some bundled CommonJS dependencies call require() on node builtins.
const cjsShim =
  "import { createRequire as __hafizCreateRequire } from 'node:module';\n" +
  'const require = __hafizCreateRequire(import.meta.url);'

const targets = {
  hafiz: {
    entry: join(pkg('cli'), 'src', 'bin.ts'),
    outfile: join(pkg('hafiz'), 'dist', 'hafiz.js'),
    banner: cjsShim, // bin.ts carries the shebang; esbuild keeps it on the first line
    executable: true,
  },
  'kilo-plugin': {
    entry: join(pkg('host-kilo'), 'src', 'index.ts'),
    outfile: join(pkg('kilo-plugin'), 'dist', 'index.js'),
    banner: cjsShim,
  },
}

const wanted = process.argv.slice(2)
for (const name of wanted.length ? wanted : Object.keys(targets)) {
  const t = targets[name]
  if (!t) throw new Error(`unknown bundle '${name}' (${Object.keys(targets).join(', ')})`)
  const dist = dirname(t.outfile)
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })
  await build({
    entryPoints: [t.entry],
    outfile: t.outfile,
    bundle: true,
    platform: 'node',
    // Prefer ES module entries: some dependencies (jsonc-parser) ship a UMD main that bundlers cannot follow.
    mainFields: ['module', 'main'],
    format: 'esm',
    target: 'node22',
    banner: { js: t.banner },
    // Not minified: readable in a stack trace, and the published size is not a concern.
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  })
  cpSync(join(pkg('core'), 'config', 'default'), join(dist, 'config', 'default'), {
    recursive: true,
  })
  if (t.executable) chmodSync(t.outfile, 0o755)
  console.log(`bundled ${name} -> ${t.outfile}`)
}
