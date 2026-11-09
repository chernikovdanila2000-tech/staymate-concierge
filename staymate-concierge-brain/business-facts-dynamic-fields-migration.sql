-- StayAI: business_facts переходить з фіксованого набору з 8 колонок на
-- довільні пари "назва поля -> значення" (jsonb) — ШІ сам вигадує, які поля
-- доречні під конкретний бізнес під час онбордингу (боксерський автомат,
-- перукарня, юридична фірма тощо мають геть різні важливі факти, які не
-- вкладаються в один фіксований список на кшталт готельного hotel_info).
-- Фіча щойно запущена, реальних рядків із заповненими старими колонками
-- практично напевно ще нема — тому стара структура не зберігається.
-- Безпечно виконувати повторно. Виконати один раз у Supabase → SQL Editor → Run,
-- ПІСЛЯ business-facts-migration.sql.

alter table business_facts
  add column if not exists fields jsonb not null default '{}'::jsonb;

alter table business_facts drop column if exists description;
alter table business_facts drop column if exists hours;
alter table business_facts drop column if exists location;
alter table business_facts drop column if exists contact_info;
alter table business_facts drop column if exists services_offered;
alter table business_facts drop column if exists pricing_info;
alter table business_facts drop column if exists policies;
alter table business_facts drop column if exists additional_info;
