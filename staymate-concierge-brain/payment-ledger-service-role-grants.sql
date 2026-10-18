-- Follow-up for payment-ledger-migration.sql. Apply only after isolation is
-- verified, through the normal staging/production release procedure.  The
-- browser roles remain explicitly denied; only the server's service_role may
-- manage encrypted tenant merchant rows or call payment state RPCs.
revoke all on public.payment_merchants, public.payment_events from public, anon, authenticated;
revoke all on function public.payment_record_monobank_event(text,text,text,text,text,text,text,bigint,integer,bigint,timestamptz,text) from public, anon, authenticated;
revoke all on function public.booking_bind_monobank_merchant(text,text,text) from public, anon, authenticated;
revoke all on function public.booking_attach_monobank_invoice(text,text,text,text) from public, anon, authenticated;

grant select, insert, update on public.payment_merchants to service_role;
grant execute on function public.payment_record_monobank_event(text,text,text,text,text,text,text,bigint,integer,bigint,timestamptz,text) to service_role;
grant execute on function public.booking_bind_monobank_merchant(text,text,text) to service_role;
grant execute on function public.booking_attach_monobank_invoice(text,text,text,text) to service_role;
