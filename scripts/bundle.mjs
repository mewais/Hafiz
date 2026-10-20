// Builds the two publishable packages from the tsc output of the workspace:
//   packages/hafiz        (hafiz-context-manager) -> dist/hafiz.js   one executable: CLI + daemon + MCP gateway
//   packages/kilo-plugin  (hafiz-kilo)            -> dist/index.js   the Kilo server plugin (`export default { id, server }`)
//                                                 -> dist/tui.js     the Kilo TUI plugin (`export default { id, tui }`)
// Each bundle inlines every @hafiz/* package and the npm dependencies, so a published package has
// no runtime dependencies. The default configuration (YAML + rules) is copied next to the entry.
// The repo LICENSE is copied next to each package.json (git-ignored there) so it ships in the tarball.
// Usage: node scripts/bundle.mjs [hafiz|kilo-plugin ...]   (run `tsc -b` first)
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformAsync } from '@babel/core'
import ts from '@babel/preset-typescript'
import solid from 'babel-preset-solid'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = (name) => join(root, 'packages', name)

// Some bundled CommonJS dependencies call require() on node builtins.
const cjsShim =
  "import { createRequire as __hafizCreateRequire } from 'node:module';\n" +
  'const require = __hafizCreateRequire(import.meta.url);'

// Kilo's TUI plugins are Solid components rendered by opentui. Kilo transpiles `.tsx` itself
// only outside node_modules, so a published plugin ships compiled JS: Solid's universal JSX
// transform against `@opentui/solid` (what Kilo's own runtime transform does), with `solid-js`
// and `@opentui/*` left as imports; Kilo's runtime plugin maps those onto its own instances.
const solidTsx = {
  name: 'solid-tsx',
  setup(b) {
    b.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const { readFile } = await import('node:fs/promises')
      const out = await transformAsync(await readFile(args.path, 'utf8'), {
        filename: args.path,
        configFile: false,
        babelrc: false,
        presets: [[solid, { moduleName: '@opentui/solid', generate: 'universal' }], [ts]],
      })
      return { contents: out?.code ?? '', loader: 'js' }
    })
  },
}
const TUI_EXTERNAL = ['solid-js', 'solid-js/*', '@opentui/*']

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
    also: [
      {
        entry: join(pkg('host-kilo'), 'src', 'tui', 'plugin.tsx'),
        outfile: join(pkg('kilo-plugin'), 'dist', 'tui.js'),
        external: TUI_EXTERNAL,
        plugins: [solidTsx],
      },
    ],
  },
}

const wanted = process.argv.slice(2)
for (const name of wanted.length ? wanted : Object.keys(targets)) {
  const t = targets[name]
  if (!t) throw new Error(`unknown bundle '${name}' (${Object.keys(targets).join(', ')})`)
  const dist = dirname(t.outfile)
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })
  for (const e of [t, ...(t.also ?? [])])
    await build({
      entryPoints: [e.entry],
      outfile: e.outfile,
      bundle: true,
      platform: 'node',
      // Prefer ES module entries: some dependencies (jsonc-parser) ship a UMD main that bundlers cannot follow.
      mainFields: ['module', 'main'],
      format: 'esm',
      target: 'node22',
      banner: { js: t.banner },
      external: e.external ?? [],
      plugins: e.plugins ?? [],
      // Not minified: readable in a stack trace, and the published size is not a concern.
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'warning',
    })
  cpSync(join(pkg('core'), 'config', 'default'), join(dist, 'config', 'default'), {
    recursive: true,
  })
  copyFileSync(join(root, 'LICENSE'), join(dirname(dist), 'LICENSE'))
  if (t.executable) chmodSync(t.outfile, 0o755)
  console.log(`bundled ${name} -> ${t.outfile}`)
}
