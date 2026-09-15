# StayAI — "мозок" ШІ-адміністратора (бекенд)

Мультитенантний Node.js-сервер: один процес обслуговує багато готелів одночасно,
кожен зі своїми номерами, цінами і підключеними каналами зв'язку (Telegram, Viber,
чат-віджет на сайті готелю; WhatsApp/Instagram — коли пройде верифікація Meta).

Деплой: Railway, root directory цієї папки (`staymate-concierge-brain`). Публічний
домен зараз — `staymate-concierge-production.up.railway.app`.

## Що реальне, а що очікує зовнішнього кроку

| Частина | Статус |
|---|---|
| Системний промпт, tool-calling, Claude API | ✅ Реальне |
| Telegram | ✅ Реальне, self-service підключення з кабінету |
| Чат-віджет на сайті готелю | ✅ Реальне, підключення не потребує зовнішньої верифікації |
| Viber | ✅ Код готовий (webhook + REST-виклики), але не протестовано на живому акаунті — очікує комерційного схвалення заявки Viber |
| WhatsApp / Instagram | ⚠️ Тільки збереження реквізитів у кабінеті — сама інтеграція потребує верифікації бізнесу в Meta (Фаза 4 плану) |
| Реальний облік зайнятості номерів по датах | ✅ Реальне (`quantity` на номері + перетин із таблицею bookings) |
| Історія переписки | ✅ Зберігається в Supabase (`conversations`), не губиться при перезапуску |
| Оплата гостя за бронювання | ⚠️ Робоче на тестовому мерчант-акаунті WayForPay (`test_merch_n1`) — власного мерчант-акаунту ще нема |
| Оплата підписки готелю | ⚠️ Те саме — робочий код на тестовому WayForPay, з реальним мерчантом запрацює без змін коду |
| Автопродовження підписки (картка при тріалі → автосписання) | 🚧 Код написаний (regularMode/dateBegin у tools.js, властивості `auto_renew`/`regular_payment_reference`), але поля регулярного платежу WayForPay зібрані з відкритих джерел і НЕ звірені напряму з їхньою документацією (в цьому середовищі заблокований мережевий доступ до wiki.wayforpay.com) — обов'язково протестувати в пісочниці WayForPay разом з їхньою підтримкою, перш ніж вмикати для реальних карток |

## Запуск локально

```
ANTHROPIC_API_KEY=sk-ant-... \
SUPABASE_URL=https://xxxxx.supabase.co \
SUPABASE_KEY=service_role_ключ \
node server.js
```

`SUPABASE_KEY` — обов'язково `service_role` (секретний), НЕ `anon`/`publishable`,
інакше сервер не зможе писати в базу.

## SQL-міграції (виконати один раз у Supabase → SQL Editor, у цьому порядку)

1. `properties-setup.sql` — таблиця готелів (якщо ще не виконано раніше)
2. `supabase-setup.sql` — таблиці rooms / bookings / escalations
3. `channels-setup.sql` — таблиця channels (Telegram/Viber/WhatsApp/Instagram в одному місці)
4. `conversations-setup.sql` — постійна історія переписки
5. `phase1-2-migrations.sql` — `quantity` на номерах, тріал/тариф підписки на properties, `subscription_orders`
6. `phase3-recurring-billing.sql` — `auto_renew`, `subscription_cancelled_at`, `regular_payment_reference`, `last_auto_charge_failed` на properties; `is_trial_card` на subscription_orders

Усі файли безпечно виконувати повторно (`if not exists` / `add column if not exists`).

## Змінні середовища на Railway

```
ANTHROPIC_API_KEY
SUPABASE_URL
SUPABASE_KEY                  (service_role!)
WAYFORPAY_MERCHANT_ACCOUNT
WAYFORPAY_MERCHANT_SECRET
WAYFORPAY_DOMAIN
API_BASE_URL                  = https://staymate-concierge-production.up.railway.app
CABINET_URL                   = https://stayai.online/cabinet/  (необов'язково, є дефолт)
RESEND_API_KEY                (необов'язково — без нього лист "новий вхід в акаунт" просто не шлеться)
RESEND_FROM_EMAIL             = StayAI <noreply@stayai.online>  (необов'язково, є дефолт)
PORT
```

## Роути

| Роут | Призначення |
|---|---|
| `POST /chat` | тестовий роут без месенджера (потрібен `propertyId` в тілі) |
| `POST /webhook/telegram/<property_id>` | вебхук Telegram-бота готелю |
| `POST /webhook/viber/<property_id>` | вебхук Viber-бота готелю |
| `POST /webhook/website/<property_id>` | чат-віджет на сайті готелю (`widget.js`) |
| `POST /webhook/wayforpay` | підтвердження оплати гостя за бронювання |
| `POST /webhook/wayforpay-subscription` | підтвердження оплати підписки готелю |
| `GET /webhook/messenger` | перевірка Meta Messenger webhook |
| `POST /webhook/messenger` | підписані вхідні події Meta Messenger |
| `POST /api/connect-channel` | кабінет підключає Telegram/Viber (сервер сам реєструє вебхук) |
| `POST /api/create-subscription-invoice` | кабінет запитує рахунок на оплату підписки |
| `POST /api/create-trial-invoice` | кабінет підключає картку на старті пробного періоду (регулярний платіж, перше списання — на дату закінчення тріалу) |
| `POST /api/cancel-auto-renew` | кабінет скасовує автопродовження підписки |
| `POST /api/notify-signin` | кабінет просить надіслати лист "новий вхід в акаунт" (через Resend) |
| `GET /health` | перевірка живості |

## Структура файлів

```
staymate-concierge-brain/
├── system-prompt.js         — особистість і правила ШІ
├── tools.js                  — інструменти ШІ (наявність/бронювання/ескалація) + рахунки WayForPay
├── claude-client.js          — виклик Claude API + цикл tool-calling
├── telegram.js                — Telegram Bot API
├── viber.js                    — Viber Bot API (код готовий, очікує схвалення Viber)
├── channels.js                  — довідник підключених каналів (з кешем)
├── conversations.js               — постійна історія переписки (Supabase замість Map)
├── server.js                        — HTTP-сервер, усі роути
├── properties-setup.sql              — таблиця properties
├── supabase-setup.sql                 — таблиці rooms/bookings/escalations
├── channels-setup.sql                  — таблиця channels
├── conversations-setup.sql              — таблиця conversations
├── phase1-2-migrations.sql               — точкові доповнення (quantity, тріал, subscription_orders)
├── phase3-recurring-billing.sql           — автопродовження (auto_renew, regular_payment_reference)
└── README.md                              — цей файл
```

Детальний план подальшого розвитку — `StayMate-Project-3/docs/staymate-completion-plan.md`.
