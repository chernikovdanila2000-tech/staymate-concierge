# StayAI — карта окружений и безопасный порядок работы

Дата: 2026-10-19. Этот документ предназначен для передачи следующему чату или разработчику. Секреты, токены, пароли и полные SIP URI намеренно не включены.

## Краткий вывод

`voice-realtime-test` в Railway является отдельным окружением приложения, но **не был отдельной базой данных**: он и Railway production используют один Supabase project ref `nyknlyufbwjodbpyehtv`.

Поэтому это окружение нельзя использовать для изолированных миграций, тестовых бронирований, платежей, SMS или нагрузочных проверок до подключения отдельной Supabase staging-базы.

## Карта систем

| Слой | Где | Назначение / состояние |
| --- | --- | --- |
| GitHub | `chernikovdanila2000-tech/staymate-concierge` | Основной репозиторий StayAI / StayMate. |
| Рабочая ветка | `codex/voice-phone-agent` | Ветка Voice и текущих audit/P0-изменений. На момент создания документа HEAD: `bd2772f`. |
| Backend | `staymate-concierge-brain` | Node.js-сервис: каналы, отели, бронирования, платежи, Voice. |
| Railway production | Сервис `staymate-concierge` | Рабочие сайт и мессенджеры. Не использовать для экспериментов. |
| Railway Voice staging | Environment `voice-realtime-test` | Отдельный процесс, домен и переменные для Voice, но до исправления использует общую Supabase базу. |
| Supabase | Project ref `nyknlyufbwjodbpyehtv` | Общая база, к которой подключены текущие Railway production и `voice-realtime-test`. |
| OpenAI | Организация «повний холод», проект StayMate | Текущий телефонный маршрут использует OpenAI Realtime. |
| Zadarma | Номер `+380443002819` | Сейчас направлен обратно на OpenAI SIP. |
| ElevenLabs | Агент создан | Сохранён как альтернативный эксперимент; номер на него сейчас не направлен. |

## Что работает сейчас

- Тестовый телефонный номер принимает вызовы через Zadarma → OpenAI Realtime → Railway Voice.
- В коде Voice по умолчанию используются `gpt-realtime-2.1-mini`, голос `marin`, `server_vad`.
- Для Voice добавлены server-side tenant routing, база знаний/номера/бронирования, перебивания, лимиты и обработка языков.
- Последние Voice-настройки повышают VAD threshold до `0.72`, чтобы обычный шум/телевизор реже считался речью; русский, украинский и английский определяются по полной осмысленной реплике.
- ElevenLabs-интеграция и его staging webhooks сохранены, но не должны обслуживать номер, пока прямо не решено провести новый тест.

## Важный факт об изоляции

Разные Railway environments не означают разные базы. В текущей конфигурации `SUPABASE_URL` у production и `voice-realtime-test` разрешается в один и тот же Supabase project ref.

Это значит:

- тестовый телефонный звонок способен читать реальные данные отеля;
- в зависимости от сценария он может создавать/обновлять operational записи (`voice_calls`, бронирования, эскалации и т.д.);
- нельзя считать тестовые платежи, SMS, бронирования или SQL-миграции безопасными;
- production мессенджеры и Voice разделены на уровне Railway-процесса, но не на уровне данных.

## Уже выполненная защита в коде

Файл `environment-isolation.js` добавляет fail-closed проверку для staging.

При включённом `REQUIRE_STAGING_DB_ISOLATION=true` сервис не стартует, если:

1. отсутствует подтверждённый staging или production project ref;
2. staging `SUPABASE_URL` равен production URL/ref;
3. любой заданный PostgreSQL connection string указывает не на staging ref.

Необходимые Railway variables для настоящего staging:

```text
STAYAI_ENVIRONMENT=staging
REQUIRE_STAGING_DB_ISOLATION=true
SUPABASE_URL=<URL отдельного staging Supabase проекта>
SUPABASE_KEY=<service-role key отдельного staging проекта>
PRODUCTION_SUPABASE_URL=<production URL, только для проверки ref>
STAGING_SUPABASE_PROJECT_REF=<staging project ref>
PRODUCTION_SUPABASE_PROJECT_REF=nyknlyufbwjodbpyehtv
```

Любые `DATABASE_URL`, `DIRECT_URL`, `POSTGRES_URL` и подобные строки в staging также должны вести только в staging project ref.

## Что было затронуто раньше

До обнаружения общей базы одна payment-ledger SQL-операция была применена в общий Supabase project. Она:

- добавила новые пустые payment tables;
- добавила nullable payment metadata columns;
- добавила server-only RPC;
- не удаляла существующие данные;
- не отправляла SMS;
- не создавала денежные списания.

Откат не запускали: это был бы ещё один production/shared-database change. Нужен отдельный review этой схемы до production-релиза.

Подробности: `docs/P0_IMPLEMENTATION_STATUS.md`.

## Правильная следующая инфраструктура

Рекомендуемый вариант: отдельный долгоживущий Supabase project `stayai-staging`.

Он должен содержать:

- ту же схему, что production, через миграции из Git;
- только синтетические данные: тестовый отель, номера, брони, контакты;
- отдельные API URL и service-role key;
- отдельные тестовые интеграции/токены для платежей и SMS;
- никаких production guest data, production payment tokens или production каналов.

Supabase Branches — альтернативный вариант для preview/PR. Они создают изолированные проекты с отдельными credentials; production data по умолчанию не копируются. По текущей документации GitHub preview branching требует Pro. Отдельный второй project может не требовать оплаты, если у владельца доступен свободный Free-project slot; фактический лимит надо проверить в Supabase account before purchase.

## Безопасный workflow

```text
1. Новая feature branch
2. Commit + push в GitHub
3. Deploy в Railway voice-realtime-test
4. Railway voice-realtime-test использует только stayai-staging
5. Миграция применяется в staging
6. Реальные E2E-тесты на синтетических данных
7. Code review + отдельное решение о production release
8. Merge/release в production
9. Отдельно применяем одобренную migration к production Supabase
10. Deploy Railway production
```

Правила:

- Не выполнять SQL-эксперименты в Supabase production dashboard.
- Не тестировать оплаты, брони, SMS и concurrency в shared database.
- Не использовать production payment merchant/token в staging.
- Production deployment выполняется только после явного review, а не просто после успешного staging deploy.
- Миграции должны храниться в Git и сначала проверяться на staging.

## До создания staging базы запрещено

- Новые Supabase migrations в текущем общем проекте.
- Тестовые реальные бронирования/оплаты/SMS из Voice staging.
- Нагрузочные и конкурентные тесты против текущей базы.
- Утверждение, что `voice-realtime-test` полностью безопасен как staging.

## Одно следующее действие

Создать или выделить отдельный Supabase project `stayai-staging`. После этого подключить только его URL/key к Railway `voice-realtime-test`, включить `REQUIRE_STAGING_DB_ISOLATION=true`, убедиться, что сервис стартует, и только затем переносить schema/migrations и запускать E2E-тесты.
