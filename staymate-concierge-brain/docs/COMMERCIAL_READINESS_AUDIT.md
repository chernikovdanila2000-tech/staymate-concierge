# StayAI: audit commercial readiness

Audit date: 2026-10-18. Scope: `codex/voice-phone-agent`, staging only. This is an evidence-based readiness assessment, not a claim of production readiness.

## Executive decision

| Target | Decision | Reason |
| --- | --- | --- |
| One staging hotel / controlled pilot | **Conditional NO-GO** | A real SIP regression test is still outstanding; acquiring token is absent. |
| 10 commercial hotels | **NO-GO** | Per-hotel acquiring merchant isolation, external PMS integration, provider capacity confirmation, monitoring and operational recovery are incomplete. |
| 100 commercial hotels | **NO-GO** | No real capacity validation, current default admission is 2 calls/hotel and 10 globally, and no production worker/observability design is proven. |

## Evidence collected

- Git baseline: `99bbda4` before this audit.
- Staging Railway environment: `voice-realtime-test`; health endpoint returned `ok=true`, Zadarma/Reatime configured.
- **Correction, 2026-10-18:** the active Railway `voice-realtime-test` and `production` configurations both resolve `SUPABASE_URL` to project ref `nyknlyufbwjodbpyehtv`. This connection fact—not the dashboard branch label—is why it cannot safely host isolated staging tests. See `P0_IMPLEMENTATION_STATUS.md`.
- Live staging database inspection: RLS is enabled on `properties`, `rooms`, `bookings`, `channels`, `conversations`, `voice_phone_numbers`, `voice_calls`, SMS tables and payment-link token table. The operational tables intentionally have no browser policies, so anon/authenticated roles cannot access them; server service role is the only application path.
- Automated suite after audit changes: 96 passed, 0 failed.
- Synthetic in-process test: 100 simultaneous signed-call equivalents created 100 independent call states, tenant prompts and Caller IDs, then released all states. It used no carrier, OpenAI, database, SMS or payment traffic, so it proves code-level isolation only.
- Staging database rollback-only integration check: created one synthetic room with quantity 1, obtained one hold for identical dates, and verified the second independent hold returned `room_no_longer_available`; the transaction was rolled back, leaving no audit rows.

## P0 findings and disposition

| Finding | Evidence | Disposition |
| --- | --- | --- |
| Internal `/chat` accepted caller-selected `propertyId` without authentication. | Route was a public dev harness. | Fixed fail-closed: disabled unless `INTERNAL_TEST_CHAT_ENABLED=true` and a server token is supplied. |
| Ambiguous Messenger-style routing could select the first property in a multi-tenant database. | `resolveMessengerPropertyId` had an arbitrary multi-property fallback. | Fixed: only an unambiguous single-property legacy fallback remains; otherwise no tenant is selected. |
| Acquiring webhook marked `paid` from a signed event without checking currency or expected amount. | Existing update only matched reference and invoice ID. | Fixed: payment event must match exact booking/invoice/reference, UAH currency and expected integer kopecks before transition. |
| Per-hotel acquiring is absent. | Current code relies on one `MONOBANK_ACQUIRING_TOKEN`; staging has none. | Open blocker. A shared merchant token must not be used for independent hotel payments. |
| External PMS hold/confirmation is absent. | Inventory source is Supabase `rooms`/`bookings`; no PMS adapter was found. | Open blocker. The local hold cannot guarantee a room in a separate PMS. |

## Current verified isolation boundaries

- Voice tenant is resolved server-side from the destination DID (`To`) through `voice_phone_numbers`, not Caller ID.
- Voice tools are created with the mapped `property_id`; trusted Caller ID is bound to call state and cannot be overwritten by tool JSON.
- Availability, bookings, conversations, SMS notifications and payment-link tokens are keyed by `property_id`.
- SQL admission control maps `(provider, destination DID)` atomically and rejects an unknown/disabled DID.
- Payment links are opaque 192-bit random tokens, stored as hashes, scoped to a property and booking, and redirect only to the server-stored invoice host.

## Important limits and unverified assumptions

- Software default admission: **2 active calls per hotel**, **10 globally**. These are defensive application limits, not carrier/OpenAI capacity declarations.
- `voice_begin_call` serializes admission with a global PostgreSQL advisory lock. It gives deterministic limits but must be load-measured before raising global capacity.
- Railway is one replica in the observed staging deployment. SMS leasing is safe across replicas; voice session state is in process, so an active call cannot be resumed after a process loss.
- Zadarma line/channel capacity has not been verified in the account dashboard. No exact simultaneous-call number may be claimed until the virtual-number tariff/SIP line settings are checked.
- OpenAI account-specific audio/rate limits have not been read from the account limits page. Official docs state capacity depends on usage tier and rate limits; code must handle throttling. See [OpenAI SIP guidance](https://developers.openai.com/api/docs/guides/voice-sip?voice-api=realtime) and [rate-limit guidance](https://developers.openai.com/api/docs/guides/rate-limits).

## Required before a commercial pilot

1. Complete a controlled real SIP call for greeting, VAD interruption, Caller ID and one consented test SMS.
2. Configure a dedicated staging Monobank acquiring token and run a test invoice/webhook/reconciliation sequence without production money.
3. Implement and test a per-hotel merchant credential model; never use one merchant token for unrelated hotels.
4. Integrate the actual PMS hold/confirm/release API, including compensating/manual-exception flow.
5. Confirm Zadarma concurrent-line allowance, OpenAI limits, Railway resource headroom, Supabase pool limits and TurboSMS throughput in the respective account dashboards.
6. Add durable metrics/alerts and a reconciliation worker for invoices whose webhook was missed.

