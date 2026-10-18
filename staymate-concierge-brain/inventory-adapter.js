/* Inventory boundary used by booking flows.  A property may deliberately use
 * StayAI inventory for a closed pilot, or an adapter for its real PMS. The
 * caller never chooses an adapter or property id. */
function assertAdapter(adapter) {
  for (const method of ['getAvailability', 'createHold', 'confirmBooking', 'releaseHold', 'getBookingStatus']) {
    if (typeof adapter?.[method] !== 'function') throw new Error(`Invalid inventory adapter: ${method}`);
  }
  return adapter;
}

function createLocalInventoryAdapter({ supabase, propertyId }) {
  if (!supabase || !propertyId) throw new Error('Local inventory requires database and property');
  return assertAdapter({
    async getAvailability({ checkIn, checkOut, guests }) {
      const rooms = supabase.from('rooms').select('room_type,price_per_night,capacity,description,quantity').eq('property_id', propertyId);
      if (guests) rooms.gte('capacity', guests);
      const bookings = supabase.from('bookings').select('room_type,status,hold_expires_at').eq('property_id', propertyId)
        .in('status', ['pending_payment', 'paid']).lt('check_in', checkOut).gt('check_out', checkIn);
      const [{ data: types, error: roomError }, { data: occupied, error: bookingError }] = await Promise.all([rooms, bookings]);
      if (roomError || bookingError) throw roomError || bookingError;
      const used = {};
      for (const row of occupied || []) if (row.status === 'paid' || !row.hold_expires_at || new Date(row.hold_expires_at) > new Date()) used[row.room_type] = (used[row.room_type] || 0) + 1;
      return (types || []).filter(row => (used[row.room_type] || 0) < (row.quantity || 1));
    },
    async createHold(input) { return supabase.rpc('booking_prepare_monobank_hold', { p_property_id: propertyId, ...input }); },
    async confirmBooking({ bookingId }) { return supabase.from('bookings').update({ status: 'paid' }).eq('property_id', propertyId).eq('booking_id', bookingId).eq('status', 'pending_payment'); },
    async releaseHold({ bookingId }) { return supabase.rpc('booking_release_monobank_hold', { p_property_id: propertyId, p_booking_id: bookingId }); },
    async getBookingStatus({ bookingId }) { return supabase.from('bookings').select('booking_id,status,payment_state,hold_expires_at').eq('property_id', propertyId).eq('booking_id', bookingId).maybeSingle(); },
  });
}

function createMockExternalPmsAdapter({ propertyId, inventory = new Map() }) {
  const holds = new Map();
  const owned = (id) => { const row = holds.get(id); if (!row || row.propertyId !== propertyId) throw new Error('PMS booking not found'); return row; };
  return assertAdapter({
    async getAvailability({ roomType }) { return [...inventory.values()].filter(r => !roomType || r.roomType === roomType); },
    async createHold({ bookingId, roomType, expiresAt }) {
      const room = [...inventory.values()].find(r => r.roomType === roomType && r.available > 0);
      if (!room) return { ok: false, code: 'room_no_longer_available' };
      room.available--; holds.set(bookingId, { propertyId, room, status: 'hold', expiresAt }); return { ok: true, bookingId, expiresAt };
    },
    async confirmBooking({ bookingId }) { const h = owned(bookingId); if (h.status !== 'hold') return { ok: false, code: 'invalid_transition' }; h.status = 'confirmed'; return { ok: true }; },
    async releaseHold({ bookingId }) { const h = owned(bookingId); if (h.status === 'hold') h.room.available++; h.status = 'released'; return { ok: true }; },
    async getBookingStatus({ bookingId }) { const h = owned(bookingId); return { bookingId, status: h.status, expiresAt: h.expiresAt }; },
  });
}

module.exports = { assertAdapter, createLocalInventoryAdapter, createMockExternalPmsAdapter };
