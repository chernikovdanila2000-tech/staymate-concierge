-- Adds crypto (NOWPayments) as a second subscription payment rail alongside
-- WayForPay. Distinguishes rows so support/debugging can tell which provider
-- a given subscription_orders row went through; the webhooks themselves
-- look up by order_id regardless of provider.
alter table subscription_orders add column if not exists payment_provider text not null default 'wayforpay';
