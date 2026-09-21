-- StayAI shared launch-board: owner-friendly task details.
-- Additive only: no DROP, DELETE, TRUNCATE, policy change, or data overwrite.

alter table public.internal_launch_tasks
  add column if not exists short_title text,
  add column if not exists technical_title text,
  add column if not exists plain_description text,
  add column if not exists why_needed text,
  add column if not exists risk_if_not_done text,
  add column if not exists current_state_plain text,
  add column if not exists remaining_plain text,
  add column if not exists owner_action_plain text,
  add column if not exists codex_action_plain text,
  add column if not exists steps jsonb not null default '[]'::jsonb,
  add column if not exists technical_details text;

-- Preserve every existing status, priority, note and owner field. These safe
-- defaults prevent blank owner-facing cards; the web app provides richer
-- task-specific wording and lets owners edit every field.
update public.internal_launch_tasks
set
  short_title = coalesce(nullif(short_title, ''), title),
  technical_title = coalesce(nullif(technical_title, ''), title),
  plain_description = coalesce(nullif(plain_description, ''), 'Это крупный шаг подготовки StayAI к запуску.'),
  why_needed = coalesce(nullif(why_needed, ''), 'Помогает подготовить продукт к безопасной работе с первым отелем.'),
  risk_if_not_done = coalesce(nullif(risk_if_not_done, ''), 'Запуск может занять больше времени или потребовать ручной работы.'),
  current_state_plain = coalesce(nullif(current_state_plain, ''), case when status = 'done' then 'Сделано и проверено.' else 'Работа ещё продолжается.' end),
  remaining_plain = coalesce(nullif(remaining_plain, ''), nullif(remaining, ''), 'Уточнить следующий практический шаг.'),
  owner_action_plain = coalesce(nullif(owner_action_plain, ''), case when owner_action then 'Нужно действие владельца.' else 'Ничего.' end),
  codex_action_plain = coalesce(nullif(codex_action_plain, ''), case when status = 'done' then 'Ничего — задача завершена.' else 'Продолжает работу по этой задаче.' end),
  technical_details = coalesce(nullif(technical_details, ''), title)
where short_title is null
   or technical_title is null
   or plain_description is null
   or why_needed is null
   or risk_if_not_done is null
   or current_state_plain is null
   or remaining_plain is null
   or owner_action_plain is null
   or codex_action_plain is null
   or technical_details is null;

comment on column public.internal_launch_tasks.steps is
  'Ordered owner-facing plan steps: title, description, status and sort_order.';
