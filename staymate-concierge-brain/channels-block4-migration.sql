-- StayAI: Блок 4 — реальне підключення WhatsApp/Instagram/Messenger.
-- Безпечно виконувати повторно.
-- Виконати один раз у Supabase → SQL Editor → Run.

-- channels-setup.sql дозволяв тільки telegram/viber/whatsapp/instagram/
-- website — тепер додається ще й окремий канал 'messenger' (Facebook
-- Messenger, раніше жив лише через env vars, тепер підключається так
-- само, як WhatsApp/Instagram, через кабінет + канали в БД).
alter table channels drop constraint if exists channels_channel_type_check;
alter table channels add constraint channels_channel_type_check
  check (channel_type in ('telegram', 'viber', 'whatsapp', 'instagram', 'messenger', 'website'));

-- Детальний статус каналу для кабінету. `connected` лишається єдиним
-- полем, яке дивляться вебхуки (resolveWhatsAppConnection тощо) — тільки
-- 'connected' встановлює connected=true; 'awaiting_verification' і 'error'
-- лишають connected=false, але зберігають credentials, щоб канал сам
-- активувався, щойно Meta підтвердить верифікацію (власнику не треба
-- вводити токен вдруге).
alter table channels add column if not exists status text not null default 'disconnected'
  check (status in ('disconnected', 'connected', 'awaiting_verification', 'error'));
alter table channels add column if not exists status_detail text;

update channels set status = case when connected then 'connected' else 'disconnected' end
  where status = 'disconnected';
