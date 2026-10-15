-- StayAI subscription pricing switched from EUR to UAH (4999 / 9999 / 14999 грн
-- for Старт / Профі / Мережа). The invoice currency sent to WayForPay is now
-- 'UAH' directly, so this column no longer holds euros — rename it to match.
-- Run this once in the Supabase SQL editor (live project, nyknlyufbwjodbpyehtv).

alter table subscription_orders rename column amount_eur to amount_uah;
