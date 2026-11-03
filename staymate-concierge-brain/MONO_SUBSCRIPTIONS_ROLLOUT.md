# StayAI mono acquiring subscriptions: production rollout

**State:** code and isolated tests prepared in codex/mono-payment-20261103. NOT deployed or enabled.
**Goal:** replace WayForPay for HOTEL SUBSCRIPTIONS first. Guest booking payments are a separate phase.

## Source files
- mono-acquiring.js: API client, invoices, read-only merchant verification, signed webhook helper.
- mono-subscriptions.js: owner-verified subscription invoice creation and authenticated provider reconciliation.
- mono-subscriptions-http.js: HTTP adapter for the existing invoice route and /webhook/mono-subscription.
- mono-subscriptions-migration.sql: additive schema and atomic, idempotent subscription finalization.
- test/mono-*.test.js: isolated tests; no real charge.

## Important production requirements
1. Confirm the supplied token via GET https://api.monobank.ua/api/merchant/details with X-Token as a **server-only** secret. If it returns HTTP 403, the supplied token is not usable as an acquiring merchant token. The merchant for StayAI subscriptions must settle funds to StayAI, NOT to a hotel.
2. Merchant token must be set as MONO_MERCHANT_TOKEN on the production backend, not in source code, frontend, logs, Git or chat. Rotate the provided token if the provider advises it, since it was shared in conversation.
3. Coordinate with active Codex board tasks: staymate-concierge-brain/server.js and StayMate-Project-3/site/cabinet/index.html are allocated to active tasks. Don't edit/mount conflicting files before they are free or explicitly reassigned by an owner.
4. When allowed, run mono-subscriptions-migration.sql in the **existing** production Supabase project; DO NOT create a new DB.
5. Mount the HTTP adapter at the beginning of the backend request handler ONLY when a validated MONO_MERCHANT_TOKEN is present and PAYMENT_PROVIDER=monobank. The adapter intercepts POST /api/create-subscription-invoice and handles /webhook/mono-subscription. Do not enable the feature flag before a real merchant-token probe.
6. Use the existing backend Supabase service_role only on the server; the POST invoice endpoint requires a Supabase session Bearer token and checks owner_id.
7. Update the cabinet subscription invoice fetch to send Authorization: Bearer <session.access_token> (as its other protected API requests already do).
8. Test (a) webhook ECDSA validation on original bytes; (b) receipt success matched against GET invoice/status; (c) DB function finalizes once; (d) duplicate delivery does not add another 31 days; (e) incorrect tenant/amount/status does not activate.
9. Execute a small **real** payment deliberately with owner-approved card and amount; check settlement and invoice status. No simulation can substitute for this production E2E.
10. Keep the WayForPay routes for rollback until mono production payments are verified. Remove stale test credentials / disable the legacy path only after reliable cutover.
11. Trial card capture and recurring charges via mono require separately enabled card tokenization or recurring payment support and explicit payer consent. Never silently turn on auto-renew.
12. Hotel guest payments must be implemented later with separate settlement to the hotel and a verified merchant/submerchant mapping. Never send hotel guest money to StayAI's subscription merchant.

## Local non-financial test
cd staymate-concierge-brain
node --test test/mono-acquiring.test.js test/mono-subscriptions.test.js

## Safe merchant credential check (read-only)
The client exports checkMerchantToken(token) which GETs /api/merchant/details.
A 200 with merchantId establishes merchant-scope access; a 403 is not merchant-scope access.
Never POST /api/merchant/invoice/create merely to test whether the token is valid.
