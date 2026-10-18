# Reproducible load and failure testing

## Executed

Run from `staymate-concierge-brain`:

```powershell
node --test --test-force-exit test\*.test.js
```

Result on 2026-10-18: **96 passed, 0 failed**, 0 skipped; total test-process duration about 0.49 s.

The suite includes `test/voice-scale-simulation.test.js`: 100 simultaneous synthetic incoming-call events across 100 tenants. It verifies independent call maps, prompt property names and Caller IDs, followed by resource cleanup. The test ran in approximately 11 ms locally.

A separate rollback-only staging database integration check verified the hold function's availability guard with quantity 1: the first request succeeded and the second overlapping request returned `room_no_longer_available`. This was one database transaction, not a many-client concurrency benchmark.

## What this does not measure

- No SIP/RTP packets, Zadarma channels, OpenAI Realtime sessions, external PMS, Monobank, TurboSMS or Mobizon calls occur in this simulation.
- Its time is not a voice first-response latency and must not be used for a commercial SLA.
- It does not prove 100 database admissions: real `voice_begin_call` deliberately serializes admission and must be tested against staging with synthetic, rollback-only tenant data or a dedicated load database.

## Load ladder for a dedicated staging/load environment

| Level | Hotels | Concurrent calls | Evidence required before passing |
| --- | ---: | ---: | --- |
| Baseline | 1 | 2 | Two real/synthetic SIP calls, no context crossover. |
| Small | 5 | 5 | Database admission, sideband lifecycle and SMS mock outbox. |
| Working | 10 | 10 | p50/p95 admission and tool latency, Railway CPU/RAM, DB connections. |
| Medium | 25 | 20 | Backpressure and recovery after worker restart. |
| High | 50 | 50 | Provider-limit confirmation and connection-pool headroom. |
| Target | 100 | 100 | Controlled carrier/OpenAI capacity test; not authorized or executed in this audit. |

## Mandatory metrics

Record timestamps keyed by `property_id -> call_id -> booking_id -> invoice_id -> notification_id`, with no raw audio, card data or full phone numbers:

- call webhook received, accepted/rejected, first audio response, VAD interruption, response/tool p50/p95/p99;
- active sessions, rejected-by-limit count, WebSocket close reasons, process restarts;
- DB/RPC latency, connection count and lock wait; booking hold collision count;
- SMS queued/accepted/delivered/failed/unknown, backlog age and provider 429/5xx;
- invoice create, webhook validation, paid/exception/reconciliation outcomes.

## Failure assertions

- An unknown DID returns a carrier-busy/reject path and does not guess a hotel.
- A global/hotel admission limit rejects the new call without disturbing active call states.
- An ambiguous SMS submission remains `UNKNOWN`; it is not retried through the fallback provider.
- A repeated SMS DLR is idempotent.
- A repeated successful Monobank webhook cannot change a non-pending booking again.
- After an application restart, active voice audio cannot be resumed; stale calls are marked by cleanup. DB-backed holds/outbox work are recoverable according to their leases/expiry.

