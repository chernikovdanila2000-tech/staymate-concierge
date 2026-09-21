/* ============================================================
   StayAI — інструменти (tools) для ШІ-адміністратора
   Мультитенантна версія: createTools(propertyId) повертає набір
   інструментів, прив'язаних до конкретного готелю. Кожен виклик
   check_availability / create_booking / escalate_to_human працює
   тільки з даними цього property_id (rooms/bookings/escalations
   у Supabase). create_booking також створює рахунок на оплату
   через WayForPay.
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const WFP_MERCHANT_ACCOUNT = process.env.WAYFORPAY_MERCHANT_ACCOUNT || 'test_merch_n1';
const WFP_MERCHANT_SECRET = process.env.WAYFORPAY_MERCHANT_SECRET || 'flk3409refn54t54t*FNJRET';
const WFP_DOMAIN = process.env.WAYFORPAY_DOMAIN || 'stayai.online';
const WFP_API_URL = 'https://api.wayforpay.com/api';

// Публічний домен САМОГО СЕРВЕРА (Railway) — сюди WayForPay надсилає webhook
// про оплату. Це НЕ маркетинговий сайт (Netlify) — там цього роуту немає.
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

function nightsBetween(checkIn, checkOut) {
  const ms = new Date(checkOut) - new Date(checkIn);
  const nights = Math.round(ms / (1000 * 60 * 60 * 24));
  return nights > 0 ? nights : 1;
}

function wfpSignature(fields) {
  const str = fields.join(';');
  return crypto.createHmac('md5', WFP_MERCHANT_SECRET).update(str).digest('hex');
}

async function createWayForPayInvoice({ orderReference, productName, price, serviceUrl, currency = 'UAH', regular }) {
  const orderDate = Math.floor(Date.now() / 1000);
  const signature = wfpSignature([
    WFP_MERCHANT_ACCOUNT,
    WFP_DOMAIN,
    orderReference,
    orderDate,
    price,
    currency,
    productName,
    1,
    price,
  ]);

  const body = {
    transactionType: 'CREATE_INVOICE',
    merchantAccount: WFP_MERCHANT_ACCOUNT,
    merchantAuthType: 'SimpleSignature',
    merchantDomainName: WFP_DOMAIN,
    merchantSignature: signature,
    apiVersion: 1,
    language: 'UA',
    serviceUrl: serviceUrl || `${API_BASE_URL}/webhook/wayforpay`,
    returnUrl: process.env.CABINET_URL || 'https://stayai.online/cabinet/',
    orderReference,
    orderDate,
    amount: price,
    currency,
    orderTimeout: 86400, // рахунок дійсний 24 години
    productName: [productName],
    productPrice: [price],
    productCount: [1],
  };

  // Автопродовження (пробний період із картою → автосписання після його
  // закінчення). ВАЖЛИВО: ці поля (regularMode/regularCount/dateBegin)
  // зібрані з публічних джерел WayForPay, але НЕ перевірені напряму проти
  // їхньої документації в цьому середовищі (мережевий доступ до
  // wiki.wayforpay.com заблоковано) — перед реальними списаннями це
  // обов'язково перевірити в пісочниці WayForPay разом з їхньою підтримкою.
  if (regular) {
    body.regularMode = regular.mode || 'monthly';
    body.regularCount = regular.count || 120; // "необмежено" на практиці
    body.dateBegin = regular.dateBegin; // unix timestamp першого фактичного списання
  }

  const response = await fetch(WFP_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();

  if (data.reasonCode !== 1100 || !data.invoiceUrl) {
    throw new Error(`WayForPay: ${data.reason || 'невідома помилка'} (code ${data.reasonCode})`);
  }
  return { invoiceUrl: data.invoiceUrl, orderReference: data.orderReference || orderReference };
}

// Скасування регулярного платежу на стороні WayForPay — best-effort.
// НЕ покладаємось на це як на єдиний захист від списання: перед цим
// викликом сервер ЗАВЖДИ спершу вимикає auto_renew в БД (єдине надійне
// джерело правди), а цей виклик — лише спроба прибрати мандат і на боці
// самого WayForPay. Поле transactionType тут теж не перевірено проти живої
// документації — потребує підтвердження перед продакшеном.
async function cancelRegularPayment(orderReference) {
  const signature = wfpSignature([WFP_MERCHANT_ACCOUNT, orderReference]);
  try {
    const response = await fetch(WFP_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactionType: 'REMOVE_REGULAR_PAYMENT',
        merchantAccount: WFP_MERCHANT_ACCOUNT,
        merchantSignature: signature,
        orderReference,
        apiVersion: 1,
      }),
    });
    const data = await response.json();
    return { ok: data.reasonCode === 1100, raw: data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Тарифи підписки StayAI — ціна в EUR, як заявлено на сайті. Рахунок
 * виставляється одразу в EUR (WayForPay підтримує мультивалютність) —
 * конвертацію в гривні на картці клієнта робить сам банк-емітент за своїм
 * курсом, StayAI курс валют не рахує і не відстежує.
 */
