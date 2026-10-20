// Set one version on both publishable packages and pin the plugin's workspace dependency on the
// core to exactly that version, so `pnpm publish` rewrites it to the same number.
//   node scripts/set-version.mjs 0.2.0      (a leading "v" is accepted)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!SEMVER.test(version)) {
  console.error(
    `set-version: "${process.argv[2] ?? ''}" is not a semver version (e.g. 0.2.0 or 0.2.0-rc.1)`,
  )
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = 'hafiz-context-manager'

function update(rel, edit) {
  const file = join(root, rel)
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.version = version
  edit(pkg)
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${pkg.name}@${version}`)
}

update('packages/hafiz/package.json', () => {})
update('packages/kilo-plugin/package.json', (pkg) => {
  if (!pkg.dependencies?.[CORE]) throw new Error(`kilo-plugin has no ${CORE} dependency`)
  pkg.dependencies[CORE] = `workspace:${version}`
})
