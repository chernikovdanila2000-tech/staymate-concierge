/* ============================================================
   StayAI — інструменти (tools) для ШІ-адміністратора
   Мультитенантна версія: createTools(propertyId) повертає набір
   інструментів, прив'язаних до конкретного готелю. Кожен виклик
   check_availability / create_booking / escalate_to_human працює
   тільки з даними цього property_id (rooms/bookings/escalations
   у Supabase). create_booking створює рахунок виключно через
   Monobank acquiring.
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { createMonobankInvoice } = require('./monobank');
const { getMonobankMerchant } = require('./merchant-credentials');

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
const MONOBANK_SINGLE_TENANT_PILOT = process.env.MONOBANK_SINGLE_TENANT_PILOT === 'true';

function nightsBetween(checkIn, checkOut) {
  const ms = new Date(checkOut) - new Date(checkIn);
  const nights = Math.round(ms / (1000 * 60 * 60 * 24));
  return nights > 0 ? nights : 1;
}

function validStayDates(checkIn, checkOut) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(checkIn || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(checkOut || ''))
    && new Date(`${checkOut}T00:00:00Z`) > new Date(`${checkIn}T00:00:00Z`);
}

function bookingRequestKey({ propertyId, channel, chatId, roomType, checkIn, checkOut, guestName, guestContact }) {
  const stable = [propertyId, channel || '', chatId || '', roomType, checkIn, checkOut, String(guestName || '').trim(), String(guestContact || '').trim()].join('\u001f');
  return crypto.createHash('sha256').update(stable).digest('hex');
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
function createTools(propertyId, channel, chatId, dependencies = {}) {
  const db = dependencies.supabase || supabase;
  const createInvoice = dependencies.createMonobankInvoice || createMonobankInvoice;
  const resolveMerchant = dependencies.resolveMerchant || ((id) => getMonobankMerchant(db, id, { allowSingleTenantFallback: MONOBANK_SINGLE_TENANT_PILOT }));
  async function checkAvailability({ check_in, check_out, guests } = {}) {
    if ((check_in || check_out) && !validStayDates(check_in, check_out)) {
      return { ok: false, code: 'invalid_stay_dates', available_rooms: [] };
    }
    const guestCount = guests == null ? null : Number(guests);
    if (guestCount != null && (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20)) {
      return { ok: false, code: 'invalid_guest_count', available_rooms: [] };
    }
    let query = db
      .from('rooms')
      .select('room_type, price_per_night, capacity, description, quantity')
      .eq('property_id', propertyId)
      .order('price_per_night', { ascending: true });

    if (guestCount) query = query.gte('capacity', guestCount);

    // Гість ще не назвав дати — показуємо каталог типів номерів і цін
    // без перевірки зайнятості (Фаза 1.2 плану).
    if (!check_in || !check_out) {
      const { data: roomTypes, error } = await query;
      if (error) {
        console.error('[checkAvailability] Supabase error:', error);
        return { check_in: null, check_out: null, available_rooms: [], note: 'Технічна помилка при перевірці наявності. Спробуйте ще раз трохи пізніше.' };
      }
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

    // Dates are present: these independent reads run concurrently to remove
    // one network wait from the phone path.
    const bookingsQuery = db
      .from('bookings')
      .select('room_type,status,hold_expires_at')
      .eq('property_id', propertyId)
      .in('status', ['pending_payment', 'paid'])
      .lt('check_in', check_out)
      .gt('check_out', check_in);

    const [{ data: roomTypes, error }, { data: overlapping, error: bookingsError }] = await Promise.all([query, bookingsQuery]);

    if (error) {
      console.error('[checkAvailability] Supabase error:', error);
      return { check_in, check_out, available_rooms: [], note: 'Технічна помилка при перевірці наявності. Спробуйте ще раз трохи пізніше.' };
    }

    if (bookingsError) {
      console.error('[checkAvailability] Supabase error (bookings):', bookingsError);
      return { check_in, check_out, available_rooms: [], note: 'Технічна помилка при перевірці зайнятості. Спробуйте ще раз трохи пізніше.' };
    }

    const bookedCounts = {};
    for (const b of overlapping) {
      // An uncompleted acquiring hold stops consuming inventory as soon as its
      // explicit expiry passes. Legacy rows with no expiry remain occupied.
      if (b.status === 'pending_payment' && b.hold_expires_at && new Date(b.hold_expires_at) <= new Date()) continue;
      bookedCounts[b.room_type] = (bookedCounts[b.room_type] || 0) + 1;
    }

    const nights = nightsBetween(check_in, check_out);
    const available = roomTypes
      .filter(r => (bookedCounts[r.room_type] || 0) < (r.quantity ?? 1))
      .map(r => ({
        room_type: r.room_type,
        price_per_night: r.price_per_night,
        total_price: Number(r.price_per_night) * nights,
        nights,
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
    if (!validStayDates(check_in, check_out) || !room_type || !String(guest_name || '').trim() || !String(guest_contact || '').trim()) {
      return { ok: false, code: 'booking_details_required' };
    }
    // A merchant is selected server-side by property. Never accept a merchant
    // ID/token from a voice tool or reuse an unrelated hotel's token.
    let merchant;
    try { merchant = await resolveMerchant(propertyId); } catch (error) {
      console.error('[createBooking] merchant lookup failed:', error.message);
      return { ok: false, code: 'payment_unavailable' };
    }
    if (!merchant) return { ok: false, code: 'payment_unavailable' };
    const requestKey = bookingRequestKey({ propertyId, channel, chatId, roomType: room_type, checkIn: check_in, checkOut: check_out, guestName: guest_name, guestContact: guest_contact });
    const bookingId = `BK${requestKey.slice(0, 10).toUpperCase()}`;
    const { data: hold, error: holdError } = await db.rpc('booking_prepare_monobank_hold', {
      p_property_id: propertyId, p_booking_id: bookingId, p_request_key: requestKey, p_room_type: room_type,
      p_check_in: check_in, p_check_out: check_out, p_guest_name: guest_name, p_guest_contact: guest_contact, p_hold_minutes: 15,
    });
    if (holdError || !hold?.ok) {
      if (holdError) console.error('[createBooking] hold failed:', holdError.message);
      return { ok: false, code: hold?.code || 'booking_hold_unavailable' };
    }
    if (hold.idempotent) {
      if (hold.booking?.payment_link) return { ok: true, booking: hold.booking, payment_instructions: null, idempotent: true };
      // We may have timed out after Monobank received an earlier request.
      // Do not create a second invoice against the same hold; let it expire
      // safely and ask the caller to retry later.
      return { ok: false, code: 'payment_invoice_pending' };
    }

    const { data: bound, error: bindError } = await db.rpc('booking_bind_monobank_merchant', {
      p_property_id: propertyId, p_booking_id: bookingId, p_merchant_id: merchant.merchant_id,
    });
    if (bindError || !bound) {
      console.error('[createBooking] merchant binding failed:', bindError?.message || 'not_bound');
      return { ok: false, code: 'payment_unavailable' };
    }

    // Guest reservations use Monobank acquiring only. No direct card/IBAN
    // transfer and no WayForPay fallback is permitted for this path.
    let paymentLink; let paymentReference;
    try {
      const invoice = await createInvoice(merchant.token, {
        amountKopecks: Math.round(Number(hold.booking.total_price) * 100), reference: bookingId,
        destination: `${hold.booking.room_type} — ${check_in} — ${check_out}`,
        webHookUrl: `${API_BASE_URL}/webhook/monobank/acquiring`, redirectUrl: process.env.MONOBANK_PAYMENT_RETURN_URL || `${API_BASE_URL}/payment/result`, validitySeconds: 15 * 60,
      });
      paymentLink = invoice.pageUrl; paymentReference = invoice.invoiceId;
    } catch (monoError) {
      console.error('[createBooking] Monobank acquiring error:', monoError.message);
      // Do not release after an ambiguous provider failure: an invoice might
      // have been created despite a network timeout. The hold expires shortly.
      return { ok: false, code: 'payment_invoice_unavailable' };
    }
    const { data: attached, error: attachError } = await db.rpc('booking_attach_monobank_invoice', {
      p_property_id: propertyId, p_booking_id: bookingId, p_invoice_id: paymentReference, p_payment_link: paymentLink,
    });
    if (attachError || !attached) {
      console.error('[createBooking] invoice attachment failed:', attachError?.message || 'not_attached');
      return { ok: false, code: 'booking_finalize_unavailable' };
    }
    return { ok: true, booking: { ...hold.booking, payment_link: paymentLink, payment_reference: paymentReference }, payment_instructions: null };
  }

  async function escalateToHuman({ reason, urgency }) {
    console.log(`[ESCALATION ${propertyId}${urgency ? ' - ' + urgency : ''}] ${reason}`);

    const { error } = await db
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

module.exports = { toolDefinitions, createTools, createSubscriptionInvoice, cancelRegularPayment, SUBSCRIPTION_PLANS, validStayDates, bookingRequestKey, nightsBetween };