const SUBSCRIPTION_PLANS = {
  start: { label: 'Старт', priceEur: 100 },
  pro: { label: 'Профі', priceEur: 200 },
  network: { label: 'Мережа', priceEur: 300 },
};

async function createSubscriptionInvoice({ orderId, plan, propertyName, autoRenewDateBegin }) {
  const planInfo = SUBSCRIPTION_PLANS[plan];
  if (!planInfo) {
    throw new Error(`Невідомий тариф: ${plan}`);
  }

  const { invoiceUrl } = await createWayForPayInvoice({
    orderReference: orderId,
    productName: `StayAI — тариф «${planInfo.label}» ${propertyName || ''}`.trim(),
    price: planInfo.priceEur,
    currency: 'EUR',
    serviceUrl: `${API_BASE_URL}/webhook/wayforpay-subscription`,
    // Якщо передано autoRenewDateBegin — це підключення картки одразу при
    // старті пробного періоду: перше фактичне списання станеться саме
    // тоді (закінчення тріалу), а не зараз.
    regular: autoRenewDateBegin ? { mode: 'monthly', dateBegin: autoRenewDateBegin } : undefined,
  });
  return { invoiceUrl, priceEur: planInfo.priceEur };
}

/**
 * Створює набір реалізацій інструментів, прив'язаних до конкретного property_id.
 * Схема інструментів (toolDefinitions) однакова для всіх готелів — Claude API
 * не потребує per-tenant версії схеми, тільки реалізація (виконання) різниться.
 */
