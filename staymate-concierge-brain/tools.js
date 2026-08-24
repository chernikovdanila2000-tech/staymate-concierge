/* ============================================================
   StayMate — інструменти (tools) для ШІ-адміністратора
   Зараз check_availability і create_booking працюють на ЗАГЛУШКАХ
   (демо-дані нижче). Коли підключимо реальну базу Supabase,
   потрібно замінити лише тіло функцій нижче — визначення tools
   (схема для Claude) можна лишити без змін.
   ============================================================ */

/* ---------- демо-дані (замінити на запити до Supabase пізніше) ---------- */
const DEMO_ROOMS = [
  { room_type: 'Стандарт', price_per_night: 1400, capacity: 2, description: 'Затишний номер з ліжком queen-size, душ, сніданок не включено.' },
  { room_type: 'Комфорт',  price_per_night: 1900, capacity: 2, description: 'Більша площа, вид на місто, сніданок включено.' },
  { room_type: 'Сімейний', price_per_night: 2600, capacity: 4, description: 'Два окремих ліжка + розкладний диван, підходить для родини.' },
];

const bookingsStore = []; // тимчасове сховище в пам'яті процесу — замінити на таблицю в Supabase

/* ---------- реалізації ---------- */

async function checkAvailability({ check_in, check_out, guests }) {
  // TODO: замінити на реальний запит до Supabase/PMS за property_id, датами і місткістю.
  const suitable = DEMO_ROOMS.filter(r => r.capacity >= (guests || 1));
  return {
    check_in,
    check_out,
    available_rooms: suitable,
    note: suitable.length ? null : 'Немає номерів на потрібну кількість гостей у демо-даних.',
  };
}

async function createBooking({ room_type, check_in, check_out, guest_name, guest_contact }) {
  // TODO: замінити на INSERT у таблицю bookings в Supabase + реальне посилання оплати
  // (Stripe/LiqPay/Fondy checkout session).
  const room = DEMO_ROOMS.find(r => r.room_type === room_type);
  if (!room) {
    return { ok: false, error: `Тип номера "${room_type}" не знайдено серед доступних варіантів.` };
  }
  const bookingId = 'DEMO-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const booking = {
    booking_id: bookingId,
    room_type,
    check_in,
    check_out,
    guest_name,
    guest_contact,
    price_per_night: room.price_per_night,
    status: 'pending_payment',
    payment_link: `https://pay.example.com/demo/${bookingId}`, // заглушка — підключити реальний платіжний провайдер
  };
  bookingsStore.push(booking);
  return { ok: true, booking };
}

async function escalateToHuman({ reason, urgency }) {
  // TODO: замінити на реальне сповіщення персоналу (Telegram-канал адміністрації,
  // email, або запис у таблицю escalations в Supabase з подальшим сповіщенням).
  console.log(`[ESCALATION${urgency ? ' - ' + urgency : ''}] ${reason}`);
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
