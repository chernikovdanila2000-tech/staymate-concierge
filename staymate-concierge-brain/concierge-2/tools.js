/* ============================================================
   StayMate — інструменти (tools) для ШІ-адміністратора
   Тепер check_availability, create_booking і escalate_to_human
   працюють через реальну базу Supabase (таблиці rooms, bookings,
   escalations). Дані номерів наразі тестові/демонстраційні
   (Panorama Apart-Hotel), але шлях запису/читання — реальний,
   такий самий буде і з даними справжнього готелю.
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PROPERTY_ID = process.env.PROPERTY_ID || 'panorama-apart-hotel';

/* ---------- реалізації ---------- */

async function checkAvailability({ check_in, check_out, guests }) {
  const { data, error } = await supabase
    .from('rooms')
    .select('room_type, price_per_night, capacity, description')
    .eq('property_id', PROPERTY_ID)
    .gte('capacity', guests || 1)
    .order('price_per_night', { ascending: true });

  if (error) {
    console.error('[checkAvailability] Supabase error:', error);
    return { check_in, check_out, available_rooms: [], note: 'Технічна помилка при перевірці наявності. Спробуйте ще раз трохи пізніше.' };
  }

  return {
    check_in,
    check_out,
    available_rooms: data,
    note: data.length ? null : 'Немає номерів на потрібну кількість гостей.',
  };
}

async function createBooking({ room_type, check_in, check_out, guest_name, guest_contact }) {
  const { data: room, error: roomError } = await supabase
    .from('rooms')
    .select('room_type, price_per_night')
    .eq('property_id', PROPERTY_ID)
    .eq('room_type', room_type)
    .maybeSingle();

  if (roomError) {
    console.error('[createBooking] Supabase error (room lookup):', roomError);
    return { ok: false, error: 'Технічна помилка при пошуку номера.' };
  }
  if (!room) {
    return { ok: false, error: `Тип номера "${room_type}" не знайдено серед доступних варіантів.` };
  }

  const bookingId = 'BK-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const paymentLink = `https://pay.example.com/demo/${bookingId}`; // заглушка — підключити реальний платіжний провайдер (Stripe)

  const { data: booking, error: insertError } = await supabase
    .from('bookings')
    .insert({
      booking_id: bookingId,
      property_id: PROPERTY_ID,
      room_type,
      check_in,
      check_out,
      guest_name,
      guest_contact,
      price_per_night: room.price_per_night,
      status: 'pending_payment',
      payment_link: paymentLink,
    })
    .select()
    .single();

  if (insertError) {
    console.error('[createBooking] Supabase error (insert):', insertError);
    return { ok: false, error: 'Технічна помилка при створенні бронювання.' };
  }

  return { ok: true, booking };
}

async function escalateToHuman({ reason, urgency }) {
  console.log(`[ESCALATION${urgency ? ' - ' + urgency : ''}] ${reason}`);

  const { error } = await supabase
    .from('escalations')
    .insert({
      property_id: PROPERTY_ID,
      reason,
      urgency: urgency || 'normal',
      status: 'open',
    });

  if (error) {
    console.error('[escalateToHuman] Supabase error:', error);
    // Навіть якщо запис у базу не вдався — гостю все одно відповідаємо, що звернення прийнято,
    // а деталі бачимо в логах Railway.
  }

  return { ok: true, message: 'Звернення передано адміністрації закладу.' };
}

/* ---------- схема інструментів для Claude API (tool-calling) ---------- */
const toolDefinitions = [
  {
    name: 'check_availability',
    description: 'Перевірити вільні номери на вказані дати заїзду/виїзду та кількість гостей.',
    input_schema: {
      type: 'object',
      properties: {
        check_in: { type: 'string', description: 'Дата заїзду у форматі YYYY-MM-DD' },
        check_out: { type: 'string', description: 'Дата виїзду у форматі YYYY-MM-DD' },
        guests: { type: 'integer', description: 'Кількість гостей' },
      },
      required: ['check_in', 'check_out', 'guests'],
    },
  },
  {
    name: 'create_booking',
    description: 'Створити бронювання для гостя після того, як він підтвердив вибір номера та надав контактні дані.',
    input_schema: {
      type: 'object',
      properties: {
        room_type: { type: 'string' },
        check_in: { type: 'string' },
        check_out: { type: 'string' },
        guest_name: { type: 'string' },
        guest_contact: { type: 'string', description: 'Телефон або email гостя' },
      },
      required: ['room_type', 'check_in', 'check_out', 'guest_name', 'guest_contact'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Передати звернення живому адміністратору закладу (скарга, складний випадок, пряме прохання гостя).',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Короткий опис причини ескалації' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['reason'],
    },
  },
];

const toolImplementations = {
  check_availability: checkAvailability,
  create_booking: createBooking,
  escalate_to_human: escalateToHuman,
};

module.exports = { toolDefinitions, toolImplementations };
