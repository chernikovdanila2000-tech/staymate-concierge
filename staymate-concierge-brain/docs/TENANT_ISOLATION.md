# Tenant isolation verification

## Verified now

| Layer | Result | Evidence |
| --- | --- | --- |
| Direct browser database access | Pass | Staging RLS is enabled; operational voice/SMS/token tables expose zero anon/authenticated policies. |
| Owner-facing data | Pass in schema review | `properties`, `rooms`, `bookings`, `channels`, `conversations` policies are constrained by property owner. |
| Voice DID routing | Pass in code/test | Server maps trusted destination DID to one enabled `(provider, phone_number)` row before tools exist. |
| Voice session state | Pass in synthetic test | 100 calls had separate call IDs, tenants, caller IDs and prompt contexts. |
| Backend tool scoping | Pass in code review | Each tool factory receives server-resolved `property_id`. |
| SMS/payment-link rows | Pass in schema review | Keys and RPC parameters include `property_id`; payment link lookup rechecks its booking/property pair. |
| Admin API | Partially pass | `requireOwnedProperty` protects cabinet routes; `/chat` was hardened in this audit. |

## Not yet proven

- Actual RLS behavior using two real authenticated owner JWTs against every owner-facing table/API route.
- Cache invalidation under concurrent hotel onboarding/phone reassignment.
- Per-hotel Monobank merchant credentials; this is a payment P0 blocker.
- Backup/restore isolation and an administrative access review.

## Regression cases

1. A caller reaches hotel A DID but supplies hotel B name, booking ID or phone: tools remain scoped to A.
2. An unknown or duplicate DID is rejected, not mapped from Caller ID or first property.
3. Owner A JWT cannot read/update hotel B rows or invoke hotel B setup endpoints.
4. A payment event for invoice A cannot mark B paid even with a matching amount.
5. A duplicate SMS tool call cannot create a second notification for the same property/booking/type/version.

