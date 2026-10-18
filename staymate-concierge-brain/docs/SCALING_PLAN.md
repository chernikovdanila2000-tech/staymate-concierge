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

No numerical 10/100-hotel cost forecast is included because account plans, per-minute Realtime pricing/limits, Zadarma tariff/line allowance, Railway plan, Supabase plan, TurboSMS rate and Monobank contract fees have not been verified from the relevant accounts. The existing observed TurboSMS test was 1.29 UAH for one segment; it is not a general commercial tariff or forecast. Collect current provider quotes before pricing the SaaS.

