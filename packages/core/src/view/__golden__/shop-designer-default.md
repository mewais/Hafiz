<hafiz hash="a19acbb686ab" role="designer">
# Shop [shop] active
Overview: Online shop for handmade goods: catalogue, checkout and back-office reporting. One TypeScript monorepo deployed as three services behind an API gateway.
Topology:
- web (Next.js) → api gateway → auth, billing, reporting
- billing → Postgres (ledger schema); Stripe webhooks → billing
- reporting reads a nightly replica
Interface:
- provides `POST /checkout` (http) — creates the invoice and charges it
- provides `GET /orders/:id` (http)
Constraints:
- p95 checkout under 800 ms
- EU data residency
Decisions:
- One database: One Postgres cluster, one schema per service. Why: One backup and restore story. `dec-pg`

## Auth [auth] done · dependency
Outcome: Sessions are opaque 32-byte tokens in Redis with a 30-day sliding expiry; magic links go through the mailer.
Interface delta: verifySession returns roles[] on User
Pointers: PR #41 (github.com/shop/app/pull/41); src/auth/
Lessons: Batch Redis TTL refreshes; refreshing per request doubled latency
Interface:
- provides `verifySession(token)` (fn) — User | null; p95 5 ms
- provides `requireStaff()` (middleware)

## Billing [billing] active · focus
Purpose: Turn orders into invoices and collect payment for them.
Scope:
- in: invoices, payments
- out: refunds (later), tax calculation (TaxJar)
Interface:
- provides `createInvoice(order)` (fn)
- provides `invoice.paid` (event) — emitted once per invoice
- consumes `verifySession(token)` (fn) — auth
Constraints: Ledger rows are append-only
Decisions:
- PSP: Use Stripe for cards and SEPA. Why: Only PSP covering both in every target market. `dec-psp`

### Invoices [invoices] done · dependency
Outcome: Invoices live in billing.invoices; numbers come from a per-entity sequence; PDFs render on demand.
Interface delta: markPaid takes a paymentId
Pointers: PR #57 (github.com/shop/app/pull/57)
Interface:
- provides `getInvoice(id)` (fn)
- provides `markPaid(id, paymentId)` (fn) — idempotent

### Payments [payments] active · focus
Depends on: auth, invoices
Purpose: Charge an invoice through Stripe and record the outcome.
Scope:
- in: card and SEPA charges, webhooks, retries
- out: refunds, disputes
Interface:
- provides `chargeInvoice(invoiceId, method)` (fn) — idempotent per invoice
- provides `POST /webhooks/stripe` (http)
- consumes `markPaid(id, paymentId)` (fn) — invoices
- consumes `verifySession(token)` (fn) — auth
- contract `Idempotency-Key = invoiceId` — Stripe dedupes retries
Constraints: Webhook handler is idempotent
Steps:
- [x] s1 Stripe client and config
- [x] s2 chargeInvoice with idempotency key
- [~] s3 Webhook handler — payment_intent.* events only
- [ ] s4 Retry policy for SEPA failures
Acceptance:
- Duplicate webhook deliveries are no-ops
- E2E: a test card charge marks the invoice paid
Risks: SEPA settles in days; the invoice stays open meanwhile
Decisions:
- SEPA retries: Retry failed SEPA debits at most twice, three days apart. `dec-retry`
Progress:
- done: Stripe client wired; keys come from env
- done: chargeInvoice sends Idempotency-Key = invoiceId
- found: Stripe sends payment_intent.succeeded before charge.succeeded; key off the intent [src/billing/payments/webhook.ts]
- question: Should a pending SEPA debit mark the invoice processing?
Open threads:
- SEPA pending state `thr-sepa`: Invoices has no processing status; add one or keep the invoice open until settled.
Parked threads: 3DS challenge UX `thr-3ds`

## Reporting [reporting] planned · needs design
</hafiz>

<hafiz-floor>
Standing decisions (always apply):
- Never commit generated files; CI regenerates them. (shop · dec-gen)
- Always store money as integer minor units with an ISO currency code. (billing · dec-money)
- Never log or persist card numbers; use Stripe tokens only. (payments · dec-cards)
</hafiz-floor>

<!-- manifest
budget 24000 · view 865 tokens · floor 62 tokens
shop                         root       DESIGN    162
auth                         dependency DIGEST    114
billing                      focus      FULL      123
invoices                     dependency DIGEST    85
payments                     focus      FULL      368
reporting                    sibling    LINE      12
-->
