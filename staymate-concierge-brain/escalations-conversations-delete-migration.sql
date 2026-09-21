-- StayMate: дозволити власнику видаляти власні ескалації та переписки
-- (кнопка "Видалити" у розділі "Ескалації" кабінету).
-- Виконати один раз у Supabase → SQL Editor → Run.

drop policy if exists "Owners can delete their own escalations" on escalations;
create policy "Owners can delete their own escalations"
  on escalations for delete
  using (property_id in (select property_id from properties where owner_id = auth.uid()));

drop policy if exists "Owners can delete their own conversations" on conversations;
create policy "Owners can delete their own conversations"
  on conversations for delete
  using (property_id in (select property_id from properties where owner_id = auth.uid()));
