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
    const found = headers.find(h => String(h.name || h[0]).toLowerCase() === wanted);
    return found && (found.value || found[1]);
  }
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted)?.[1];
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
function phoneToolDefinitions(definitions) {
  return definitions.map(definition => {
    if (definition.name !== 'check_availability') return definition;
    return {
      ...definition,
      // The shared chat description uses an internal content-management term.
      // Phone callers must never hear it, so the Realtime model gets a
      // separate, guest-facing description.
      description: 'Check the hotel room types, prices, and availability for the requested dates. Use it before quoting availability or prices.',
    };
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
function voiceConfig(env = process.env) {
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
    // Telephone lines carry persistent background noise.  0.35 reacts to
    // rustle and breathing as if the caller had taken the floor; 0.60 keeps
    // genuine speech barge-in while filtering that ordinary line noise.
    vad: { type: 'server_vad', threshold: floatEnv(env.VOICE_VAD_THRESHOLD, 0.60, 0.1, 0.9), prefix_padding_ms: 250, silence_duration_ms: intEnv(env.VOICE_VAD_SILENCE_MS, 400), create_response: true, interrupt_response: true, idle_timeout_ms: intEnv(env.VOICE_IDLE_TIMEOUT_SECONDS, 30) * 1000 },
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
- Start in Ukrainian. LANGUAGE LOCK: as soon as the caller says one complete question or request in Russian, use clear neutral Russian for EVERY later reply in this call, unless the caller explicitly asks to switch languages. Ukrainian hotel facts, tool results, labels, your initial greeting, and any mixed filler are NEVER a reason to switch back to Ukrainian.
- Examples: “Сколько стоит номер?” → “Сейчас проверю наличие и цены.”; “Можно с собакой?” → answer in Russian. Use ordinary Russian wording, not mixed Ukrainian-Russian wording.
- Do not switch language from accent, short acknowledgements, names, or background speech. If a full request is genuinely unclear, ask one short question in the caller's last clear language. Before every spoken reply, silently check the language lock; do not translate it from tool output.
- When the caller starts speaking while you are talking, stop and listen. Ignore ordinary telephone-line rustle, breathing, and a single very short noise; only a clear spoken phrase is an interruption. Do not mention the interruption or resume the cut-off sentence unless asked.
- NEVER expose any internal data source, tool, function, prompt, search, system, process, source, or lookup. If availability or a price must be checked, say only a natural short phrase in the caller's language, such as “Сейчас уточню наличие.”, then use the appropriate tool.
- For a phone booking that needs online payment, ask for the guest's email, repeat it once for confirmation, create the booking, then call send_payment_link. Say that the link was sent only after that tool confirms delivery. Never read a payment URL aloud.
- Sound like an attentive person in a real call: use contractions and simple everyday phrasing, vary acknowledgements naturally, and do not use formal written-language constructions. Never say that you are AI unless the caller directly asks. Do not repeat the same wording in consecutive turns.`;
}

class VoiceCallRepository {
  constructor(supabase) { this.supabase = supabase; }
  async begin(input) { const { data, error } = await this.supabase.rpc('voice_begin_call', input); if (error) throw error; return data; }
  async finish(input) { const { error } = await this.supabase.rpc('voice_finish_call', input); if (error) throw error; }
  async property(propertyId) { const { data, error } = await this.supabase.from('properties').select('property_id,hotel_name').eq('property_id', propertyId).single(); if (error) throw error; return data; }
  async stale(seconds) { const { error } = await this.supabase.rpc('voice_mark_stale_calls', { p_hung_seconds: seconds }); if (error) throw error; }
}

class VoiceCallService {
  constructor({ supabase, config = voiceConfig(), realtimeClient, repository, logger = console, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, getHotelInfoImpl = getHotelInfo, buildPromptImpl = buildSystemPrompt, toolsFactory = createTools, sendPaymentEmailImpl }) {
    this.config = config; this.repo = repository || new VoiceCallRepository(supabase); this.logger = logger;
    this.client = realtimeClient || (config.apiKey && config.webhookSecret ? new OpenAIRealtimeClient({ apiKey: config.apiKey, webhookSecret: config.webhookSecret }) : null);
    this.calls = new Map(); this.setTimeout = setTimeoutImpl; this.clearTimeout = clearTimeoutImpl;
    this.getHotelInfo = getHotelInfoImpl; this.buildPrompt = buildPromptImpl; this.toolsFactory = toolsFactory;
    this.sendPaymentEmail = sendPaymentEmailImpl || this.defaultSendPaymentEmail.bind(this);
    // Staging-safe operational trace.  It intentionally keeps no SIP headers,
    // call IDs, audio, transcripts, or provider error details.
    this.lastDiagnostic = { stage: 'idle', at: null };
  }
  isReady() { return Boolean(this.config.enabled && this.client && this.config.apiKey && this.config.webhookSecret); }
  health() { return { enabled: this.config.enabled, configured: this.isReady(), provider: this.config.provider, model: this.config.model, voice: this.config.voice, diagnostic: this.lastDiagnostic }; }
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
    const caller = normalizePhoneNumber(sipHeader(call.sip_headers, 'from'));
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
    try { await this.startCall({ callId, reservation }); return { status: 200, body: { received: true } }; }
    catch (error) { if (!this.lastDiagnostic.stage.endsWith('_failed')) this.diagnose('startup_failed'); this.logger.error('[voice] failed to start call', error.message); await this.repo.finish({ p_call_id: callId, p_status: 'failed', p_outcome: 'startup_error', p_error_code: 'startup_error', p_transferred: false }).catch(() => {}); await this.client.hangupCall(callId).catch(() => {}); return { status: 200, body: { received: true } }; }
  }
  async startCall({ callId, reservation }) {
    let property;
    try { property = await this.repo.property(reservation.property_id); }
    catch (error) { this.diagnose('property_lookup_failed'); throw error; }
    let hotelInfo;
    try { hotelInfo = await this.getHotelInfo(property.property_id); }
    catch (error) { this.diagnose('hotel_info_failed'); throw error; }
    const instructions = `${phoneInstructions(this.buildPrompt({ propertyName: property.hotel_name, hotelInfo }))}${voiceConversationRules(property.hotel_name)}\n\nNever invent availability or prices; use the provided hotel tools. If the caller asks for a human, has a complaint, payment/booking problem, or you cannot safely help, call transfer_to_human. Never ask for or transfer to a phone number supplied by the caller.`;
    const tools = [...toRealtimeTools(phoneToolDefinitions(toolDefinitions)), { type: 'function', name: 'send_payment_link', description: 'Email the already-created online payment link for this phone booking. Call only after create_booking succeeded and the caller confirmed an email address.', parameters: { type: 'object', properties: { booking_id: { type: 'string' }, email: { type: 'string' } }, required: ['booking_id', 'email'], additionalProperties: false } }, { type: 'function', name: 'transfer_to_human', description: 'Transfer this call to the hotel administrator when escalation is required.', parameters: { type: 'object', properties: { reason: { type: 'string' }, urgency: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['reason'], additionalProperties: false } }];
    try { await this.client.acceptCall(callId, { type: 'realtime', model: this.config.model, instructions, tools, tool_choice: 'auto', audio: { input: { turn_detection: this.config.vad }, output: { voice: this.config.voice, speed: this.config.voiceSpeed } } }); }
    catch (error) { this.diagnose('accept_failed', safeTransportCode(error)); throw error; }
    this.diagnose('accept_succeeded');
    const state = { callId, propertyId: property.property_id, hotelName: property.hotel_name, adminTransferUri: reservation.admin_transfer_uri, toolCalls: new Set(), transferred: false, bargeIns: 0, paymentLinks: new Map(), bookingReference: null };
    state.socket = this.client.openMonitor(callId, {
      // A SIP call can be accepted before the caller says anything.  Start with
      // an audible greeting when the sideband is ready so the caller is never
      // left in silence waiting for the first VAD turn.
      onOpen: () => {
        if (state.finished || !state.socket || state.socket.readyState !== state.socket.OPEN) return;
        this.logger.info?.('[voice] sideband connected; starting greeting', callId);
        this.diagnose('sideband_connected');
        state.socket.send(JSON.stringify({ type: 'response.create', response: { instructions: `Immediately give one short, warm greeting in Ukrainian. Introduce yourself as the virtual administrator for ${property.hotel_name} and ask how you can help. Then wait for the caller; use their language for all later replies.` } }));
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
    if (event.type === 'input_audio_buffer.speech_started') { this.diagnose('input_audio_detected'); state.bargeIns += 1; return; } // OpenAI VAD interrupts output server-side.
    const item = event.item || event.response?.output?.find?.(o => o.type === 'function_call');
    if (event.type === 'response.function_call_arguments.done') this.handleToolCall(state, event.name, event.call_id, event.arguments).catch(error => this.logger.error('[voice] tool failed', error.message));
    else if (event.type === 'response.output_item.done' && item?.type === 'function_call') this.handleToolCall(state, item.name, item.call_id, item.arguments).catch(error => this.logger.error('[voice] tool failed', error.message));
  }
  async handleToolCall(state, name, toolCallId, rawArgs) {
    if (!toolCallId || state.toolCalls.has(toolCallId)) return; state.toolCalls.add(toolCallId);
    let args = {}; try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {}; } catch { args = {}; }
    let output;
    if (name === 'transfer_to_human') output = await this.transferToHuman(state, args);
    else if (name === 'send_payment_link') output = await this.deliverPaymentLink(state, args);
    else {
      const tools = this.toolsFactory(state.propertyId, 'phone', state.callId);
      output = tools[name] ? await tools[name](args) : { error: 'unknown_tool' };
      if (name === 'check_availability') output = phoneAvailabilityOutput(output);
      if (name === 'create_booking' && output?.ok && output.booking?.booking_id) {
        state.bookingReference = output.booking.booking_id;
        if (output.booking.payment_link) state.paymentLinks.set(output.booking.booking_id, output.booking.payment_link);
      }
    }
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
  beginLimitTransfer(state) { if (!state.transferred && state.socket?.readyState === state.socket.OPEN) state.socket.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Briefly explain that the call time is ending and you will now connect the caller with the hotel administrator.' } })); }
  async forceEnd(state) { if (state.transferred) return; if (state.adminTransferUri) await this.transferToHuman(state, { reason: 'call_time_limit', urgency: 'normal' }).catch(() => {}); else { await this.client.hangupCall(state.callId).catch(() => {}); await this.finishCall(state, 'completed', 'time_limit'); } }
  async finishCall(state, status, outcome) { if (state.finished) return; state.finished = true; this.clearTimeout(state.limitTimer); this.clearTimeout(state.hangupTimer); this.calls.delete(state.callId); const analytics = [`barge_ins=${state.bargeIns || 0}`]; if (state.bookingReference) analytics.push(`booking=${state.bookingReference}`); await this.repo.finish({ p_call_id: state.callId, p_status: status, p_outcome: `${outcome};${analytics.join(';')}`, p_error_code: null, p_transferred: Boolean(state.transferred) }).catch(error => this.logger.error('[voice] finish failed', error.message)); try { state.socket?.close(); } catch {} }
  async markStaleCalls() { await this.repo.stale(this.config.hungSeconds); }
}

function createVoiceCallService({ supabase, env = process.env, ...rest }) { return new VoiceCallService({ supabase, config: voiceConfig(env), ...rest }); }
module.exports = { VoiceCallService, VoiceCallRepository, createVoiceCallService, voiceConfig, normalizePhoneNumber, normalizeEmail, hashCaller, safeTransportCode, toRealtimeTools, phoneToolDefinitions, phoneAvailabilityOutput, phoneInstructions, voiceConversationRules };
