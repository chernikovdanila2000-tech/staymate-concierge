-- StayAI: Блок 2 — повноцінна БД номерів + масове завантаження прайс-листа.
-- Безпечно виконувати повторно (усюди add column if not exists / or replace).
-- Виконати один раз у Supabase → SQL Editor → Run.

-- Зручності номера (Wi-Fi, балкон, ванна тощо) — вільний список рядків,
-- а не фіксований enum, бо в різних готелів дуже різний набір послуг.
alter table rooms add column if not exists amenities jsonb not null default '[]'::jsonb;

-- Атомарне збереження результату масового завантаження (Блок 2): кабінет
-- показує гостю editable preview і викликає ЦЮ функцію одним запитом з усім
-- списком одразу (кожен рядок — або оновлення існуючого номера за id, або
-- створення нового), щоб або записалося ВСЕ, або НІЧОГО — Postgres-функція
-- виконується в одній транзакції, і будь-яка помилка всередині відкочує всі
-- зміни цього виклику.
--
-- Навмисно БЕЗ "security definer": функція виконується з правами того, хто
-- її викликає (звичайний автентифікований власник готелю через кабінет),
-- тож ті самі RLS-політики на rooms (власник керує тільки своїми номерами)
-- продовжують діяти всередині функції так само, як і при звичайному
-- insert/update — підміна чужого property_id в payload просто не пройде
-- перевірку RLS для жодного рядка.
create or replace function commit_room_bulk_upload(p_property_id text, p_rooms jsonb)
returns setof rooms
language plpgsql
as $$
declare
  r jsonb;
  updated_id uuid;
begin
  for r in select * from jsonb_array_elements(p_rooms)
  loop
    if coalesce(r->>'id', '') <> '' then
      update rooms set
        room_type = r->>'room_type',
        price_per_night = (r->>'price_per_night')::numeric,
        capacity = (r->>'capacity')::int,
        quantity = coalesce((r->>'quantity')::int, 1),
        description = r->>'description',
        amenities = coalesce(r->'amenities', '[]'::jsonb)
      where id = (r->>'id')::uuid and property_id = p_property_id
      returning id into updated_id;

      if updated_id is null then
        raise exception 'Номер % не знайдено серед номерів цього готелю', (r->>'id');
      end if;
    else
      insert into rooms (property_id, room_type, price_per_night, capacity, quantity, description, amenities)
      values (
        p_property_id,
        r->>'room_type',
        (r->>'price_per_night')::numeric,
        (r->>'capacity')::int,
        coalesce((r->>'quantity')::int, 1),
        r->>'description',
        coalesce(r->'amenities', '[]'::jsonb)
      );
    end if;
  end loop;

  return query select * from rooms where property_id = p_property_id order by price_per_night asc;
end;
$$;
