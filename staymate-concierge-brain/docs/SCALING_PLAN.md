# Safe scaling plan

## Before increasing concurrency

1. Establish account-specific ceilings: Zadarma simultaneous channels, OpenAI audio/rate limits, Railway CPU/RAM/WebSocket capacity, Supabase pool, and TurboSMS rate limit.
2. Set application `VOICE_MAX_CONCURRENT_PER_HOTEL` and `VOICE_MAX_CONCURRENT_GLOBAL` below the smallest validated bottleneck. Current defaults (2/10) are guardrails, not capacity evidence.
3. Use a dedicated load environment with synthetic tenants and mock payment/SMS providers. Increase in stages, observe for at least one sustained interval, and stop on p95/error/backlog thresholds.
4. Keep the voice admission DB transaction short. If global advisory-lock wait becomes material, replace it with an atomic quota strategy proven under load before raising limits.
5. Scale Railway only after external capacity is confirmed. Multiple instances are compatible with Postgres-backed SMS leases and call admission, but a live voice session remains non-resumable after instance loss.

## Payment scaling prerequisite

Each tenant needs a separate merchant configuration and signing-key lookup. A webhook must resolve a stored booking/invoice first, then verify with that merchant's public key, then atomically transition only the matching pending booking. Retain an immutable, idempotent payment-event ledger and a reconciliation job using Monobank's official invoice-status/statement API.

## Cost model status

Verified public inputs as of the audit date:

- The deployed `gpt-realtime-2.1-mini` list price is USD 10 / 1M audio input tokens and USD 20 / 1M audio output tokens; actual billable usage must be taken from the OpenAI account, because a reliable audio-token-per-minute assumption was not available in this audit. [Official pricing](https://developers.openai.com/api/docs/pricing?wvideo=akzb57a5z3)
- Zadarma publishes plan/line options, but the actual number allowance and tariff of the test number must be read from its account. Public documentation for external lines describes 1 inbound channel on Standard, 2 on Office and 4 on Corporation, with optional 3/3 and 10/10 channel add-ons; this does **not** prove the test DID's entitlement. [Zadarma guidance](https://zadarma.com/ua/support/faq/virtual-numbers/can-i-use-my-old-number/)
- TurboSMS tariffs can change; the provider directs customers to its current price list and contract terms. The historical observed staging SMS cost was 1.29 UAH/segment, not a pricing assumption. [TurboSMS terms](https://turbosms.ua/en/guide.html)

Use this forecast spreadsheet formula after collecting the missing account facts:

`monthly_cost = fixed_platform + hotels × (DID + merchant/PMS overhead) + calls × (OpenAI_audio_in_tokens/1e6×10 USD + OpenAI_audio_out_tokens/1e6×20 USD + Zadarma_minutes) + SMS_segments × current_TurboSMS_rate + acquiring_fees`

For 1, 10 and 100 hotels, substitute each cohort's observed `calls`, mean call audio tokens, SMS segments and subscribed carrier lines. Do not use a numerical forecast until those values and Monobank contract fees are confirmed; doing so would manufacture a margin figure.

