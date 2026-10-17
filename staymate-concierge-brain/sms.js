'use strict';

// Provider-neutral transactional SMS primitives.  The database migration owns
// idempotency and leasing; this file deliberately never retries an ambiguous
// provider submission.
const crypto = require('crypto');

function bool(value, fallback = false) { return value === undefined ? fallback : String(value).toLowerCase() === 'true'; }
function normalizeSmsPhone(value) {
  let digits = String(value || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('0')) digits = `380${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}
function smsSegments(text) {
  // GSM 03.38 basic and extension alphabet. Anything else (notably Ukrainian
  // Cyrillic) is UCS-2. Extension chars consume two septets.
  const basic = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/;
  const extension = /[\^{}\\\[~\]|€]/g;
  if (!basic.test(text)) return { encoding: 'ucs2', segments: text.length <= 70 ? 1 : Math.ceil(text.length / 67) };
  const septets = text.length + ((text.match(extension) || []).length);
  return { encoding: 'gsm7', segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
}
function shortKey(value) { return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 40); }
function safeEqual(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function statusFromDlr(status) { const v = String(status || '').toUpperCase(); if (['DELIVRD', 'DELIVERED', 'READ'].includes(v)) return 'DELIVERED'; if (['EXPIRED', 'UNDELIV', 'UNDELIVERED', 'REJECTD', 'FAILED'].includes(v)) return 'FAILED'; if (['SENT', 'ACCEPTED', 'QUEUED'].includes(v)) return v === 'SENT' ? 'SENT' : 'ACCEPTED'; return 'UNKNOWN'; }

function smsConfig(env = process.env) {
  return { enabled: bool(env.SMS_ENABLED), primary: (env.SMS_PRIMARY_PROVIDER || 'turbosms').toLowerCase(), fallback: (env.SMS_FALLBACK_PROVIDER || 'mobizon').toLowerCase(), sender: env.SMS_SENDER || '', turboToken: env.TURBOSMS_API_TOKEN || '', turboWebhookSecret: env.TURBOSMS_WEBHOOK_SECRET || '', turboEnabled: bool(env.TURBOSMS_ENABLED, true), mobizonKey: env.MOBIZON_API_KEY || '', mobizonWebhookSecret: env.MOBIZON_WEBHOOK_SECRET || '', mobizonEnabled: bool(env.MOBIZON_ENABLED, true), paymentBaseUrl: (env.PAYMENT_LINK_BASE_URL || '').replace(/\/$/, ''), invoiceAllowedHosts: String(env.PAYMENT_INVOICE_ALLOWED_HOSTS || 'secure.wayforpay.com,api.wayforpay.com').split(',').map(x => x.trim()).filter(Boolean), estimatedSegmentCost: Number(env.SMS_ESTIMATED_SEGMENT_COST_UAH || 0) };
}

class TurboSmsProvider {
  constructor(config, fetchImpl = globalThis.fetch) { this.config = config; this.fetch = fetchImpl; }
  async sendPaymentLink({ phone, text, idempotencyKey }) {
    const response = await this.fetch('https://api.turbosms.ua/message/send.json', { method: 'POST', headers: { Authorization: `Bearer ${this.config.turboToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sequence_id: shortKey(idempotencyKey), recipients: [phone.slice(1)], sms: { sender: this.config.sender, text } }) });
    const data = await response.json(); const item = data?.response_result?.[0];
    if (!response.ok || !item?.message_id || ![0, 800, 801, 802, 803, 507].includes(Number(data?.response_code))) return { accepted: false, status: data?.response_status || `HTTP_${response.status}`, definitive: true };
    return { accepted: true, providerMessageId: String(item.message_id), status: item.response_status || data.response_status || 'ACCEPTED', definitive: true };
  }
}
class MobizonProvider {
  constructor(config, fetchImpl = globalThis.fetch) { this.config = config; this.fetch = fetchImpl; }
  async sendPaymentLink({ phone, text }) {
    const url = new URL('https://api.mobizon.ua/service/message/sendsmsmessage'); url.searchParams.set('output', 'json'); url.searchParams.set('api', 'v1'); url.searchParams.set('apiKey', this.config.mobizonKey);
    const body = new URLSearchParams({ recipient: phone.slice(1), text, ...(this.config.sender ? { from: this.config.sender } : {}), 'params[validity]': '1440' });
    const response = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); const data = await response.json();
    if (!response.ok || Number(data?.code) !== 0 || !data?.data?.messageId) return { accepted: false, status: data?.message || `HTTP_${response.status}`, definitive: true };
    return { accepted: true, providerMessageId: String(data.data.messageId), status: 'ACCEPTED', definitive: true };
  }
}

