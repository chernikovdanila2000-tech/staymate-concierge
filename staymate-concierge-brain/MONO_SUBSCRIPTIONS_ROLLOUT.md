# StayAI mono acquiring: current deployment status (2026-11-03)

## Verified live
- Merchant X-Token authenticated at `GET /api/merchant/details`: HTTP 200, merchantName StayAI.
- Existing production Supabase project: `nyknlyufbwjodbpyehtv` (no new database).
- Applied additive SQL migration `mono_acquiring_subscriptions_vault_20261103`.
- Stored merchant token encrypted in Supabase Vault as `stayai_mono_merchant_token`.
- Supabase Edge Function `mono-subscriptions` deployed and healthy:
  `https://nyknlyufbwjodbpyehtv.supabase.co/functions/v1/mono-subscriptions`
- Health endpoint responds 200. Unauthenticated invoice creation is rejected. Unsigned webhook is rejected.
- 1 UAH QA plan `mono_qa_1uah` finalizes to `paid_test` without activating/renewing a real hotel subscription.
- Source prepared on feature branch `codex/mono-payment-20261103` and isolated tests pass.

## LIVE BLOCKER: mono refuses to create any invoice
With the real merchant token, `POST /api/merchant/invoice/create` returns:
`HTTP 400 {"errCode":"INVALID_MERCHANT_PAYM_INFO"}`.
This persists for 1 UAH (100 kopecks), minimal JSON, and 42 UAH with a documented basket and 32-hex order/item references. No invoice was created and no card charged. Authorization alone does **not** guarantee that the merchant has fully enabled acquiring, or that the currently configured fiscalization rules accept the request. Further identical API attempts are not useful without provider clarification.

Request mono support/partner to inspect merchant ID (obtain from authorized account; do not post secret token) and explain the required merchantPaymInfo/basketOrder/PRRO settings or activate invoice creation for StayAI's own UAH subscriptions.

## PRODUCTION CUTOVER NOT DONE
- The live cabinet still points to existing Railway API; it has not been switched to mono.
- Cabinet source patch to use the Edge Function is on the feature branch ONLY. Existing crypto payments use NOWPayments.
- Local Railway backend integration is feature-flagged by `PAYMENT_PROVIDER=monobank`, NOT deployed; do not set this flag until merchant invoicing and provider webhook are proven.
- The connected Railway account does NOT contain the current live backend `staymate-concierge-production.up.railway.app`. Its visible backend is offline. Do not modify unrelated Railway projects.
- The GitHub `main` branch is unchanged. Use an reviewed PR and the normal site deploy pipeline when ready.
- Trial card capture/automatic renew requires separately configured and consented card tokenization; do not pretend it works yet.
- Hotel guest booking settlement is a separate later phase; never mix guest funds with StayAI subscription merchant.

## After mono fixes invoice creation
1. With real merchant token, create exactly a **1 UAH** test invoice for the admin-owned `test-hotel-x8ok` property, `plan = mono_qa_1uah`, `payment_provider='monobank'`; persist reference and invoice ID.
2. The owner pays **only 1 UAH** via mono-hosted https://pay.mbnk.biz/... link.
3. Check signed webhook + invoice status + atomic SQL finalization once, and duplicate delivery. Test order must be `paid` and hotel subscription must remain unchanged.
4. Then release/merge website card-payment cutover (after coordination of board's active cabin/server ownership) and verify normal full-price invoice generation without paying the full amount.
5. Remove WayForPay subscription use only after confirmed success and rollback plan. Do not delete historic records.

## Security
- Never publish raw X-Token (Git, chat, frontend, URL, tests).
- Revoke leaked or old merchant token before final launch if provider deems necessary.
- Supabase Vault function `stayai_mono_merchant_token()` and atomic finalizer `finalize_mono_subscription()` are service-role only.
- All invoice requests require an authenticated owner; special 1 UAH QA uses an additional internal-admin restriction.
