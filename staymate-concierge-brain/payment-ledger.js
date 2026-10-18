const crypto = require('crypto');
const { getMonobankInvoiceStatus } = require('./monobank');

function eventKey(event) {
  // Monobank invoices do not expose a universal webhook event id. Include all
  // settlement-relevant state fields so a retransmission is idempotent.  Do
  // not include a provider timestamp: otherwise a retry with a regenerated
  // timestamp becomes a second logical ledger event.
  // Include the resolved tenant and merchant too.  Invoice identifiers are
  // provider-facing identifiers, not a substitute for our tenant boundary.
  const value = [event.propertyId, event.merchantId, event.invoiceId, event.status,
    event.reference, event.amount, event.ccy, event.finalAmount ?? ''].join('|');
  return crypto.createHash('sha256').update(value).digest('hex');
}
function payloadHash(raw) { return crypto.createHash('sha256').update(String(raw || '')).digest('hex'); }

async function recordMonobankEvent(supabase, booking, event, { source, rawBody }) {
  if (!booking?.property_id || !booking?.booking_id || !booking?.payment_merchant_id || !event?.invoiceId) {
    throw new Error('payment_event_binding_required');
  }
  if (source !== 'webhook' && source !== 'reconciliation') throw new Error('invalid_payment_event_source');
  const scopedEvent = { ...event, propertyId: booking.property_id, merchantId: booking.payment_merchant_id };
  const { data, error } = await supabase.rpc('payment_record_monobank_event', {
    p_event_key: eventKey(scopedEvent), p_source: source, p_property_id: booking.property_id,
    p_booking_id: booking.booking_id, p_merchant_id: booking.payment_merchant_id,
    p_invoice_id: String(event.invoiceId), p_status: String(event.status || ''),
    p_amount_kopecks: Number.isSafeInteger(event.amount) ? event.amount : null,
    p_currency: Number.isInteger(event.ccy) ? event.ccy : null,
    p_final_amount_kopecks: Number.isSafeInteger(event.finalAmount) ? event.finalAmount : null,
    p_occurred_at: event.modifiedDate ? new Date(event.modifiedDate).toISOString() : null,
    p_payload_hash: payloadHash(rawBody || JSON.stringify(event)),
  });
  if (error) throw error;
  return data;
}

async function reconcileMonobankInvoices({ supabase, resolveMerchant, limit = 20, logger = console, now = new Date() }) {
  const { data: rows, error } = await supabase.from('bookings')
    .select('property_id,booking_id,payment_merchant_id,payment_reference,total_price,payment_state,hold_expires_at')
    .eq('payment_method', 'monobank_acquiring').in('payment_state', ['PENDING', 'REQUIRES_REVIEW'])
    .not('payment_reference', 'is', null).order('hold_expires_at', { ascending: true }).limit(limit);
  if (error) throw error;
  const results = [];
  for (const booking of rows || []) {
    try {
      const merchant = await resolveMerchant(booking.property_id);
      if (!merchant || merchant.merchant_id !== booking.payment_merchant_id) {
        results.push({ bookingId: booking.booking_id, outcome: 'merchant_unavailable' }); continue;
      }
      const event = await getMonobankInvoiceStatus(merchant.token, booking.payment_reference);
      // A status API response travels over authenticated TLS, but state matching
      // remains identical to a webhook; it can never select a different booking.
      const result = await recordMonobankEvent(supabase, booking, event, { source: 'reconciliation', rawBody: JSON.stringify(event) });
      results.push({ bookingId: booking.booking_id, outcome: result?.outcome || 'recorded' });
    } catch (error) {
      logger.warn?.('[monobank reconciliation] invoice check failed', { bookingId: booking.booking_id, message: error.message });
      results.push({ bookingId: booking.booking_id, outcome: 'check_failed' });
    }
  }
  return { checkedAt: now.toISOString(), results };
}

module.exports = { eventKey, payloadHash, recordMonobankEvent, reconcileMonobankInvoices };
