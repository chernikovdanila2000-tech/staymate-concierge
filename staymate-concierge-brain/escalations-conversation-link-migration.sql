-- StayAI: прив'язує escalations до конкретної розмови (channel + chat_id),
-- щоб власник готелю міг відкрити ескалацію в кабінеті й побачити/
-- продовжити саме той діалог, а не лише прочитати короткий "reason".
-- Виконати один раз у Supabase → SQL Editor → Run.

alter table escalations add column if not exists channel text;
alter table escalations add column if not exists chat_id text;
alter table escalations add column if not exists resolved_at timestamptz;

create index if not exists escalations_property_idx on escalations (property_id);
create index if not exists escalations_property_status_idx on escalations (property_id, status);

-- Раніше була лише політика SELECT — власник не міг позначити ескалацію
-- вирішеною/знову відкрити її прямо з кабінету.
drop policy if exists "Owners can update their own escalations" on escalations;
create policy "Owners can update their own escalations"
  on escalations for update
  using (property_id in (select property_id from properties where owner_id = auth.uid()))
  with check (property_id in (select property_id from properties where owner_id = auth.uid()));
