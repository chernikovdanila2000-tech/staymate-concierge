# New hotel onboarding runbook (current state)

This describes the manual procedure required today. It is not yet a self-service commercial onboarding flow.

1. Create `properties` row with a unique `property_id`, owner and hotel profile.
2. Add rooms, capacity, quantity, pricing and booking rules. Verify owner RLS with the hotel's account.
3. Add one unique `voice_phone_numbers` DID mapping per Zadarma number; verify it is enabled and cannot collide with another hotel.
4. Configure Zadarma routing of that DID to the OpenAI SIP URI and confirm available simultaneous lines in the Zadarma account.
5. Add the hotel-specific facts/policies and perform a controlled incoming-call test.
6. Configure SMS sender/template/consent policy and run one permitted SMS test. Do not share provider credentials between tenants without an explicit commercial model.
7. Connect the actual PMS and prove hold, confirmation, release and exception paths. This step is currently unavailable in code.
8. Configure that hotel's Monobank acquiring merchant credentials in an encrypted per-tenant credential store. This step is currently unavailable in code; a single global token is not a multi-hotel design.
9. Run test invoice + signed webhook + reconciliation and verify amount/currency/property matching.
10. Enable the hotel only after dashboard limits, alerts and an operator escalation path are configured.

Manual actions remain for DID provisioning, carrier capacity, PMS authorization, merchant authorization and live acceptance tests. Adding a hotel does not require copying the backend, but it currently requires operational engineering work and is not ready for unattended self-service onboarding.

