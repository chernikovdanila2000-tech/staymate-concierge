'use strict';

const crypto = require('crypto');
const { getHotelInfo } = require('./hotel-info');
const { buildSystemPrompt } = require('./system-prompt');
const { createTools, toolDefinitions } = require('./tools');
const { OpenAIRealtimeClient } = require('./openai-realtime');

function intEnv(value, fallback) { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function boolEnv(value, fallback = false) { return value === undefined ? fallback : String(value).toLowerCase() === 'true'; }
function normalizePhoneNumber(value) {
  if (!value) return null;
  const raw = String(value).replace(/^sip:/i, '').replace(/^tel:/i, '').split('@')[0].replace(/[^+\d]/g, '');
  if (!raw) return null;
  return raw.startsWith('+') ? raw : `+${raw}`;
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
function toRealtimeTools(definitions) {
  return definitions.map(({ name, description, input_schema }) => ({ type: 'function', name, description, parameters: input_schema }));
}
function voiceConfig(env = process.env) {
  return {
    enabled: boolEnv(env.VOICE_ENABLED), provider: env.VOICE_PROVIDER || 'zadarma', model: env.VOICE_MODEL || 'gpt-realtime-2.1-mini',
    apiKey: env.VOICE_OPENAI_API_KEY, webhookSecret: env.VOICE_OPENAI_WEBHOOK_SECRET, voice: env.VOICE_TTS_VOICE || 'marin',
    maxDurationSeconds: intEnv(env.VOICE_CALL_MAX_DURATION_SECONDS, 600), graceSeconds: intEnv(env.VOICE_CALL_TRANSFER_GRACE_SECONDS, 20),
    maxConcurrentPerHotel: intEnv(env.VOICE_MAX_CONCURRENT_CALLS_PER_HOTEL, 2), maxConcurrentGlobal: intEnv(env.VOICE_MAX_CONCURRENT_CALLS_GLOBAL, 10),
    callerRateLimit: intEnv(env.VOICE_MAX_CALLS_PER_CALLER_WINDOW, 3), callerRateWindowSeconds: intEnv(env.VOICE_CALLER_RATE_WINDOW_SECONDS, 900),
    dailySecondsPerHotel: intEnv(env.VOICE_DAILY_MINUTES_PER_HOTEL, 60) * 60, monthlySecondsPerHotel: intEnv(env.VOICE_MONTHLY_MINUTES_PER_HOTEL, 1000) * 60,
    globalDailySeconds: intEnv(env.VOICE_GLOBAL_DAILY_MINUTES, 600) * 60, hungSeconds: intEnv(env.VOICE_HUNG_CALL_SECONDS, 660),
    callerHashSecret: env.VOICE_CALLER_HASH_SECRET, vad: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true, idle_timeout_ms: intEnv(env.VOICE_IDLE_TIMEOUT_SECONDS, 30) * 1000 },
  };
}

class VoiceCallRepository {
  constructor(supabase) { this.supabase = supabase; }
  async begin(input) { const { data, error } = await this.supabase.rpc('voice_begin_call', input); if (error) throw error; return data; }
  async finish(input) { const { error } = await this.supabase.rpc('voice_finish_call', input); if (error) throw error; }
  async property(propertyId) { const { data, error } = await this.supabase.from('properties').select('property_id,hotel_name').eq('property_id', propertyId).single(); if (error) throw error; return data; }
  async stale(seconds) { const { error } = await this.supabase.rpc('voice_mark_stale_calls', { p_hung_seconds: seconds }); if (error) throw error; }
}

class VoiceCallService {
  constructor({ supabase, config = voiceConfig(), realtimeClient, repository, logger = console, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, getHotelInfoImpl = getHotelInfo, buildPromptImpl = buildSystemPrompt, toolsFactory = createTools }) {
    this.config = config; this.repo = repository || new VoiceCallRepository(supabase); this.logger = logger;
    this.client = realtimeClient || (config.apiKey && config.webhookSecret ? new OpenAIRealtimeClient({ apiKey: config.apiKey, webhookSecret: config.webhookSecret }) : null);
    this.calls = new Map(); this.setTimeout = setTimeoutImpl; this.clearTimeout = clearTimeoutImpl;
    this.getHotelInfo = getHotelInfoImpl; this.buildPrompt = buildPromptImpl; this.toolsFactory = toolsFactory;
  }
  isReady() { return Boolean(this.config.enabled && this.client && this.config.apiKey && this.config.webhookSecret); }
  health() { return { enabled: this.config.enabled, configured: this.isReady(), provider: this.config.provider, model: this.config.model }; }
  async handleWebhook(rawBody, headers) {
    if (!this.isReady()) return { status: 503, body: { error: 'voice_not_configured' } };
    let event;
    try { event = await this.client.unwrapWebhook(rawBody, headers); } catch (error) { this.logger.warn('[voice] rejected webhook', error.message); return { status: 400, body: { error: 'invalid_voice_webhook' } }; }
    if (event.type !== 'realtime.call.incoming') return { status: 200, body: { received: true } };
    const call = event.data || event;
    const callId = call.call_id || call.id;
    const to = normalizePhoneNumber(sipHeader(call.sip_headers, 'to'));
    const caller = normalizePhoneNumber(sipHeader(call.sip_headers, 'from'));
    if (!callId || !to) { this.logger.warn('[voice] incoming call has no call id or destination'); return { status: 200, body: { received: true } }; }
    let reservation;
    try {
      reservation = await this.repo.begin({ p_provider: this.config.provider, p_provider_call_id: callId, p_to_number: to, p_caller_hash: hashCaller(caller, this.config.callerHashSecret), p_model: this.config.model, p_reserve_seconds: this.config.maxDurationSeconds, p_max_concurrent_per_hotel: this.config.maxConcurrentPerHotel, p_max_global: this.config.maxConcurrentGlobal, p_rate_per_caller: this.config.callerRateLimit, p_rate_window_seconds: this.config.callerRateWindowSeconds, p_daily_limit_seconds: this.config.dailySecondsPerHotel, p_monthly_limit_seconds: this.config.monthlySecondsPerHotel, p_global_daily_limit_seconds: this.config.globalDailySeconds });
    } catch (error) { this.logger.error('[voice] call reservation failed', error.message); return { status: 500, body: { error: 'voice_reservation_failed' } }; }
    if (!reservation?.ok) {
      if (typeof this.client.rejectCall === 'function') await this.client.rejectCall(callId, 486).catch(() => this.client.hangupCall(callId).catch(() => {}));
      else await this.client.hangupCall(callId).catch(() => {});
      this.logger.warn('[voice] incoming call rejected', reservation?.code); return { status: 200, body: { received: true } };
    }
    if (reservation.code === 'CALL_ALREADY_STARTED') return { status: 200, body: { received: true } };
    try { await this.startCall({ callId, reservation }); return { status: 200, body: { received: true } }; }
    catch (error) { this.logger.error('[voice] failed to start call', error.message); await this.repo.finish({ p_call_id: callId, p_status: 'failed', p_outcome: 'startup_error', p_error_code: 'startup_error', p_transferred: false }).catch(() => {}); await this.client.hangupCall(callId).catch(() => {}); return { status: 200, body: { received: true } }; }
  }
  async startCall({ callId, reservation }) {
    const property = await this.repo.property(reservation.property_id);
    const hotelInfo = await this.getHotelInfo(property.property_id);
    const instructions = `${this.buildPrompt({ propertyName: property.hotel_name, hotelInfo })}\n\nYou are speaking on a phone call. Identify and answer in the caller's language (Ukrainian, Russian, or English). Be concise and natural. Never invent availability or prices; use the provided hotel tools. If the caller asks for a human, has a complaint, payment/booking problem, or you cannot safely help, call transfer_to_human. Never ask for or transfer to a phone number supplied by the caller.`;
    const tools = [...toRealtimeTools(toolDefinitions), { type: 'function', name: 'transfer_to_human', description: 'Transfer this call to the hotel administrator when escalation is required.', parameters: { type: 'object', properties: { reason: { type: 'string' }, urgency: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['reason'], additionalProperties: false } }];
    await this.client.acceptCall(callId, { type: 'realtime', model: this.config.model, instructions, tools, tool_choice: 'auto', audio: { input: { turn_detection: this.config.vad }, output: { voice: this.config.voice } } });
    const state = { callId, propertyId: property.property_id, adminTransferUri: reservation.admin_transfer_uri, toolCalls: new Set(), transferred: false, bargeIns: 0 };
    state.socket = this.client.openMonitor(callId, { onEvent: event => this.onEvent(state, event), onError: error => this.logger.warn('[voice] sideband error', error.message), onClose: () => this.finishCall(state, 'completed', 'call_closed').catch(() => {}) });
    state.limitTimer = this.setTimeout(() => this.beginLimitTransfer(state), Math.max(1000, (this.config.maxDurationSeconds - this.config.graceSeconds) * 1000));
    state.hangupTimer = this.setTimeout(() => this.forceEnd(state), this.config.maxDurationSeconds * 1000);
    this.calls.set(callId, state);
  }
  onEvent(state, event) {
    if (event.type === 'input_audio_buffer.speech_started') { state.bargeIns += 1; return; } // OpenAI VAD interrupts output server-side.
    const item = event.item || event.response?.output?.find?.(o => o.type === 'function_call');
    if (event.type === 'response.function_call_arguments.done') this.handleToolCall(state, event.name, event.call_id, event.arguments).catch(error => this.logger.error('[voice] tool failed', error.message));
    else if (event.type === 'response.output_item.done' && item?.type === 'function_call') this.handleToolCall(state, item.name, item.call_id, item.arguments).catch(error => this.logger.error('[voice] tool failed', error.message));
  }
  async handleToolCall(state, name, toolCallId, rawArgs) {
    if (!toolCallId || state.toolCalls.has(toolCallId)) return; state.toolCalls.add(toolCallId);
    let args = {}; try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {}; } catch { args = {}; }
    let output;
    if (name === 'transfer_to_human') output = await this.transferToHuman(state, args);
    else { const tools = this.toolsFactory(state.propertyId, 'phone', state.callId); output = tools[name] ? await tools[name](args) : { error: 'unknown_tool' }; }
    if (state.socket?.readyState === state.socket.OPEN) { state.socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify(output) } })); if (!state.transferred) state.socket.send(JSON.stringify({ type: 'response.create' })); }
  }
  async transferToHuman(state, { reason = 'caller_request', urgency = 'normal' } = {}) {
    const tools = this.toolsFactory(state.propertyId, 'phone', state.callId); await tools.escalate_to_human({ reason, urgency }).catch(() => {});
    if (!state.adminTransferUri) return { error: 'human_administrator_not_configured' };
    await this.client.referCall(state.callId, state.adminTransferUri); state.transferred = true; await this.finishCall(state, 'transferred', 'human_transfer'); return { transferred: true };
  }
  beginLimitTransfer(state) { if (!state.transferred && state.socket?.readyState === state.socket.OPEN) state.socket.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Briefly explain that the call time is ending and you will now connect the caller with the hotel administrator.' } })); }
  async forceEnd(state) { if (state.transferred) return; if (state.adminTransferUri) await this.transferToHuman(state, { reason: 'call_time_limit', urgency: 'normal' }).catch(() => {}); else { await this.client.hangupCall(state.callId).catch(() => {}); await this.finishCall(state, 'completed', 'time_limit'); } }
  async finishCall(state, status, outcome) { if (state.finished) return; state.finished = true; this.clearTimeout(state.limitTimer); this.clearTimeout(state.hangupTimer); this.calls.delete(state.callId); await this.repo.finish({ p_call_id: state.callId, p_status: status, p_outcome: outcome, p_error_code: null, p_transferred: Boolean(state.transferred) }).catch(error => this.logger.error('[voice] finish failed', error.message)); try { state.socket?.close(); } catch {} }
  async markStaleCalls() { await this.repo.stale(this.config.hungSeconds); }
}

function createVoiceCallService({ supabase, env = process.env, ...rest }) { return new VoiceCallService({ supabase, config: voiceConfig(env), ...rest }); }
module.exports = { VoiceCallService, VoiceCallRepository, createVoiceCallService, voiceConfig, normalizePhoneNumber, hashCaller, toRealtimeTools };
