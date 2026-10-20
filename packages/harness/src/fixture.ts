// The toy repo every task runs against: a small but real TypeScript shop library (money, cart,
// inventory, orders) with node:test tests. `money.ts` ships with one deliberate bug (task S fixes
// it): formatMoney(5) prints "$0.5". Plain Node 22 runs the tests (type stripping, no build).
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const FIXTURE_NAME = 'Toy Shop'

/** The buggy line and its fix, so scripts and checks agree on them. */
export const MONEY_BUG = {
  file: 'src/money.ts',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text of the fixture
  broken: 'return `$${whole}.${frac}`',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text of the fixture
  fixed: "return `$${whole}.${String(frac).padStart(2, '0')}`",
}

export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify(
    {
      name: 'toy-shop',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: { test: 'node --experimental-strip-types --test test/*.test.ts' },
    },
    null,
    2,
  )}\n`,
  '.gitignore': 'node_modules/\n.hafiz-cache/\n',
  'README.md':
    '# Toy Shop\n\nA tiny shop library used as a test subject. `npm test` runs the tests.\n',
  'src/money.ts': `// Money is integer cents everywhere; this is the only place that formats it.
export function formatMoney(cents: number): string {
  const whole = Math.floor(cents / 100)
  const frac = cents % 100
  ${MONEY_BUG.broken}
}

export function addMoney(a: number, b: number): number {
  return a + b
}
`,
  'src/inventory.ts': `export class Inventory {
  private stock = new Map<string, number>()

  set(sku: string, qty: number): void {
    this.stock.set(sku, qty)
  }

  available(sku: string): number {
    return this.stock.get(sku) ?? 0
  }

  take(sku: string, qty: number): void {
    if (this.available(sku) < qty) throw new Error(\`insufficient stock for \${sku}\`)
    this.stock.set(sku, this.available(sku) - qty)
  }
}
`,
  'src/cart.ts': `import { addMoney } from './money.ts'

export interface Line {
  sku: string
  unitCents: number
  qty: number
}

export class Cart {
  readonly lines: Line[] = []

  add(sku: string, unitCents: number, qty = 1): void {
    const have = this.lines.find((l) => l.sku === sku)
    if (have) have.qty += qty
    else this.lines.push({ sku, unitCents, qty })
  }

  remove(sku: string): void {
    const i = this.lines.findIndex((l) => l.sku === sku)
    if (i >= 0) this.lines.splice(i, 1)
  }

  totalCents(): number {
    return this.lines.reduce((sum, l) => addMoney(sum, l.unitCents * l.qty), 0)
  }
}
`,
  'src/orders.ts': `import type { Cart } from './cart.ts'
import type { Inventory } from './inventory.ts'

export interface Order {
  id: number
  totalCents: number
  skus: string[]
}

export class Orders {
  private next = 1
  readonly placed: Order[] = []

  private readonly inventory: Inventory

  constructor(inventory: Inventory) {
    this.inventory = inventory
  }

  place(cart: Cart): Order {
    for (const l of cart.lines) this.inventory.take(l.sku, l.qty)
    const order = { id: this.next++, totalCents: cart.totalCents(), skus: cart.lines.map((l) => l.sku) }
    this.placed.push(order)
    return order
  }
}
`,
  'src/index.ts': `export * from './cart.ts'
export * from './inventory.ts'
export * from './money.ts'
export * from './orders.ts'
`,
  'test/money.test.ts': `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addMoney, formatMoney } from '../src/money.ts'

test('formats whole and fractional amounts', () => {
  assert.equal(formatMoney(1250), '$12.50')
  assert.equal(formatMoney(100), '$1.00')
})

test('pads single-digit cents', () => {
  assert.equal(formatMoney(5), '$0.05')
  assert.equal(formatMoney(1205), '$12.05')
})

test('adds cents', () => {
  assert.equal(addMoney(250, 75), 325)
})
`,
  'test/cart.test.ts': `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Cart } from '../src/cart.ts'

test('totals lines', () => {
  const c = new Cart()
  c.add('tea', 450, 2)
  c.add('mug', 1200)
  assert.equal(c.totalCents(), 2100)
})

test('adding the same sku merges lines; remove drops it', () => {
  const c = new Cart()
  c.add('tea', 450)
  c.add('tea', 450)
  assert.equal(c.lines.length, 1)
  c.remove('tea')
  assert.equal(c.totalCents(), 0)
})
`,
  'test/orders.test.ts': `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Cart } from '../src/cart.ts'
import { Inventory } from '../src/inventory.ts'
import { Orders } from '../src/orders.ts'

test('placing an order takes stock', () => {
  const inv = new Inventory()
  inv.set('tea', 3)
  const cart = new Cart()
  cart.add('tea', 450, 2)
  const order = new Orders(inv).place(cart)
  assert.equal(order.totalCents, 900)
  assert.equal(inv.available('tea'), 1)
})

test('refuses an order without stock', () => {
  const cart = new Cart()
  cart.add('tea', 450)
  assert.throws(() => new Orders(new Inventory()).place(cart), /insufficient stock/)
})
`,
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.email=harness@hafiz.local', '-c', 'user.name=harness', ...args],
    {
      cwd,
      stdio: 'ignore',
    },
  )

/** Write the fixture into `dir` and make it a git repo with one commit. */
export function writeFixture(dir: string): void {
  for (const [path, content] of Object.entries(FIXTURE_FILES)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'toy shop')
}