class SmsNotificationService {
  constructor({ supabase, config = smsConfig(), providers, logger = console }) { this.supabase = supabase; this.config = config; this.logger = logger; this.providers = providers || { turbosms: new TurboSmsProvider(config), mobizon: new MobizonProvider(config) }; }
  enabledProvider(name) { return this.config.enabled && this.config[`${name === 'turbosms' ? 'turbo' : name}Enabled`] && this.providers[name] && (name === 'turbosms' ? this.config.turboToken : this.config.mobizonKey); }
  async processOne() {
    if (!this.config.enabled) return { processed: false, reason: 'disabled' };
    const { data: job, error } = await this.supabase.rpc('sms_claim_outbox'); if (error) throw error; if (!job) return { processed: false, reason: 'empty' };
    const text = job.text; const primary = this.config.primary; const fallback = this.config.fallback;
    let provider = primary; if (!this.enabledProvider(provider) && this.enabledProvider(fallback)) provider = fallback;
    if (!this.enabledProvider(provider)) { await this.supabase.rpc('sms_finish_outbox', { p_id: job.id, p_status: 'FAILED', p_provider: null, p_provider_message_id: null, p_error: 'no_configured_provider', p_segments: 0, p_cost: 0 }); return { processed: true, status: 'FAILED' }; }
    let result;
    try { result = await this.providers[provider].sendPaymentLink({ phone: job.phone, text, idempotencyKey: job.idempotency_key }); }
    catch (error) { await this.supabase.rpc('sms_finish_outbox', { p_id: job.id, p_status: 'UNKNOWN', p_provider: provider, p_provider_message_id: null, p_error: 'ambiguous_transport_failure', p_segments: 0, p_cost: 0 }); return { processed: true, status: 'UNKNOWN' }; }
    // Fallback only after an explicit provider rejection, never after timeout.
    if (!result.accepted && result.definitive && provider === primary && this.enabledProvider(fallback)) { provider = fallback; try { result = await this.providers[provider].sendPaymentLink({ phone: job.phone, text, idempotencyKey: job.idempotency_key }); } catch { await this.supabase.rpc('sms_finish_outbox', { p_id: job.id, p_status: 'UNKNOWN', p_provider: provider, p_provider_message_id: null, p_error: 'ambiguous_fallback_transport_failure', p_segments: 0, p_cost: 0 }); return { processed: true, status: 'UNKNOWN' }; } }
    const segments = smsSegments(text).segments;
    await this.supabase.rpc('sms_finish_outbox', { p_id: job.id, p_status: result.accepted ? 'ACCEPTED' : 'FAILED', p_provider: provider, p_provider_message_id: result.providerMessageId || null, p_error: result.accepted ? null : String(result.status || 'rejected').slice(0, 500), p_segments: segments, p_cost: result.accepted ? segments * this.config.estimatedSegmentCost : 0 });
    return { processed: true, status: result.accepted ? 'ACCEPTED' : 'FAILED' };
  }
  async createPaymentSms({ propertyId, bookingId, phone, callId, language = 'uk', consent = false, phoneSource = 'spoken_confirmed' }) {
    const normalized = normalizeSmsPhone(phone); if (!consent || !normalized) return { ok: false, error: !consent ? 'guest_consent_required' : 'valid_phone_required' };
    if (!this.config.enabled) return { ok: false, error: 'sms_delivery_disabled' };
    if (!this.config.paymentBaseUrl) return { ok: false, error: 'payment_link_base_url_not_configured' };
    const { data, error } = await this.supabase.rpc('sms_prepare_payment_link', { p_property_id: propertyId, p_booking_id: bookingId, p_phone: normalized, p_call_id: callId || null, p_language: language, p_phone_source: phoneSource, p_payment_base_url: this.config.paymentBaseUrl, p_allowed_hosts: this.config.invoiceAllowedHosts });
    if (error) throw error; return data;
  }
}

function verifyTurboWebhook(payload, secret) { return Boolean(secret && payload?.id && safeEqual(crypto.createHash('sha1').update(`${secret}${payload.id}`).digest('hex'), payload.signature)); }
function verifyMobizonWebhook(payload, secret) { return Boolean(secret && payload?.eventId != null && safeEqual(crypto.createHash('sha1').update(`${payload.eventId}|${payload.attempt}|${payload.eventCreateTs}|${secret}`).digest('hex'), payload.sign)); }
module.exports = { normalizeSmsPhone, smsSegments, smsConfig, statusFromDlr, TurboSmsProvider, MobizonProvider, SmsNotificationService, verifyTurboWebhook, verifyMobizonWebhook, safeEqual };
