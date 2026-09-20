# StayAI — чек-лист власника: WhatsApp / Instagram / Facebook Messenger

Технічна частина (Блок 4) готова: кабінет уміє реально підключати ці канали,
перевіряти токени запитом до Meta, шифрувати їх у базі і відключати. Все,
що лишилось — дії, які тільки ви можете зробити як власник бізнесу
(реєстрація ФОП, верифікація в Meta, вставка ключів). Код нічого цього
зробити не може.

---

## 1. ФОП (не технічна дія)

Meta Business Verification вимагає юридичну особу/ФОП, прив'язану до
Meta Business Manager. Якщо ФОП ще не зареєстровано — це перший крок,
без нього Meta Business Verification не пройде.

## 2. Meta Business Manager + Verification

1. Створіть Business-акаунт на [business.facebook.com](https://business.facebook.com), якщо ще немає.
2. У Business Settings → Business Info → Start Verification — пройдіть
   верифікацію бізнесу (юридична назва, адреса, документ ФОП, телефон/email
   для підтвердження). Це може зайняти від кількох годин до кількох днів.
3. Поки верифікація не пройшла — WhatsApp/Instagram/Messenger у кабінеті
   показуватимуть статус **"Очікує верифікації Meta"**: підключення вже
   спрацює технічно (кнопка не помилка, не заглушка), просто Meta ще не
   дає повного доступу до відправки повідомлень.

## 3. Створення застосунку в Meta for Developers

1. [developers.facebook.com](https://developers.facebook.com) → My Apps → Create App → тип **Business**.
2. Прив'яжіть застосунок до вашого верифікованого Business-акаунта.
3. Додайте продукти застосунку: **Messenger**, **Instagram**, **WhatsApp**
   (у панелі App Dashboard → Add Product).
4. У Settings → Basic — тут ваш **App Secret** (знадобиться нижче).

### 3.1 Тестовий режим (поки бізнес не верифіковано)

У Meta for Developers завжди можна додати себе й колег як **Testers**
(App Roles → Roles → Add People → Tester) і одразу отримати робочий доступ
до відправки/прийому повідомлень у тестовому режимі — саме так можна
перевірити підключення до проходження повної верифікації.

## 4. Webhook-адреси, які потрібно зареєструвати в Meta

Для кожного продукту (Messenger, Instagram, WhatsApp) у Meta for Developers
→ Webhooks — вкажіть один і той самий домен сервера (Railway), різні шляхи:

| Канал | Callback URL | Verify Token (придумайте свій) |
|---|---|---|
| Messenger | `https://<ваш-railway-домен>/webhook/messenger` | значення `META_MESSENGER_VERIFY_TOKEN` |
| Instagram | `https://<ваш-railway-домен>/webhook/instagram` | значення `META_INSTAGRAM_VERIFY_TOKEN` |
| WhatsApp | `https://<ваш-railway-домен>/webhook/whatsapp` | значення `META_WHATSAPP_VERIFY_TOKEN` |

Підпишіться на поля (Webhook Fields): для Messenger/Instagram — `messages`;
для WhatsApp — `messages`.

## 5. Змінні середовища в Railway

Railway → ваш проєкт → Variables. **Обов'язкові** для роботи Блоку 4:

| Змінна | Що це | Обов'язково? |
|---|---|---|
| `CHANNEL_CREDENTIALS_ENCRYPTION_KEY` | Ключ шифрування токенів у БД (32 байти). Згенерувати: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` і вставити результат. **Без цього кабінет не зможе зберегти жоден новий токен WhatsApp/Instagram/Messenger.** | Так |
| `META_MESSENGER_APP_SECRET` | App Secret застосунку (Settings → Basic) — використовується для перевірки підпису вебхуків і Messenger, і WhatsApp. | Так |
| `META_MESSENGER_VERIFY_TOKEN` | Придуманий вами рядок для Messenger webhook (той самий, що в Meta). | Так, якщо підключаєте Messenger |
| `META_INSTAGRAM_VERIFY_TOKEN` | Те саме для Instagram. | Так, якщо підключаєте Instagram |
| `META_WHATSAPP_VERIFY_TOKEN` | Те саме для WhatsApp. | Так, якщо підключаєте WhatsApp |
| `META_GRAPH_VERSION` | Версія Graph API, за замовчуванням `v24.0` — можна не чіпати. | Ні |

**Токени конкретних готелів (Page Access Token, WhatsApp/Instagram Access
Token) більше НЕ потрібно вставляти в Railway** — кожен готель тепер вставляє
свій власний токен прямо в кабінеті (вкладка «Канали»), і кабінет одразу
перевіряє його живим запитом до Meta. Старі змінні
(`META_WHATSAPP_ACCESS_TOKEN`, `META_INSTAGRAM_ACCESS_TOKEN`,
`META_MESSENGER_PAGE_ACCESS_TOKEN` і відповідні `*_PROPERTY_ID`) лишаються
в коді лише як резервний варіант для одного готелю "за замовчуванням" —
можна не заповнювати, якщо всі готелі підключаються через кабінет.

## 6. Що робити після кожного кроку

1. Після створення застосунку і webhook — підключіть СЕБЕ як Tester
   (крок 3.1) і спробуйте підключити канал у кабінеті свого тестового
   готелю. Статус має стати "Підключено", а не "Очікує верифікації".
2. Напишіть тестове повідомлення в підключений WhatsApp/Instagram/
   Messenger — переконайтесь, що бот відповідає.
3. Після завершення Meta Business Verification — статус готелів, які вже
   ввели токени й отримали "Очікує верифікації Meta", активується сам,
   нічого пересилати не потрібно.

## 7. Fondy / WayForPay

Це поза межами Блоку 4 (канали зв'язку) — оплата підписок і бронювань
у проєкті вже йде через WayForPay (не Fondy), налаштовано й працює окремо
від цього чек-листа. Якщо малось на увазі підключення саме Fondy —
уточніть, це окрема задача.
