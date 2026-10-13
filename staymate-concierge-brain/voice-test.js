'use strict';

const crypto = require('crypto');

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

function boolEnv(value) { return String(value || '').toLowerCase() === 'true'; }

function voiceTestConfig(env = process.env) {
  return {
    enabled: boolEnv(env.VOICE_TEST_ENABLED),
    token: env.VOICE_TEST_ACCESS_TOKEN || '',
    propertyId: String(env.VOICE_TEST_PROPERTY_ID || env.PROPERTY_ID || '').trim(),
    apiKey: env.VOICE_OPENAI_API_KEY || env.TRANSCRIPTION_API_KEY || '',
    model: env.VOICE_MODEL || 'gpt-realtime-2.1-mini',
    voice: env.VOICE_TTS_VOICE || 'marin',
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function hasVoiceTestAccess(headers, token) {
  const value = String(headers?.authorization || '');
  if (!value.startsWith('Basic ') || !token) return false;
  let decoded = '';
  try { decoded = Buffer.from(value.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEqual(username, 'stayai-test') && safeEqual(password, token);
}

function testPageHtml() {
  return `<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StayAI Voice Test</title><style>body{font-family:system-ui;background:#101425;color:#fff;max-width:620px;margin:0 auto;padding:28px}button{font:inherit;padding:12px 16px;border:0;border-radius:9px;background:#4f46e5;color:#fff;margin:8px 8px 8px 0}button:disabled{opacity:.5}#status{padding:14px;background:#1d2439;border-radius:9px;white-space:pre-wrap}small{color:#b5bed4}</style><h1>StayAI Voice Test</h1><p>Закритий короткий тест голосового адміністратора. Аудіо не записується та не зберігається.</p><button id="start">Увімкнути мікрофон і почати</button><button id="stop" disabled>Завершити</button><div id="status">Готовий до тесту.</div><p><small>Скажіть українською або російською: «Які є номери?» Потім перебийте відповідь новим питанням.</small></p><script>(()=>{let pc,stream,dc;const status=document.querySelector('#status'),start=document.querySelector('#start'),stop=document.querySelector('#stop');const set=s=>status.textContent=s;async function end(message){try{dc&&dc.close();pc&&pc.close();stream&&stream.getTracks().forEach(t=>t.stop())}finally{pc=stream=dc=null;start.disabled=false;stop.disabled=true;if(message)set(message)}}start.onclick=async()=>{start.disabled=true;try{set('Запитую доступ до мікрофона…');stream=await navigator.mediaDevices.getUserMedia({audio:true});pc=new RTCPeerConnection();const audio=document.createElement('audio');audio.autoplay=true;pc.ontrack=e=>audio.srcObject=e.streams[0];dc=pc.createDataChannel('oai-events');dc.onmessage=e=>{try{const x=JSON.parse(e.data);if(x.type==='input_audio_buffer.speech_started')set('Почув вашу репліку — відповідь AI зупинено.');else if(x.type==='response.audio_transcript.done')set('AI: '+x.transcript);else if(x.type==='error')set('Помилка Realtime. Спробуйте ще раз.')}catch{}};stream.getTracks().forEach(t=>pc.addTrack(t,stream));const offer=await pc.createOffer();await pc.setLocalDescription(offer);const response=await fetch('/internal/voice-test/session',{method:'POST',headers:{'Content-Type':'application/sdp'},body:offer.sdp,credentials:'same-origin'});if(!response.ok)throw new Error('session');await pc.setRemoteDescription({type:'answer',sdp:await response.text()});dc.onopen=()=>{stop.disabled=false;set('Підключено. Говоріть українською або російською.');dc.send(JSON.stringify({type:'response.create',response:{instructions:'Greet the caller briefly in Ukrainian, then ask how you can help.'}}));};}catch(e){await end('Не вдалося почати захищений тест. Перевірте дозвіл на мікрофон і спробуйте ще раз.')}};stop.onclick=()=>end('Тест завершено.');window.addEventListener('beforeunload',()=>end());})();</script></html>`;
}

class VoiceTestService {
  constructor({ supabase, config = voiceTestConfig(), fetchImpl = global.fetch, getHotelInfoImpl, buildPromptImpl }) {
    this.supabase = supabase; this.config = config; this.fetch = fetchImpl; this.getHotelInfo = getHotelInfoImpl; this.buildPrompt = buildPromptImpl;
  }
  isReady() { return Boolean(this.config.enabled && this.config.token && this.config.propertyId && this.config.apiKey); }
  async createSessionAnswer(sdp) {
    if (!this.isReady()) { const error = new Error('voice_test_disabled'); error.status = 404; throw error; }
    if (!sdp || Buffer.byteLength(sdp) > 100000) { const error = new Error('invalid_sdp'); error.status = 400; throw error; }
    const { data: property, error } = await this.supabase.from('properties').select('property_id,hotel_name').eq('property_id', this.config.propertyId).maybeSingle();
    if (error || !property) { const failure = new Error('voice_test_property_unavailable'); failure.status = 503; throw failure; }
    // Lazy defaults keep this isolated module importable in a test process that
    // deliberately has no production Supabase configuration.
    const getInfo = this.getHotelInfo || require('./hotel-info').getHotelInfo;
    const buildPrompt = this.buildPrompt || require('./system-prompt').buildSystemPrompt;
    const hotelInfo = await getInfo(property.property_id);
    const instructions = `${buildPrompt({ propertyName: property.hotel_name, hotelInfo })}\n\nThis is a short protected voice test, not a public service. Speak naturally in the caller's language (Ukrainian or Russian). Keep answers concise. Use only the hotel facts above. For rooms, prices, or availability say that the production tool will verify them; do not invent them. If the caller starts speaking during your response, stop immediately and listen.`;
    const form = new FormData();
    form.set('sdp', sdp);
    form.set('session', JSON.stringify({ type: 'realtime', model: this.config.model, instructions, max_output_tokens: 180, audio: { input: { turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true } }, output: { voice: this.config.voice } } }));
    const safetyId = crypto.createHash('sha256').update(`voice-test:${this.config.propertyId}`).digest('hex');
    const response = await this.fetch(REALTIME_CALLS_URL, { method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'OpenAI-Safety-Identifier': safetyId }, body: form });
    if (!response.ok) { const failure = new Error(`voice_test_realtime_${response.status}`); failure.status = 502; throw failure; }
    return response.text();
  }
}

module.exports = { VoiceTestService, voiceTestConfig, hasVoiceTestAccess, testPageHtml };
