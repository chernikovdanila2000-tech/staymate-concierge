# StayAI ElevenLabs Voice — handoff

## Scope

- Keep production and all messenger channels untouched.
- The isolated Railway environment is `voice-realtime-test`.
- The original OpenAI Realtime SIP route remains the rollback path until an
  incoming Zadarma call to ElevenLabs has been verified.

## Completed

- Added the server-side ElevenLabs webhook endpoints for `check_availability`,
  `create_booking`, and `escalate_to_human` in commits `c8e7cab` and
  `22a9950`.
- Each endpoint requires the staging-only webhook secret and resolves the hotel
  from the Zadarma voice-number mapping; it does not accept a caller-supplied
  property ID.
- Railway staging has the webhook secret configured. Do not copy it into code,
  prompts, logs, or this file.
- The ElevenLabs agent "StayAI Hotel Voice — OpArtel" is published with the
  three webhook tools, Ukrainian/Russian language configuration, language
  detection, and end-conversation tool enabled.
- The existing Zadarma number `+380443002819` has been imported into the
  ElevenLabs agent as an inbound SIP trunk. Media encryption is `Allowed` for
  the compatibility test; inbound source-IP, remote-domain, and digest
  restrictions are deliberately off until the first carrier call is confirmed.
- ElevenLabs SIP message capture is enabled on the imported number to aid
  diagnostics.

## Active SIP test route

- Zadarma External Server now points to
  `+380443002819@sip.rtc.elevenlabs.io:5061;transport=tls`.
- Zadarma accepted and displayed the TLS URI after saving.
- Keep the previous OpenAI URI private and restore it immediately if the
  ElevenLabs telephone test fails.

## Pending real-phone test

1. Call `+380443002819` from an iPhone and confirm the ElevenLabs greeting.
2. If it fails, inspect ElevenLabs SIP messages first, then immediately restore
   the previous OpenAI URI in Zadarma.
3. Only after a successful call tighten TLS/SRTP/source restrictions as
   supported by the carrier's actual SDP/SIP signaling.

## Do not claim yet

- A real Zadarma → ElevenLabs call has **not** been performed.
- Voice naturalness, Russian/Ukrainian pronunciation, and interruption quality
  have **not** yet been heard through the telephone path.
- Remaining ElevenLabs free minutes have not been read from the dashboard.
