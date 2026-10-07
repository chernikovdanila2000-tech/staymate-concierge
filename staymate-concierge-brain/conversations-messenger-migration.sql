-- StayAI: allow Facebook Messenger histories in the shared conversation store.
-- Safe to run repeatedly in Supabase SQL Editor.
--
-- Existing Messenger webhook processing already uses `messenger` as the
-- channel identifier. The original conversations constraint predated that
-- adapter, so history writes were rejected even when an incoming message
-- was valid. Recreate only the check constraint; no messages are deleted.

alter table conversations
  drop constraint if exists conversations_channel_check;

alter table conversations
  add constraint conversations_channel_check
  check (channel in ('telegram', 'viber', 'whatsapp', 'instagram', 'messenger', 'website', 'test'));
