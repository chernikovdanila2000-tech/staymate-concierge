import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const KEY_MAP = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const SECRET_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || KEY_MAP.default || "";
if (!SUPABASE_URL || !SECRET_KEY) throw new Error("Supabase service credentials unavailable");
const db = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const API_URL = "https://api.monobank.ua";
const WEBHOOK_URL = SUPABASE_URL + "/functions/v1/mono-subscriptions/webhook";
const REDIRECT_URL = "https://stayai.online/cabinet/";
const ALLOWED_ORIGINS = new Set(["https://stayai.online", "https://www.stayai.online"]);
const PLANS = {
  start: { amountUah: 4999, label: "Старт" },
  pro: { amountUah: 9999, label: "Профі" },
  network: { amountUah: 14999, label: "Мережа" },
};
let merchantToken = "";
let merchantTokenExpiresAt = 0;
let cachedPublicKey = null;
let publicKeyFetchedAt = 0;

function json(status, data, origin = "") {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization,content-type,apikey,x-client-info");
    headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

class SafeError extends Error {
  constructor(status, publicMessage) { super(publicMessage); this.status = status; }
}
function randomReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "SUB" + Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}
async function getMerchantToken() {
  if (merchantToken && Date.now() < merchantTokenExpiresAt) return merchantToken;
  const { data, error } = await db.rpc("stayai_mono_merchant_token");
  if (error || typeof data !== "string" || !data) throw new SafeError(503, "mono зараз недоступний.");
  merchantToken = data;
  merchantTokenExpiresAt = Date.now() + 15 * 60 * 1000;
  return data;
}
async function monoRequest(path, options = {}) {
  const token = await getMerchantToken();
  const res = await fetch(API_URL + path, {
    method: options.method || "GET",
    headers: {
      "X-Token": token,
      "X-Cms": "StayAI",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new SafeError(502, "mono відхилив запит. Код: " + res.status);
  return res.json();
}
async function ownerFromRequest(req) {
  const header = req.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/);
  if (!match) throw new SafeError(401, "Спочатку увійдіть у кабінет.");
  const { data, error } = await db.auth.getUser(match[1]);
  if (error || !data?.user?.id) throw new SafeError(401, "Сесія завершилась. Увійдіть знову.");
  return data.user.id;
}
async function createInvoice(req, origin) {
  const ownerId = await ownerFromRequest(req);
  const length = Number(req.headers.get("content-length") || "0");
  if (length > 8192) throw new SafeError(413, "Завеликий запит.");
  const raw = await req.text();
  if (raw.length > 8192) throw new SafeError(413, "Завеликий запит.");
  let input;
  try { input = JSON.parse(raw); } catch { throw new SafeError(400, "Некоректний JSON."); }
  const propertyId = input?.propertyId;
  const plan = input?.plan;
  const isQaTest = input?.qaTest === true;
  if (typeof propertyId !== "string" || propertyId.length > 180 ||
      (!isQaTest && !Object.hasOwn(PLANS, plan))) {
    throw new SafeError(400, "Невірні дані тарифу.");
  }
  const { data: property, error: lookupError } = await db.from("properties")
    .select("property_id,hotel_name").eq("property_id", propertyId)
    .eq("owner_id", ownerId).maybeSingle();
  if (lookupError) throw new SafeError(503, "Не вдалося перевірити готель.");
  if (!property) throw new SafeError(403, "Немає доступу до готелю.");
  if (isQaTest) {
    const { data: admin, error: adminError } = await db.from("internal_launch_admins")
      .select("user_id").eq("user_id", ownerId).maybeSingle();
    if (adminError || !admin) throw new SafeError(403, "Тестова оплата доступна лише адміністратору StayAI.");
  }
  const amountUah = isQaTest ? 1 : PLANS[plan].amountUah;
  const planForDb = isQaTest ? "mono_qa_1uah" : plan;
  const orderId = randomReference();
  const response = await monoRequest("/api/merchant/invoice/create", {
    method: "POST",
    body: {
      amount: amountUah * 100, ccy: 980, paymentType: "debit",
      merchantPaymInfo: {
        reference: orderId,
        destination: isQaTest ? "StayAI: технічна перевірка 1 грн" : "StayAI: тариф " + PLANS[plan].label,
      },
      webHookUrl: WEBHOOK_URL,
      redirectUrl: REDIRECT_URL,
      validity: isQaTest ? 3600 : 86400,
    },
  });
  let url;
  try { url = new URL(response.pageUrl); } catch { throw new SafeError(502, "Невірна платіжна адреса mono."); }
  if (typeof response.invoiceId !== "string" || !response.invoiceId ||
      url.protocol !== "https:" || url.hostname !== "pay.mbnk.biz" || url.username || url.password) {
    throw new SafeError(502, "Невірна платіжна відповідь mono.");
  }
  const { error: insertError } = await db.from("subscription_orders").insert({
    order_id: orderId, property_id: propertyId, plan: planForDb,
    amount_uah: amountUah, mono_invoice_id: response.invoiceId,
    payment_provider: "monobank", is_trial_card: false, status: "pending",
  });
  if (insertError) {
    try { await monoRequest("/api/merchant/invoice/remove", {
      method: "POST", body: { invoiceId: response.invoiceId },
    }); } catch { /* invoice remains orphaned, cannot activate subscription */ }
    throw new SafeError(503, "Не вдалося зберегти платіж.");
  }
  return json(200, { invoiceUrl: url.toString(), orderId, priceUah: amountUah, isTest: isQaTest }, origin);
}

function decodeBase64(str) {
  const s = atob(str);
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
function readDerSignature(der) {
  let pos = 0;
  function len() {
    if (pos >= der.length) throw new Error("DER length");
    let n = der[pos++];
    if (n & 128) {
      const size = n & 127;
      if (!size || size > 2) throw new Error("DER long length");
      n = 0;
      for (let i=0;i<size;i++) {
        if (pos >= der.length) throw new Error("DER length");
        n = (n << 8) + der[pos++];
      }
    }
    return n;
  }
  if (der[pos++] !== 0x30) throw new Error("DER sequence");
  const sequenceLen = len();
  if (sequenceLen !== der.length-pos) throw new Error("DER sequence length");
  const halves = [];
  for (let i=0;i<2;i++) {
    if (der[pos++] !== 0x02) throw new Error("DER integer");
    const size = len();
    if (!size || size > 33 || pos+size > der.length) throw new Error("DER integer length");
    let part = der.slice(pos,pos+size);
    pos += size;
    while (part.length > 1 && part[0] === 0) part = part.slice(1);
    if (part.length > 32) throw new Error("DER integer size");
    const padded = new Uint8Array(32);
    padded.set(part, 32-part.length);
    halves.push(padded);
  }
  if (pos !== der.length) throw new Error("DER trailing bytes");
  const raw = new Uint8Array(64);
  raw.set(halves[0], 0); raw.set(halves[1], 32);
  return raw;
}
async function publicKey(force = false) {
  if (cachedPublicKey && !force) return cachedPublicKey;
  const response = await monoRequest("/api/merchant/pubkey");
  if (typeof response.key !== "string") throw new SafeError(502, "Немає ключа перевірки mono.");
  const text = new TextDecoder().decode(decodeBase64(response.key));
  const match = text.match(/-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/);
  if (!match) throw new SafeError(502, "Недійсний ключ mono.");
  const der = decodeBase64(match[1].replace(/\s+/g, ""));
  cachedPublicKey = await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  publicKeyFetchedAt = Date.now();
  return cachedPublicKey;
}
async function validWebhookSignature(body, sign) {
  if (typeof sign !== "string" || sign.length < 16 || sign.length > 512 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(sign)) return false;
  let rawSign;
  try { rawSign = readDerSignature(decodeBase64(sign)); } catch { return false; }
  try {
    let key = await publicKey();
    if (await crypto.subtle.verify({ name:"ECDSA",hash:"SHA-256" },key,rawSign,body)) return true;
    if (Date.now()-publicKeyFetchedAt < 60000) return false;
    key = await publicKey(true);
    return crypto.subtle.verify({ name:"ECDSA",hash:"SHA-256" },key,rawSign,body);
  } catch { return false; }
}
async function signedWebhook(req) {
  const headerLength = Number(req.headers.get("content-length") || "0");
  if (headerLength > 65536) throw new SafeError(413, "Payload too large");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > 65536) throw new SafeError(413, "Payload too large");
  const sign = req.headers.get("x-sign");
  if (!await validWebhookSignature(bytes, sign)) throw new SafeError(401, "Invalid signature");
  let event;
  try { event = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new SafeError(400, "Invalid payload"); }
  if (typeof event.invoiceId !== "string" || !event.invoiceId) throw new SafeError(400, "Missing invoiceId");
  if (event.status !== "success") return json(200, { ok: true });
  const { data: order, error: lookupError } = await db.from("subscription_orders")
    .select("order_id,property_id,plan,amount_uah,status,payment_provider,mono_invoice_id,is_trial_card")
    .eq("mono_invoice_id", event.invoiceId).maybeSingle();
  if (lookupError) throw new SafeError(503, "Invoice lookup error");
  if (!order || order.payment_provider !== "monobank" || order.is_trial_card === true) {
    throw new SafeError(404, "Invoice not recognized");
  }
  const status = await monoRequest("/api/merchant/invoice/status?invoiceId=" + encodeURIComponent(event.invoiceId));
  const amount = Number(order.amount_uah) * 100;
  if (!Number.isSafeInteger(amount) || amount <= 0 ||
      status.status !== "success" ||
      status.invoiceId !== order.mono_invoice_id ||
      status.reference !== order.order_id ||
      status.ccy !== 980 || status.amount !== amount) {
    throw new SafeError(409, "Invoice payment confirmation mismatch");
  }
  const { data, error } = await db.rpc("finalize_mono_subscription", {
    p_invoice_id: event.invoiceId, p_reference: order.order_id, p_amount_kopecks: amount,
  });
  if (error) throw new SafeError(503, "Could not finalize payment");
  const state = Array.isArray(data) ? data[0]?.result : data?.result;
  if (!["paid","already_paid","paid_test"].includes(state)) throw new SafeError(503, "Unexpected payment finalization");
  return json(200, { ok: true });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const origin = req.headers.get("Origin") || "";
  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    return json(200, { ok: true, service: "stayai-mono-subscriptions" });
  }
  const webhook = url.pathname.endsWith("/webhook");
  if (!webhook && req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "null",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,content-type,apikey,x-client-info",
      "Vary": "Origin",
    } });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" }, webhook ? "" : origin);
  try {
    return webhook ? await signedWebhook(req) : await createInvoice(req, origin);
  } catch (error) {
    const safe = error instanceof SafeError ? error : new SafeError(502, "Платіжний сервіс тимчасово недоступний.");
    console.error("[mono edge] status", safe.status);
    return json(safe.status, { error: safe.message }, webhook ? "" : origin);
  }
});
