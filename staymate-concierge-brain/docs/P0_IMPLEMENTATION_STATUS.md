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

## Deployment safety blocker

The Supabase dashboard identifies project `nyknlyufbwjodbpyehtv` as `main PRODUCTION`, and its branch selector currently lists only `main`. Therefore it cannot be treated as staging. No further migration, database concurrency test, merchant credential setup, or deployment may be run until Railway staging is connected to a separately identified non-production Supabase project (or a separately labelled Supabase branch).

An earlier SQL operation was mistakenly submitted there before this mismatch was visible. It added the new empty payment tables, nullable payment metadata columns and server-only RPCs; it did not delete existing data or send money/SMS. No rollback was run, because that would be an additional production mutation. This must be reviewed under a dedicated production change procedure.

## Remaining P0

1. Establish and verify a separate staging database reference in Railway, including a backup/restore check.
2. Apply `payment-ledger-migration.sql` only there and run real concurrent RPC testing against isolated synthetic property data.
3. Register a dedicated test Monobank merchant via the authorised owner flow; do not reuse another hotel's merchant token.
4. Select and authorize the first external PMS, then implement its concrete adapter and prove hold/confirm/release/error compensation.
