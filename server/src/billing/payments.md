# Payment gateway foundation

`PaymentGateway` is the provider-neutral boundary for billing payments. The
current implementation contains a test-only `PaystackGateway` adapter and a
network-free `MockPaystackGateway`; no application route creates or activates a
subscription yet.

## Paystack assumptions

- Transaction initialization uses `POST /transaction/initialize` with the
  server-calculated smallest-unit amount, currency, customer email, and a
  server-generated provider reference. Paystack references use only
  alphanumeric characters, hyphens, periods, and equals signs. Internal Rota
  operation IDs are separate values and must not be passed as provider
  references when they contain unsupported punctuation.
- Verification uses `GET /transaction/verify/:reference`. A result is trusted
  only when Paystack reports `status: success` and the reference, amount,
  currency, and provider transaction ID all match the server's expected values.
- The adapter accepts only `sk_test_` keys and defaults to
  `https://api.paystack.co`. Live keys are rejected by construction.
- Returned checkout URLs are accepted only from Paystack's HTTPS checkout
  origin, `https://checkout.paystack.com`, and optional server-supplied
  metadata is matched again during verification.
- `MockPaystackGateway` detects repeated references in memory for deterministic
  tests. An initialized mock payment is pending until a test explicitly
  simulates success; it never treats initialization as payment.
- `PaystackGateway` does not provide durable idempotency by itself. Before
  calling it, a future billing service must atomically reserve the idempotency
  key, request hash, and unique provider reference in PostgreSQL. A repeated
  key with the same request data must return the existing operation; a
  conflicting payload must return HTTP 409. This milestone intentionally adds
  no database access to the adapter.
- The Paystack USD minimum is 200 cents (USD 2.00). Rota must defer or
  accumulate a sub-minimum charge until it can be billed safely. It must not
  round the amount upward or mark an unpaid invoice as paid.

Paystack's subscription APIs create provider-managed plans and recurring
charges. They do not replace Rota's authoritative seat-count calculations or
custom upgrade/downgrade proration. Rota should calculate the amount and cycle
state, then use provider subscriptions only where their plan and account
currency capabilities match the already-calculated contract.

Paystack currency availability and recurring billing eligibility depend on the
Paystack account and market. The exact USD recurring setup must be confirmed in
the Paystack test dashboard before activation; this foundation does not claim
that every account can create USD subscriptions. The current pricing engine is
USD integer cents, so currency conversion or local-currency billing is outside
this milestone.

## Later webhook activation

Initialization creates only a pending payment operation. A browser redirect,
mobile callback, or client-provided success claim must never activate a
subscription. The webhook intake verifies the Paystack signature, parses the
authenticated raw bytes, and durably records the event before acknowledging it.
A later webhook worker should verify the transaction where appropriate and
atomically transition the persisted billing operation and subscription. The
webhook event, not the redirect, becomes the authoritative activation signal.

Webhook ingestion deduplicates the exact serialized event using the event type
and SHA-256 hash of the raw body. Two differently serialized payloads concerning
the same transaction can therefore create distinct ingestion records. Future
worker-side financial idempotency must instead use the provider transaction ID
or reference together with unique billing and ledger constraints. This task
does not implement worker processing, payment verification, activation, or
ledger posting.
