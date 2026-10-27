# Webhook Worker

Run the worker independently with `npm run dev:worker` during development or
`npm run start:worker` from the production build. The HTTP server does not
start this worker and webhook intake does not dispatch events inline.

The executable worker currently refuses to start because the approved
payment-reconciliation processor is not implemented yet. It refuses before
the legacy lease inspection and before any queue claim, so genuine Paystack
events remain durably `RECEIVED` with their original attempt count. This is
intentional until Task 5D.3 supplies the processor for payment verification,
subscription reconciliation, and ledger posting.

Tests may inject a synthetic `WebhookEventProcessor` into `WebhookWorker` to
exercise claiming, leases, retries, fencing, and restart recovery without
financial side effects.
