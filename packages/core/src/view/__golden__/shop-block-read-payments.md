<!-- FULL -->
# Payments [payments] active
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

<!-- DESIGN -->
# Payments [payments] active
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
Decisions:
- SEPA retries: Retry failed SEPA debits at most twice, three days apart. `dec-retry`

<!-- INTERFACE -->
# Payments [payments] active
Depends on: auth, invoices
Interface:
- provides `chargeInvoice(invoiceId, method)` (fn) — idempotent per invoice
- provides `POST /webhooks/stripe` (http)
- consumes `markPaid(id, paymentId)` (fn) — invoices
- consumes `verifySession(token)` (fn) — auth
- contract `Idempotency-Key = invoiceId` — Stripe dedupes retries
Status: 2/4 steps done · doing s3 Webhook handler · 1 open thread

<!-- DIGEST -->
# Payments [payments] active
Depends on: auth, invoices
Interface:
- provides `chargeInvoice(invoiceId, method)` (fn) — idempotent per invoice
- provides `POST /webhooks/stripe` (http)
- consumes `markPaid(id, paymentId)` (fn) — invoices
- consumes `verifySession(token)` (fn) — auth
- contract `Idempotency-Key = invoiceId` — Stripe dedupes retries

<!-- LINE -->
# Payments [payments] active

<!-- NONE -->
# Payments [payments] active
