// Fixture A — the worked example: Shop → Auth (done), Billing → {Invoices (done), Payments
// (active)}, Reporting (planned). Payments depends on Invoices and Auth.
import { FixtureBuilder, fixtureActor } from './builder.js'

export const SHOP = {
  root: 'shop',
  auth: 'auth',
  billing: 'billing',
  invoices: 'invoices',
  payments: 'payments',
  reporting: 'reporting',
} as const

export const worker2 = fixtureActor('worker', 'worker-2')

export async function shopFixture(): Promise<FixtureBuilder> {
  const f = new FixtureBuilder()
  await f.project('Shop', SHOP.root, {
    overview:
      'Online shop for handmade goods: catalogue, checkout and back-office reporting. One TypeScript monorepo deployed as three services behind an API gateway.',
    topology: [
      'web (Next.js) → api gateway → auth, billing, reporting',
      'billing → Postgres (ledger schema); Stripe webhooks → billing',
      'reporting reads a nightly replica',
    ],
    interface: {
      provides: [
        { name: 'POST /checkout', type: 'http', notes: 'creates the invoice and charges it' },
        { name: 'GET /orders/:id', type: 'http' },
      ],
    },
    constraints: ['p95 checkout under 800 ms', 'EU data residency'],
  })
  await f.decision(SHOP.root, {
    id: 'dec-pg',
    title: 'One database',
    decision: 'One Postgres cluster, one schema per service.',
    rationale: 'One backup and restore story.',
  })
  await f.decision(SHOP.root, {
    id: 'dec-gen',
    title: 'Generated files',
    decision: 'Never commit generated files; CI regenerates them.',
    standing: 'never',
  })

  await f.block({
    id: SHOP.auth,
    parent: SHOP.root,
    title: 'Auth',
    status: 'done',
    design: {
      purpose: 'Sign-in and sessions for shoppers and staff.',
      scope: ['in: email + password, magic links, session tokens', 'out: staff SSO (later)'],
      interface: {
        provides: [
          { name: 'verifySession(token)', type: 'fn', notes: 'User | null; p95 5 ms' },
          { name: 'requireStaff()', type: 'middleware' },
        ],
      },
    },
    digest: {
      outcome:
        'Sessions are opaque 32-byte tokens in Redis with a 30-day sliding expiry; magic links go through the mailer.',
      interface_delta: ['verifySession returns roles[] on User'],
      pointers: [
        { label: 'PR #41', ref: 'github.com/shop/app/pull/41' },
        { label: 'src/auth/', ref: 'src/auth/' },
      ],
      lessons: ['Batch Redis TTL refreshes; refreshing per request doubled latency'],
    },
  })

  await f.block({
    id: SHOP.billing,
    parent: SHOP.root,
    title: 'Billing',
    status: 'active',
    design: {
      purpose: 'Turn orders into invoices and collect payment for them.',
      scope: ['in: invoices, payments', 'out: refunds (later), tax calculation (TaxJar)'],
      interface: {
        provides: [
          { name: 'createInvoice(order)', type: 'fn' },
          { name: 'invoice.paid', type: 'event', notes: 'emitted once per invoice' },
        ],
        consumes: [{ name: 'verifySession(token)', type: 'fn', notes: 'auth' }],
      },
      constraints: ['Ledger rows are append-only'],
    },
  })
  await f.decision(SHOP.billing, {
    id: 'dec-adyen',
    title: 'PSP',
    decision: 'Use Adyen.',
  })
  await f.decision(SHOP.billing, {
    id: 'dec-psp',
    title: 'PSP',
    decision: 'Use Stripe for cards and SEPA.',
    rationale: 'Only PSP covering both in every target market.',
    supersedes: 'dec-adyen',
  })
  await f.decision(SHOP.billing, {
    id: 'dec-money',
    title: 'Money',
    decision: 'Always store money as integer minor units with an ISO currency code.',
    standing: 'always',
  })

  await f.block({
    id: SHOP.invoices,
    parent: SHOP.billing,
    title: 'Invoices',
    status: 'done',
    design: {
      purpose: 'Immutable invoices with sequential numbering per legal entity.',
      scope: ['in: numbering, PDF rendering, status open | paid | void'],
      interface: {
        provides: [
          { name: 'getInvoice(id)', type: 'fn' },
          { name: 'markPaid(id, paymentId)', type: 'fn', notes: 'idempotent' },
        ],
      },
    },
    digest: {
      outcome:
        'Invoices live in billing.invoices; numbers come from a per-entity sequence; PDFs render on demand.',
      interface_delta: ['markPaid takes a paymentId'],
      pointers: [{ label: 'PR #57', ref: 'github.com/shop/app/pull/57' }],
    },
  })

  await f.block({
    id: SHOP.payments,
    parent: SHOP.billing,
    title: 'Payments',
    status: 'active',
    design: {
      purpose: 'Charge an invoice through Stripe and record the outcome.',
      scope: ['in: card and SEPA charges, webhooks, retries', 'out: refunds, disputes'],
      interface: {
        provides: [
          { name: 'chargeInvoice(invoiceId, method)', type: 'fn', notes: 'idempotent per invoice' },
          { name: 'POST /webhooks/stripe', type: 'http' },
        ],
        consumes: [
          { name: 'markPaid(id, paymentId)', type: 'fn', notes: 'invoices' },
          { name: 'verifySession(token)', type: 'fn', notes: 'auth' },
        ],
        contracts: [{ name: 'Idempotency-Key = invoiceId', notes: 'Stripe dedupes retries' }],
      },
      constraints: ['Webhook handler is idempotent'],
    },
    plan: {
      steps: [
        { id: 's1', title: 'Stripe client and config' },
        { id: 's2', title: 'chargeInvoice with idempotency key' },
        { id: 's3', title: 'Webhook handler', notes: 'payment_intent.* events only' },
        { id: 's4', title: 'Retry policy for SEPA failures' },
      ],
      acceptance: [
        'Duplicate webhook deliveries are no-ops',
        'E2E: a test card charge marks the invoice paid',
      ],
      risks: ['SEPA settles in days; the invoice stays open meanwhile'],
    },
  })
  await f.step(SHOP.payments, 's1', 'done')
  await f.step(SHOP.payments, 's2', 'doing')
  await f.step(SHOP.payments, 's2', 'done')
  await f.step(SHOP.payments, 's3', 'doing')
  await f.progress(SHOP.payments, 'done', 'Stripe client wired; keys come from env')
  await f.progress(SHOP.payments, 'done', 'chargeInvoice sends Idempotency-Key = invoiceId')
  await f.progress(
    SHOP.payments,
    'found',
    'Stripe sends payment_intent.succeeded before charge.succeeded; key off the intent',
    { refs: ['src/billing/payments/webhook.ts'] },
  )
  await f.progress(
    SHOP.payments,
    'question',
    'Should a pending SEPA debit mark the invoice processing?',
  )
  await f.decision(SHOP.payments, {
    id: 'dec-retry',
    title: 'SEPA retries',
    decision: 'Retry failed SEPA debits at most twice, three days apart.',
  })
  await f.decision(SHOP.payments, {
    id: 'dec-cards',
    title: 'Card data',
    decision: 'Never log or persist card numbers; use Stripe tokens only.',
    standing: 'never',
  })
  await f.thread(SHOP.payments, {
    id: 'thr-sepa',
    title: 'SEPA pending state',
    entries: ['Invoices has no processing status; add one or keep the invoice open until settled.'],
  })
  await f.thread(SHOP.payments, {
    id: 'thr-3ds',
    title: '3DS challenge UX',
    status: 'parked',
    gist: 'Parked until the checkout redesign; Stripe hosts the challenge page for now.',
  })

  await f.block({ id: SHOP.reporting, parent: SHOP.root, title: 'Reporting', status: 'planned' })

  await f.edge(SHOP.payments, SHOP.invoices)
  await f.edge(SHOP.payments, SHOP.auth)
  return f
}