function createTools(propertyId, channel, chatId) {
  async function checkAvailability({ check_in, check_out, guests } = {}) {
    let query = supabase
      .from('rooms')
      .select('room_type, price_per_night, capacity, description, quantity')
      .eq('property_id', propertyId)
      .order('price_per_night', { ascending: true });

    if (guests) query = query.gte('capacity', guests);

    const { data: roomTypes, error } = await query;

    if (error) {
      console.error('[checkAvailability] Supabase error:', error);
      return { check_in: check_in || null, check_out: check_out || null, available_rooms: [], note: 'Технічна помилка при перевірці наявності. Спробуйте ще раз трохи пізніше.' };
    }

    // Гість ще не назвав дати — показуємо каталог типів номерів і цін
    // без перевірки зайнятості (Фаза 1.2 плану).
    if (!check_in || !check_out) {
      return {
        check_in: null,
        check_out: null,
        available_rooms: roomTypes.map(r => ({
          room_type: r.room_type,
          price_per_night: r.price_per_night,
          capacity: r.capacity,
          description: r.description,
        })),
        note: roomTypes.length
          ? 'Каталог показано без перевірки дат — щоб перевірити фактичну наявність і забронювати, потрібні дати заїзду й виїзду.'
          : 'У цього закладу поки не додано жодного номера.',
      };
    }

    // Дати вказано — рахуємо, скільки номерів кожного типу вже зайнято
    // бронями, що перетинаються з цим періодом, і порівнюємо з кількістю
    // фізичних номерів цього типу (Фаза 1.1 плану).
    const { data: overlapping, error: bookingsError } = await supabase
      .from('bookings')
      .select('room_type')
      .eq('property_id', propertyId)
      .in('status', ['pending_payment', 'paid'])
      .lt('check_in', check_out)
      .gt('check_out', check_in);

    if (bookingsError) {
      console.error('[checkAvailability] Supabase error (bookings):', bookingsError);
      return { check_in, check_out, available_rooms: [], note: 'Технічна помилка при перевірці зайнятості. Спробуйте ще раз трохи пізніше.' };
    }

    const bookedCounts = {};
    for (const b of overlapping) {
      bookedCounts[b.room_type] = (bookedCounts[b.room_type] || 0) + 1;
    }

    const available = roomTypes
      .filter(r => (bookedCounts[r.room_type] || 0) < (r.quantity ?? 1))
      .map(r => ({
        room_type: r.room_type,
        price_per_night: r.price_per_night,
        capacity: r.capacity,
        description: r.description,
      }));

    return {
      check_in,
      check_out,
      available_rooms: available,
      note: available.length ? null : 'На ці дати вільних номерів немає — запропонуйте гостю інші дати.',
    };
  }

  async function createBooking({ room_type, check_in, check_out, guest_name, guest_contact }) {
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('room_type, price_per_night')
      .eq('property_id', propertyId)
      .eq('room_type', room_type)
      .maybeSingle();

    if (roomError) {
      console.error('[createBooking] Supabase error (room lookup):', roomError);
      return { ok: false, error: 'Технічна помилка при пошуку номера.' };
    }
    if (!room) {
      return { ok: false, error: `Тип номера "${room_type}" не знайдено серед доступних варіантів.` };
    }

    const bookingId = 'BK' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const nights = nightsBetween(check_in, check_out);
    const totalPrice = room.price_per_night * nights;

    let paymentLink;
    try {
      ({ invoiceUrl: paymentLink } = await createWayForPayInvoice({
        orderReference: bookingId,
        productName: `${room.room_type} — ${nights} ${nights === 1 ? 'ніч' : 'ночі'} (${check_in} — ${check_out})`,
        price: totalPrice,
      }));
    } catch (wfpError) {
      console.error('[createBooking] WayForPay error:', wfpError.message);
      return { ok: false, error: 'Технічна помилка при створенні посилання на оплату.' };
    }

    const { data: booking, error: insertError } = await supabase
      .from('bookings')
      .insert({
        booking_id: bookingId,
        property_id: propertyId,
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
    console.log(`[ESCALATION ${propertyId}${urgency ? ' - ' + urgency : ''}] ${reason}`);

    const { error } = await supabase
      .from('escalations')
      .insert({
        property_id: propertyId,
        reason,
        urgency: urgency || 'normal',
        status: 'open',
        channel: channel || null,
        chat_id: chatId != null ? String(chatId) : null,
      });

    if (error) {
      console.error('[escalateToHuman] Supabase error:', error);
    }

    return { ok: true, message: 'Звернення передано адміністрації закладу.' };
  }

  return {
    check_availability: checkAvailability,
    create_booking: createBooking,
    escalate_to_human: escalateToHuman,
  };
}

/* ---------- схема інструментів для Claude API (однакова для всіх готелів) ---------- */
const toolDefinitions = [
  {
    name: 'check_availability',
    description: 'Показати номери готелю з цінами. Можна викликати БЕЗ дат, якщо гість просто питає "які у вас є номери" — тоді повертається каталог без перевірки зайнятості. Якщо вказано дати заїзду й виїзду — додатково перевіряється реальна зайнятість на цей період.',
    input_schema: {
      type: 'object',
      properties: {
        check_in: { type: 'string', description: 'Дата заїзду у форматі YYYY-MM-DD (необов\'язково для простого каталогу)' },
        check_out: { type: 'string', description: 'Дата виїзду у форматі YYYY-MM-DD (необов\'язково для простого каталогу)' },
        guests: { type: 'integer', description: 'Кількість гостей (необов\'язково)' },
      },
      required: [],
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

module.exports = { toolDefinitions, createTools, createSubscriptionInvoice, cancelRegularPayment, SUBSCRIPTION_PLANS };
