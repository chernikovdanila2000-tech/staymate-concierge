'use strict';

function expectedKopecks(totalPrice) {
  const value = Math.round(Number(totalPrice) * 100);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// A signed webhook is still not sufficient to mark a booking paid: it must
// describe the exact invoice, booking reference, amount and currency that the
// server created.  Monetary values stay in integer kopecks throughout.
function isExpectedAcquiringSuccess(event, booking) {
  if (!event || !booking || event.status !== 'success') return false;
  const amount = expectedKopecks(booking.total_price);
  if (!amount || String(event.invoiceId || '') !== String(booking.payment_reference || '')) return false;
  if (String(event.reference || '') !== String(booking.booking_id || '')) return false;
  if (Number(event.amount) !== amount || Number(event.ccy) !== 980) return false;
  return event.finalAmount == null || Number(event.finalAmount) === amount;
}

module.exports = { expectedKopecks, isExpectedAcquiringSuccess };
