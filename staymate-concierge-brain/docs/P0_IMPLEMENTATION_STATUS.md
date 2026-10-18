# P0 implementation status — 2026-10-18

## Implemented in commit `e742f86`

- Per-property Monobank acquiring configuration: `payment_merchants` stores an AES-256-GCM credential envelope only. The encryption key remains a server environment variable; browser roles have no table access.
- A booking hold is bound to exactly one merchant before invoice creation. The voice tool never accepts a merchant identifier or token from caller/model input.
- Invoice validity is now aligned to the 15-minute booking hold. A retry of an existing valid booking does not create a second invoice.
- `payment_events` is an idempotent, immutable event ledger keyed by a settlement-relevant digest. The atomic RPC verifies property, booking, merchant, invoice, amount and UAH before state transition.
- A payment after an expired hold becomes `REQUIRES_REVIEW`, not an automatic confirmed booking.
- Reconciliation uses Monobank's invoice-status endpoint and writes through the same matching/ledger path. It is disabled by default until a tenant merchant credential is configured.
- An explicit inventory adapter contract exists, with a local Supabase adapter and a tenant-isolated external-PMS mock. No real third-party PMS is claimed or configured.

## Tests

`node --test --test-force-exit test\\*.test.js`: 101 passed, 0 failed.

This covers unit-level invoice-status, event-key/idempotency argument binding, merchant-independent matching and inventory adapter isolation. It does not prove a real Monobank invoice, webhook, reconciliation or external PMS transaction because no staging merchant token/PMS access is configured.

## Deployment safety blocker — verified by active connections

The `main / PRODUCTION` label alone is not evidence about an application's traffic. The actual Railway service configuration was compared instead: both `voice-realtime-test` and `production` use the same Supabase API project ref, `nyknlyufbwjodbpyehtv`. This is a shared database, so it is not safe for isolated staging migrations or synthetic concurrency data.

The earlier payment-ledger SQL operation therefore landed in this shared database. It added the new empty payment tables, nullable payment metadata columns and server-only RPCs; it did not delete existing data or send money/SMS. No rollback was run, because that would be another change to the shared database. Review it under a production change procedure.

## Remaining P0

1. Establish and verify a separate staging database reference in Railway, including a backup/restore check.
2. Apply `payment-ledger-migration.sql` only there and run real concurrent RPC testing against isolated synthetic property data.
3. Register a dedicated test Monobank merchant via the authorised owner flow; do not reuse another hotel's merchant token.
4. Select and authorize the first external PMS, then implement its concrete adapter and prove hold/confirm/release/error compensation.
