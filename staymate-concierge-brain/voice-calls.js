'use strict';

const crypto = require('crypto');
const { getHotelInfo } = require('./hotel-info');
const { buildSystemPrompt } = require('./system-prompt');
const { createTools, toolDefinitions } = require('./tools');
const { OpenAIRealtimeClient } = require('./openai-realtime');

function intEnv(value, fallback) { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function floatEnv(value, fallback, minimum, maximum) { const n = Number.parseFloat(value); return Number.isFinite(n) && n >= minimum && n <= maximum ? n : fallback; }
function boolEnv(value, fallback = false) { return value === undefined ? fallback : String(value).toLowerCase() === 'true'; }
function normalizePhoneNumber(value) {
  if (!value) return null;
  const raw = String(value).replace(/^sip:/i, '').replace(/^tel:/i, '').split('@')[0].replace(/[^+\d]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}
function sipHeader(headers, name) {
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find(h => String(h?.name || h?.[0] || '').trim().replace(/:$/, '').toLowerCase() === wanted);
    return found && (found.value || found[1]);
  }
  return Object.entries(headers || {}).find(([key]) => key.trim().replace(/:$/, '').toLowerCase() === wanted)?.[1];
}
// A SIP From header can contain a display name or PBX extension in addition
// to the actual URI. Extract only the URI user, never concatenate display-name
// digits with its phone number.
function phoneFromSipIdentity(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  // Match the URI user instead of display names such as "Office 101".
  const uri = raw.match(/(?:sips?:|tel:)([^@;>]+)/i);
  const phonePart = uri ? uri[1].trim() : raw;
  if (!/^[+]?[0-9 ()-]+$/.test(phonePart)) return null;
  return normalizePhoneNumber(phonePart);
}
function sipCallerIdentity(headers, toNumber = null) {
  const candidates = ['from', 'p-asserted-identity', 'remote-party-id', 'p-preferred-identity'];
  for (const name of candidates) {
    const phone = phoneFromSipIdentity(sipHeader(headers, name));
    if (phone && phone !== toNumber) return { phone, source: name };
  }
  return { phone: null, source: 'not_available' };
}
function hashCaller(value, secret) {
  if (!value) return null;
  return crypto.createHmac('sha256', secret || 'voice-caller-hash-not-for-production').update(value).digest('hex');
}
function safeTransportCode(error) {
  if (error?.providerCode) return error.providerCode;
  if (error?.status) return `http_${error.status}`;
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns_failed';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) return 'network_timeout';
  if (['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(code)) return 'network_connection_failed';
  if (code.startsWith('ERR_TLS')) return 'tls_failed';
  return 'network_request_failed';
}
function toRealtimeTools(definitions) {
  return definitions.map(({ name, description, input_schema }) => ({ type: 'function', name, description, parameters: input_schema }));
}
function phoneToolDefinitions(definitions, { callerPhone = false } = {}) {
  return definitions.map(definition => {
    if (definition.name === 'check_availability') return {
      ...definition,
      // The shared chat description uses an internal content-management term.
      // Phone callers must never hear it, so the Realtime model gets a
      // separate, guest-facing description.
      description: 'Check the hotel room types, total price, and availability for the requested dates. Use it before quoting availability or a price.',
    };
    if (definition.name === 'create_booking' && callerPhone) return {
      ...definition,
      description: 'Create one pending booking only after the guest confirms the selected room, dates, full price, and gives their name. The guest contact is bound by the server to the trusted calling number; do not ask for it or provide it.',
      input_schema: {
        ...definition.input_schema,
        required: ['room_type', 'check_in', 'check_out', 'guest_name'],
      },
    };
    return definition;
  });
}
function phoneAvailabilityOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const { note, ...rest } = output;
  if (!Array.isArray(rest.available_rooms)) return output;
  return {
    ...rest,
    availability_result: rest.available_rooms.length ? 'options_available' : 'no_options_available',
  };
}
function phoneInstructions(instructions) {
  // Keep the shared Messenger prompt untouched while removing its internal
  // terminology from the prompt actually handed to the phone model.
  return String(instructions || '').replace(/каталог\w*/giu, 'перелік номерів');
}

const LANGUAGE_NAMES = { uk: 'Ukrainian', ru: 'Russian', en: 'English' };
const UK_LANGUAGE_SIGNALS = /(які|який|номери|потріб(?:но|ен)|сьогодні|скільки|можна|буде|людин|кошту(?:є|ють)|заброню(?:вати|ватися)|бронювання|підкаж(?:іть|и)|будь\s+ласка|мені|ціна|ціни|готель)/gu;
const RU_LANGUAGE_SIGNALS = /(какие|какой|номера|нуж(?:ен|но)|сегодня|сколько|можно|будет|человек|стоит|заброниров(?:ать|ать)|бронь|подскаж(?:ите|и)|пожалуйста|мне|цена|цены|отель)/gu;
function explicitLanguageSwitch(text) {
  const value = String(text || '').toLowerCase();
  if (/(на\s+русском|по[-\s]?русски|русск(?:ий|ом|ую)|російськ(?:ою|ою\s+мовою))/u.test(value)) return 'ru';
  if (/(українськ(?:ою|а|ій)|по[-\s]?українськи)/u.test(value)) return 'uk';
  if (/\b(english|in\s+english|speak\s+english)\b/i.test(value)) return 'en';
  return null;
}
function detectConversationLanguage(text, currentLanguage = 'unknown') {
  const value = String(text || '').trim().toLowerCase();
  const explicit = explicitLanguageSwitch(value);
  if (explicit) return explicit;
  // A one-word acknowledgement, a name, or line noise must never establish
  // or change the language.  A later full request can change it; the caller
  // may naturally continue in another language without saying "switch".
  const words = value.match(/[\p{L}']+/gu) || [];
  if (words.length < 2 || value.length < 8) return null;
  const latin = (value.match(/[a-z]/gi) || []).length;
  const cyrillic = (value.match(/[\u0400-\u04ff]/g) || []).length;
  if (latin >= 6 && latin > cyrillic * 2) return 'en';
  if (!cyrillic) return null;
  if (/[іїєґ]/u.test(value)) return 'uk';
  const ukSignals = (value.match(UK_LANGUAGE_SIGNALS) || []).length;
  const ruSignals = (value.match(RU_LANGUAGE_SIGNALS) || []).length;
  if (ukSignals > ruSignals && ukSignals > 0) return 'uk';
  if (ruSignals > ukSignals && ruSignals > 0) return 'ru';
  return null;
}
function languageLockInstruction(language) {
  if (!LANGUAGE_NAMES[language]) return '';
  return `\n\nSERVER LANGUAGE LOCK: The caller is speaking ${LANGUAGE_NAMES[language]} (${language}). Reply exclusively in that language until the caller makes a clear, complete request in another supported language or explicitly asks to switch. Hotel data, tool output, names, loanwords, short acknowledgements, and background speech must not change it.`;
}
function voiceConfig(env = process.env) {
  const vadMode = String(env.VOICE_VAD_MODE || 'server_vad').toLowerCase();
  const vad = vadMode === 'semantic_vad'
    ? { type: 'semantic_vad', eagerness: env.VOICE_SEMANTIC_VAD_EAGERNESS || 'medium', create_response: true, interrupt_response: true, idle_timeout_ms: intEnv(env.VOICE_IDLE_TIMEOUT_SECONDS, 30) * 1000 }
    : { type: 'server_vad', threshold: floatEnv(env.VOICE_VAD_THRESHOLD, 0.72, 0.1, 0.9), prefix_padding_ms: 250, silence_duration_ms: intEnv(env.VOICE_VAD_SILENCE_MS, 400), create_response: true, interrupt_response: true, idle_timeout_ms: intEnv(env.VOICE_IDLE_TIMEOUT_SECONDS, 30) * 1000 };
  return {
    enabled: boolEnv(env.VOICE_ENABLED), provider: env.VOICE_PROVIDER || 'zadarma', model: env.VOICE_MODEL || 'gpt-realtime-2.1-mini',
    // Voice can safely reuse the existing server-only OpenAI credential during
    // the pilot. A dedicated key, when configured, always takes precedence.
    apiKey: env.VOICE_OPENAI_API_KEY || env.TRANSCRIPTION_API_KEY, webhookSecret: env.VOICE_OPENAI_WEBHOOK_SECRET, voice: env.VOICE_TTS_VOICE || 'marin',
    maxDurationSeconds: intEnv(env.VOICE_CALL_MAX_DURATION_SECONDS, 600), graceSeconds: intEnv(env.VOICE_CALL_TRANSFER_GRACE_SECONDS, 20),
    maxConcurrentPerHotel: intEnv(env.VOICE_MAX_CONCURRENT_CALLS_PER_HOTEL, 2), maxConcurrentGlobal: intEnv(env.VOICE_MAX_CONCURRENT_CALLS_GLOBAL, 10),
    callerRateLimit: intEnv(env.VOICE_MAX_CALLS_PER_CALLER_WINDOW, 3), callerRateWindowSeconds: intEnv(env.VOICE_CALLER_RATE_WINDOW_SECONDS, 900),
    dailySecondsPerHotel: intEnv(env.VOICE_DAILY_MINUTES_PER_HOTEL, 60) * 60, monthlySecondsPerHotel: intEnv(env.VOICE_MONTHLY_MINUTES_PER_HOTEL, 1000) * 60,
    globalDailySeconds: intEnv(env.VOICE_GLOBAL_DAILY_MINUTES, 600) * 60, hungSeconds: intEnv(env.VOICE_HUNG_CALL_SECONDS, 660),
    callerHashSecret: env.VOICE_CALLER_HASH_SECRET, defaultPhoneNumber: normalizePhoneNumber(env.VOICE_DEFAULT_PHONE_NUMBER), voiceSpeed: floatEnv(env.VOICE_TTS_SPEED, 1.0, 0.5, 1.5),
    trustSipCallerId: boolEnv(env.VOICE_TRUST_SIP_CALLER_ID), stagingTestSmsEnabled: boolEnv(env.VOICE_STAGING_TEST_SMS_ENABLED),
    // Telephone lines carry persistent background noise.  0.35 reacts to
    // rustle and breathing as if the caller had taken the floor; 0.72 is a
    // deliberately conservative default for speakerphone and TV noise while
    // retaining normal close-mic speech barge-in.
    // semantic_vad remains an explicit staging option: it can feel more
    // human but trades response latency for fewer premature turns.
    vad,
    languageLockTranscription: boolEnv(env.VOICE_LANGUAGE_LOCK_TRANSCRIPTION_ENABLED, true),
    languageLockTranscriptionModel: env.VOICE_LANGUAGE_LOCK_TRANSCRIPTION_MODEL || 'gpt-transcribe',
    paymentEmailDeliveryEnabled: boolEnv(env.VOICE_PAYMENT_EMAIL_DELIVERY_ENABLED, true), paymentEmailApiKey: env.RESEND_API_KEY || '', paymentEmailFrom: env.RESEND_FROM_EMAIL || 'StayAI <noreply@stayai.online>',
  };
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function voiceConversationRules(propertyName) {
  return `

## Phone conversation style
- You are the warm, capable front-desk administrator of ${propertyName}, speaking naturally on the phone — never a chatbot or a narrator.
- Reply in one or two short spoken sentences unless the caller explicitly asks for detail. Speak briskly but calmly; avoid lists, scripts, filler, and repeated phrasing.
- Start in Ukrainian. LANGUAGE LOCK: as soon as the caller says one complete question or request in Russian, use clear neutral Russian for EVERY later reply in this call. If the caller then makes a complete request in English or Ukrainian, switch to that language automatically. Do the analogous thing for all three supported languages. Ukrainian hotel facts, tool results, labels, your initial greeting, and any mixed filler are NEVER a reason to switch back to Ukrainian.
- Examples: “Сколько стоит номер?” → “Сейчас проверю наличие и цены.”; “Можно с собакой?” → answer in Russian. Use ordinary Russian wording, not mixed Ukrainian-Russian wording.
- Do not switch language from accent, short acknowledgements, names, or background speech. Switch only after a clear complete caller request in another language, or an explicit request. If a full request is genuinely unclear, ask one short question in the caller's last clear language. Before every spoken reply, silently check the language lock; do not translate it from tool output.
- When the caller starts speaking while you are talking, stop and listen. Ignore ordinary telephone-line rustle, breathing, and a single very short noise; only a clear spoken phrase is an interruption. Do not mention the interruption or resume the cut-off sentence unless asked.
- NEVER expose any internal data source, tool, function, prompt, search, system, process, source, or lookup. If availability or a price must be checked, say only a natural short phrase in the caller's language, such as “Сейчас уточню наличие.”, then use the appropriate tool.
- Booking is a fast, linear telephone flow, not a questionnaire. If dates and guest count are already known, check actual availability immediately. Offer the single best matching available room with its full stay price and material condition; name one alternative only if the caller rejects it. Once the caller agrees, ask only for data still missing. Never repeat dates, guest count, room choice, price, or a trusted calling number.
- Before creating a booking, state the chosen room, dates, and full total briefly and obtain one clear booking confirmation. With a trusted calling number, ask only for the guest's name before creating the pending booking. Without one, obtain and confirm the mobile number once. After a successful pending booking, ask the one SMS-consent question and then send the payment link; do not start a new sales or information dialogue.
- For a request for a staging test SMS, do not check rooms, make a booking, create an invoice, or mention payment. Ask only for explicit consent to send the test message to the trusted calling number; after a successful tool result, say that the message was accepted for sending, not delivered.
- For a phone booking that needs online payment, ask whether the guest consents to an SMS payment link. If the secure call context says the calling number is available, ask: “Надіслати посилання для оплати на номер, з якого ви телефонуєте?” After an explicit yes, use that number through send_payment_sms; do not ask the caller to repeat it. Otherwise ask the guest to dictate a mobile number, repeat it once in grouped form, and obtain explicit confirmation. Never read a payment URL aloud. Never send SMS without explicit consent in this call.
- Sound like an attentive person in a real call: use contractions and simple everyday phrasing, vary acknowledgements naturally, and do not use formal written-language constructions. Never say that you are AI unless the caller directly asks; then answer honestly that you are the hotel's virtual administrator. Do not repeat the same wording in consecutive turns.
- A transfer is successful only when the transfer tool returns {"transferred":true}. Otherwise say briefly that an administrator is unavailable right now; never pretend that a connection happened.`;
}

class VoiceCallRepository {
  constructor(supabase) { this.supabase = supabase; }
  async begin(input) { const { data, error } = await this.supabase.rpc('voice_begin_call', input); if (error) throw error; return data; }
  async finish(input) { const { error } = await this.supabase.rpc('voice_finish_call', input); if (error) throw error; }
  async property(propertyId) { const { data, error } = await this.supabase.from('properties').select('property_id,hotel_name').eq('property_id', propertyId).single(); if (error) throw error; return data; }
  async stale(seconds) { const { error } = await this.supabase.rpc('voice_mark_stale_calls', { p_hung_seconds: seconds }); if (error) throw error; }
}

class VoiceCallService {
  constructor({ supabase, config = voiceConfig(), realtimeClient, repository, logger = console, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, getHotelInfoImpl = getHotelInfo, buildPromptImpl = buildSystemPrompt, toolsFactory = createTools, sendPaymentEmailImpl, smsService }) {
    this.config = config; this.repo = repository || new VoiceCallRepository(supabase); this.logger = logger;
    this.client = realtimeClient || (config.apiKey && config.webhookSecret ? new OpenAIRealtimeClient({ apiKey: config.apiKey, webhookSecret: config.webhookSecret }) : null);
    this.calls = new Map(); this.setTimeout = setTimeoutImpl; this.clearTimeout = clearTimeoutImpl;
    this.getHotelInfo = getHotelInfoImpl; this.buildPrompt = buildPromptImpl; this.toolsFactory = toolsFactory;
    this.sendPaymentEmail = sendPaymentEmailImpl || this.defaultSendPaymentEmail.bind(this);
    this.smsService = smsService || null;
    // Staging-safe operational trace.  It intentionally keeps no SIP headers,
    // call IDs, audio, transcripts, or provider error details.
    this.lastDiagnostic = { stage: 'idle', at: null };
  }
  isReady() { return Boolean(this.config.enabled && this.client && this.config.apiKey && this.config.webhookSecret); }
  health() { return { enabled: this.config.enabled, configured: this.isReady(), provider: this.config.provider, model: this.config.model, voice: this.config.voice, vad: this.config.vad.type, language_lock: this.config.languageLockTranscription, diagnostic: this.lastDiagnostic }; }
  diagnose(stage, code = null) { this.lastDiagnostic = { stage, at: new Date().toISOString(), ...(code ? { code } : {}) }; }
  async handleWebhook(rawBody, headers) {
    if (!this.isReady()) return { status: 503, body: { error: 'voice_not_configured' } };
    let event;
    try { event = await this.client.unwrapWebhook(rawBody, headers); } catch (error) { this.logger.warn('[voice] rejected webhook', error.message); return { status: 400, body: { error: 'invalid_voice_webhook' } }; }
    if (event.type !== 'realtime.call.incoming') return { status: 200, body: { received: true } };
    this.diagnose('webhook_received');
    const call = event.data || event;
    const callId = call.call_id || call.id;
    // OpenAI routes a direct SIP INVITE by project ID, so a carrier may expose
    // that non-phone URI in To.  A fallback is safe only when explicitly bound
    // in deployment configuration; it remains tenant-scoped in the database.
    const to = normalizePhoneNumber(sipHeader(call.sip_headers, 'to')) || this.config.defaultPhoneNumber;
    const identity = sipCallerIdentity(call.sip_headers, to);
    const caller = identity.phone;
    // Never log a caller's phone, raw SIP header, or call audio. This tells
    // operators whether Zadarma actually passed an identity to OpenAI.
    if (!caller) this.logger.warn('[voice] caller ID unavailable', {
      fromHeader: Boolean(sipHeader(call.sip_headers, 'from')),
      assertedHeader: Boolean(sipHeader(call.sip_headers, 'p-asserted-identity')),
      remotePartyHeader: Boolean(sipHeader(call.sip_headers, 'remote-party-id')),
    });
    else this.logger.info?.('[voice] caller ID resolved from SIP', identity.source);
    if (!callId || !to) { this.logger.warn('[voice] incoming call has no call id or destination'); return { status: 200, body: { received: true } }; }
    let reservation;
    try {
      reservation = await this.repo.begin({ p_provider: this.config.provider, p_provider_call_id: callId, p_to_number: to, p_caller_hash: hashCaller(caller, this.config.callerHashSecret), p_model: this.config.model, p_reserve_seconds: this.config.maxDurationSeconds, p_max_concurrent_per_hotel: this.config.maxConcurrentPerHotel, p_max_global: this.config.maxConcurrentGlobal, p_rate_per_caller: this.config.callerRateLimit, p_rate_window_seconds: this.config.callerRateWindowSeconds, p_daily_limit_seconds: this.config.dailySecondsPerHotel, p_monthly_limit_seconds: this.config.monthlySecondsPerHotel, p_global_daily_limit_seconds: this.config.globalDailySeconds });
    } catch (error) { this.diagnose('reservation_failed'); this.logger.error('[voice] call reservation failed', error.message); return { status: 500, body: { error: 'voice_reservation_failed' } }; }
    if (!reservation?.ok) {
      if (typeof this.client.rejectCall === 'function') await this.client.rejectCall(callId, 486).catch(() => this.client.hangupCall(callId).catch(() => {}));
      else await this.client.hangupCall(callId).catch(() => {});
      this.diagnose('call_rejected'); this.logger.warn('[voice] incoming call rejected', reservation?.code); return { status: 200, body: { received: true } };
    }
    if (reservation.code === 'CALL_ALREADY_STARTED') return { status: 200, body: { received: true } };
    this.diagnose('reservation_succeeded');
    try { await this.startCall({ callId, reservation, callerPhone: this.config.trustSipCallerId ? caller : null }); return { status: 200, body: { received: true } }; }
    catch (error) { if (!this.lastDiagnostic.stage.endsWith('_failed')) this.diagnose('startup_failed'); this.logger.error('[voice] failed to start call', error.message); await this.repo.finish({ p_call_id: callId, p_status: 'failed', p_outcome: 'startup_error', p_error_code: 'startup_error', p_transferred: false }).catch(() => {}); await this.client.hangupCall(callId).catch(() => {}); return { status: 200, body: { received: true } }; }
  }
  async startCall({ callId, reservation, callerPhone = null }) {
    let property;
    try { property = await this.repo.property(reservation.property_id); }
    catch (error) { this.diagnose('property_lookup_failed'); throw error; }
    let hotelInfo;
    try { hotelInfo = await this.getHotelInfo(property.property_id); }
    catch (error) { this.diagnose('hotel_info_failed'); throw error; }
    const trustedCallerRule = callerPhone
      ? 'The secure call context contains a trusted calling number. It is server-bound: do not ask the caller to repeat it, do not read it aloud, and do not accept a replacement number for the current booking.'
      : 'No trusted calling number is available. Ask for a mobile number only when it is necessary to send an SMS, then repeat it once for confirmation.';
    const informationalSmsRule = this.config.stagingTestSmsEnabled && this.smsService?.config?.stagingTestEnabled
      ? 'INFORMATIONAL SMS PILOT: Preserve the complete normal hotel conversation. Offer a single informational SMS after discussing rooms, even if the hotel has no payment merchant and a real booking cannot be created. This SMS never needs a booking or invoice. If Caller ID is supplied use it without asking the guest to repeat it; otherwise request and repeat back the mobile number once for confirmation. After explicit verbal consent, call send_staging_test_sms with consent=true, and with phone only when Caller ID is unavailable. Never tell the guest they must ask for a test. Never invent a booking confirmation or payment link. Do not transfer a routine inquiry merely because a merchant is not configured.'
      : '';
    const instructions = `${phoneInstructions(this.buildPrompt({ propertyName: property.hotel_name, hotelInfo }))}${voiceConversationRules(property.hotel_name)}\n\n${trustedCallerRule} Never invent availability or prices; use the provided hotel tools. If the caller asks for a human, has a complaint, payment/booking problem, or you cannot safely help, call transfer_to_human. Never ask for or transfer to a phone number supplied by the caller.\n\n${informationalSmsRule}`;
    const tools = [...toRealtimeTools(phoneToolDefinitions(toolDefinitions, { callerPhone: Boolean(callerPhone) })), { type: 'function', name: 'send_payment_sms', description: callerPhone ? 'Queue an SMS with the already-created payment link to the trusted calling number. Call only after create_booking succeeded and the caller explicitly agreed in this call.' : 'Queue an SMS with the already-created payment link. Call only after create_booking succeeded, the caller dictated and confirmed the mobile number, and explicitly agreed in this call.', parameters: { type: 'object', properties: { booking_id: { type: 'string' }, phone: { type: 'string' }, consent: { type: 'boolean', enum: [true] } }, required: callerPhone ? ['booking_id', 'consent'] : ['booking_id', 'phone', 'consent'], additionalProperties: false } }, { type: 'function', name: 'transfer_to_human', description: 'Transfer this call to the hotel administrator when escalation is required.', parameters: { type: 'object', properties: { reason: { type: 'string' }, urgency: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['reason'], additionalProperties: false } }];
    if (this.config.stagingTestSmsEnabled && this.smsService?.config?.stagingTestEnabled) tools.push({ type: 'function', name: 'send_staging_test_sms', description: callerPhone ? 'Send one informational SMS to the carrier-supplied calling number after explicit consent. No invoice, booking, or payment link is needed. Do not ask the guest to repeat the known number.' : 'Send one informational SMS after explicit consent to the mobile number dictated AND repeated back AND confirmed during this call. This works without a booking or a payment link. Do not invent the number. Only call once per conversation.', parameters: { type: 'object', properties: { phone: { type: 'string' }, consent: { type: 'boolean', enum: [true] } }, required: callerPhone ? ['consent'] : ['phone', 'consent'], additionalProperties: false } });
    if (this.smsService?.config?.bookingTemplates?.uk) tools.push({ type: 'function', name: 'send_booking_sms', description: 'Queue the approved booking-confirmation SMS. Call only after create_booking succeeded, the caller dictated and confirmed the phone number, and explicitly agreed to receive SMS in this call.', parameters: { type: 'object', properties: { booking_id: { type: 'string' }, phone: { type: 'string' }, consent: { type: 'boolean', enum: [true] } }, required: ['booking_id', 'phone', 'consent'], additionalProperties: false } });
    const input = { turn_detection: this.config.vad };
    // This ASR result is processed only in memory to set the conversation
    // language.  It is not logged or saved with the call record.
    if (this.config.languageLockTranscription) input.transcription = { model: this.config.languageLockTranscriptionModel, languages: ['uk', 'ru', 'en'] };
    try { await this.client.acceptCall(callId, { type: 'realtime', model: this.config.model, instructions, tools, tool_choice: 'auto', audio: { input, output: { voice: this.config.voice, speed: this.config.voiceSpeed } } }); }
    catch (error) { this.diagnose('accept_failed', safeTransportCode(error)); throw error; }
    this.diagnose('accept_succeeded');
    const state = { callId, propertyId: property.property_id, hotelName: property.hotel_name, callerPhone, adminTransferUri: reservation.admin_transfer_uri, instructions, toolCalls: new Set(), transferred: false, bargeIns: 0, callerTurns: 0, cancelledResponses: 0, conversationLanguage: 'unknown', pendingLanguageSwitch: null, assistantResponding: false, userSpeechStoppedAt: null, responseLatencies: [], toolLatencies: [], paymentLinks: new Map(), bookingReference: null };
    state.socket = this.client.openMonitor(callId, {
      // A SIP call can be accepted before the caller says anything.  Start with
      // an audible greeting when the sideband is ready so the caller is never
      // left in silence waiting for the first VAD turn.
      onOpen: () => {
        if (state.finished || state.greetingRequested || !state.socket || state.socket.readyState !== state.socket.OPEN) return;
        state.greetingRequested = true;
        this.logger.info?.('[voice] sideband connected; starting greeting', callId);
        this.diagnose('sideband_connected');
        state.socket.send(JSON.stringify({ type: 'response.create', response: { instructions: `Say exactly one short Ukrainian greeting: “Вітаю! Ви зателефонували до ${property.hotel_name}. Чим можу допомогти?” Then wait silently for the caller. Do not call yourself virtual unless the caller asks who is speaking.` } }));
        this.diagnose('greeting_requested');
      },
      onEvent: event => this.onEvent(state, event),
      onError: error => { this.diagnose('sideband_error'); this.logger.warn('[voice] sideband error', error.message); },
      onClose: () => { this.diagnose('sideband_closed'); this.finishCall(state, 'completed', 'call_closed').catch(() => {}); },
    });
    state.limitTimer = this.setTimeout(() => this.beginLimitTransfer(state), Math.max(1000, (this.config.maxDurationSeconds - this.config.graceSeconds) * 1000));
    state.hangupTimer = this.setTimeout(() => this.forceEnd(state), this.config.maxDurationSeconds * 1000);
    this.calls.set(callId, state);
  }
  onEvent(state, event) {
    if (event.type === 'error') this.logger.error('[voice] realtime error', event.error?.message || JSON.stringify(event));
    if (event.type === 'input_audio_buffer.speech_started') {
      this.diagnose('input_audio_detected');
      if (state.assistantResponding) state.bargeIns += 1;
      else state.callerTurns += 1;
      return; // OpenAI VAD interrupts output server-side.
    }
    if (event.type === 'input_audio_buffer.speech_stopped') { state.userSpeechStoppedAt = Date.now(); return; }
    if (event.type === 'response.created') {
      state.assistantResponding = true;
      if (state.userSpeechStoppedAt) {
        state.responseLatencies.push(Date.now() - state.userSpeechStoppedAt);
        state.userSpeechStoppedAt = null;
      }
    }
    if (event.type === 'response.cancelled') { state.assistantResponding = false; state.cancelledResponses += 1; this.diagnose('response_cancelled', event.response?.status_details?.reason || 'unknown'); }
    if (event.type === 'response.done' || event.type === 'response.output_audio.done') state.assistantResponding = false;
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.updateConversationLanguage(state, event.transcript).catch(error => this.logger.warn('[voice] language lock update failed', error.message));
      return;
    }
    const item = event.item || event.response?.output?.find?.(o => o.type === 'function_call');
    if (event.type === 'response.function_call_arguments.done') this.handleToolCall(state, event.name, event.call_id, event.arguments).catch(error => this.logger.error('[voice] tool failed', error.message));
    else if (event.type === 'response.output_item.done' && item?.type === 'function_call') this.handleToolCall(state, item.name, item.call_id, item.arguments).catch(error => this.logger.error('[voice] tool failed', error.message));
  }
  async updateConversationLanguage(state, transcript) {
    const nextLanguage = detectConversationLanguage(transcript, state.conversationLanguage);
    if (!nextLanguage || nextLanguage === state.conversationLanguage || !state.socket || state.socket.readyState !== state.socket.OPEN) return;
    const explicit = explicitLanguageSwitch(transcript);
    const words = String(transcript || '').match(/[\p{L}']+/gu) || [];
    const isClearSwitch = explicit || (words.length >= 3 && String(transcript || '').trim().length >= 12);
    if (state.conversationLanguage !== 'unknown' && !isClearSwitch) {
      if (state.pendingLanguageSwitch === nextLanguage) {
        state.pendingLanguageSwitch = null;
      } else {
        state.pendingLanguageSwitch = nextLanguage;
        return;
      }
    }
    state.pendingLanguageSwitch = null;
    state.conversationLanguage = nextLanguage;
    state.socket.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: `${state.instructions}${languageLockInstruction(nextLanguage)}` } }));
    this.diagnose(`language_locked_${nextLanguage}`);
  }
  async handleToolCall(state, name, toolCallId, rawArgs) {
    if (!toolCallId || state.toolCalls.has(toolCallId)) return; state.toolCalls.add(toolCallId);
    let args = {}; try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {}; } catch { args = {}; }
    const startedAt = Date.now();
    let output;
    if (name === 'transfer_to_human') output = await this.transferToHuman(state, args);
    else if (name === 'send_payment_link') output = await this.deliverPaymentLink(state, args);
    else if (name === 'send_payment_sms') output = await this.deliverPaymentSms(state, args);
    else if (name === 'send_booking_sms') output = await this.deliverBookingSms(state, args);
    else if (name === 'send_staging_test_sms') output = await this.deliverStagingTestSms(state, args);
    else {
      const tools = this.toolsFactory(state.propertyId, 'phone', state.callId);
      // A trusted carrier Caller ID is bound to the call on the server.  The
      // model may never replace it with arbitrary spoken or tool JSON input.
      if (name === 'create_booking' && state.callerPhone) args = { ...args, guest_contact: state.callerPhone };
      output = tools[name] ? await tools[name](args) : { error: 'unknown_tool' };
      if (name === 'check_availability') output = phoneAvailabilityOutput(output);
      if (name === 'create_booking' && output?.ok && output.booking?.booking_id) {
        state.bookingReference = output.booking.booking_id;
        if (output.booking.payment_link) state.paymentLinks.set(output.booking.booking_id, output.booking.payment_link);
      }
    }
    state.toolLatencies.push(Date.now() - startedAt);
    if (state.socket?.readyState === state.socket.OPEN) { state.socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify(output) } })); if (!state.transferred) state.socket.send(JSON.stringify({ type: 'response.create' })); }
  }
  async deliverPaymentLink(state, { booking_id: bookingId, email } = {}) {
    const recipient = normalizeEmail(email);
    const paymentLink = state.paymentLinks.get(bookingId);
    if (!recipient) return { ok: false, error: 'valid_email_required' };
    if (!paymentLink) return { ok: false, error: 'online_payment_link_unavailable' };
    if (!this.config.paymentEmailDeliveryEnabled) return { ok: false, error: 'payment_email_delivery_disabled' };
    try {
      await this.sendPaymentEmail({ to: recipient, bookingId, paymentLink, hotelName: state.hotelName });
      return { ok: true, delivery: 'email', recipient };
    } catch (error) {
      this.logger.error('[voice] payment-link delivery failed', error.message);
      return { ok: false, error: 'payment_email_delivery_failed' };
    }
  }
  async deliverPaymentSms(state, { booking_id: bookingId, phone, consent } = {}) {
    if (!this.smsService) return { ok: false, error: 'sms_delivery_not_configured' };
    const selectedPhone = state.callerPhone || phone;
    const phoneSource = state.callerPhone ? 'trusted_sip_caller_id' : 'spoken_confirmed';
    try { return await this.smsService.createPaymentSms({ propertyId: state.propertyId, bookingId, phone: selectedPhone, callId: state.callId, language: state.conversationLanguage === 'unknown' ? 'uk' : state.conversationLanguage, consent: consent === true, phoneSource }); }
    catch (error) { this.logger.error('[voice] payment SMS preparation failed', error.message); return { ok: false, error: 'payment_sms_unavailable' }; }
  }
  async deliverBookingSms(state, { booking_id: bookingId, phone, consent } = {}) {
    if (!this.smsService) return { ok: false, error: 'sms_delivery_not_configured' };
    const language = state.conversationLanguage === 'unknown' ? 'uk' : state.conversationLanguage;
    const text = this.smsService.config?.bookingTemplates?.[language] || this.smsService.config?.bookingTemplates?.uk;
    try { return await this.smsService.createBookingSms({ propertyId: state.propertyId, bookingId, phone, callId: state.callId, language, consent: consent === true, phoneSource: 'spoken_confirmed', text }); }
    catch (error) { this.logger.error('[voice] booking SMS preparation failed', error.message); return { ok: false, error: 'booking_sms_unavailable' }; }
  }
  async deliverStagingTestSms(state, { consent, phone } = {}) {
    if (!this.smsService || !this.config.stagingTestSmsEnabled || !state.callId) return { ok: false, error: 'staging_test_sms_unavailable' };
    // Never allow voice tool arguments to override a trusted carrier number.
    // If the carrier did not supply a Caller ID, the conversation must obtain
    // and confirm a guest-provided mobile number before consenting to SMS.
    const destination = state.callerPhone || phone;
    const phoneSource = state.callerPhone ? 'trusted_sip_caller_id' : 'spoken_confirmed';
    if (!destination) return { ok: false, error: 'confirmed_mobile_required' };
    if (consent !== true) return { ok: false, error: 'guest_consent_required' };
    try { return await this.smsService.createStagingTestSms({ propertyId: state.propertyId, phone: destination, callId: state.callId, consent: true, phoneSource }); }
    catch (error) { this.logger.error('[voice] staging SMS failed', error.message); return { ok: false, error: 'staging_test_sms_unavailable' }; }
  }
  async defaultSendPaymentEmail({ to, bookingId, paymentLink, hotelName }) {
    if (!this.config.paymentEmailApiKey) throw new Error('payment email is not configured');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.paymentEmailApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.config.paymentEmailFrom,
        to: [to],
        subject: `Оплата бронювання ${bookingId} — ${hotelName}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#17181b"><h2>${escapeHtml(hotelName)}</h2><p>Ваше бронювання <b>${escapeHtml(bookingId)}</b> створено.</p><p><a href="${escapeHtml(paymentLink)}" style="display:inline-block;padding:12px 18px;background:#111827;color:#fff;text-decoration:none;border-radius:6px">Оплатити бронювання</a></p><p>Посилання дійсне протягом часу, вказаного при бронюванні.</p></div>`,
      }),
    });
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
  }
  async transferToHuman(state, { reason = 'caller_request', urgency = 'normal' } = {}) {
    const tools = this.toolsFactory(state.propertyId, 'phone', state.callId); await tools.escalate_to_human({ reason, urgency }).catch(() => {});
    if (!state.adminTransferUri) return { error: 'human_administrator_not_configured' };
    await this.client.referCall(state.callId, state.adminTransferUri); state.transferred = true; await this.finishCall(state, 'transferred', 'human_transfer'); return { transferred: true };
  }
  beginLimitTransfer(state) { if (!state.transferred && state.socket?.readyState === state.socket.OPEN) state.socket.send(JSON.stringify({ type: 'response.create', response: { instructions: state.adminTransferUri ? 'Briefly explain that the call time is ending and you will now try to connect the caller with the hotel administrator.' : 'Briefly explain that the call time is ending. Do not promise a transfer because no administrator connection is configured.' } })); }
  async forceEnd(state) { if (state.transferred) return; if (state.adminTransferUri) await this.transferToHuman(state, { reason: 'call_time_limit', urgency: 'normal' }).catch(() => {}); else { await this.client.hangupCall(state.callId).catch(() => {}); await this.finishCall(state, 'completed', 'time_limit'); } }
  async finishCall(state, status, outcome) { if (state.finished) return; state.finished = true; this.clearTimeout(state.limitTimer); this.clearTimeout(state.hangupTimer); this.calls.delete(state.callId); const average = values => values?.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null; const analytics = [`barge_ins=${state.bargeIns || 0}`, `caller_turns=${state.callerTurns || 0}`, `response_cancellations=${state.cancelledResponses || 0}`]; if (average(state.responseLatencies)) analytics.push(`response_ms_avg=${average(state.responseLatencies)}`); if (average(state.toolLatencies)) analytics.push(`tool_ms_avg=${average(state.toolLatencies)}`); if (state.conversationLanguage !== 'unknown') analytics.push(`language=${state.conversationLanguage}`); if (state.bookingReference) analytics.push(`booking=${state.bookingReference}`); await this.repo.finish({ p_call_id: state.callId, p_status: status, p_outcome: `${outcome};${analytics.join(';')}`, p_error_code: null, p_transferred: Boolean(state.transferred) }).catch(error => this.logger.error('[voice] finish failed', error.message)); try { state.socket?.close(); } catch {} }
  async markStaleCalls() { await this.repo.stale(this.config.hungSeconds); }
}

function createVoiceCallService({ supabase, env = process.env, ...rest }) { return new VoiceCallService({ supabase, config: voiceConfig(env), ...rest }); }
module.exports = { VoiceCallService, VoiceCallRepository, createVoiceCallService, voiceConfig, normalizePhoneNumber, phoneFromSipIdentity, sipCallerIdentity, normalizeEmail, hashCaller, safeTransportCode, toRealtimeTools, phoneToolDefinitions, phoneAvailabilityOutput, phoneInstructions, voiceConversationRules, detectConversationLanguage, explicitLanguageSwitch, languageLockInstruction };
