'use strict';
const http = require('node:http');
const { createClient } = require('@supabase/supabase-js');
const { createVoiceCallService } = require('./voice-calls');
const { SmsNotificationService } = require('./sms');
const { buildSystemPrompt, getDateContext } = require('./system-prompt');
const e = process.env;
const flags = ['VOICE_ENABLED', 'SMS_ENABLED', 'SMS_STAGING_TEST_ENABLED',
  'VOICE_STAGING_TEST_SMS_ENABLED', 'VOICE_TRUST_SIP_CALLER_ID'];
if (e.RAILWAY_ENVIRONMENT_NAME !== 'voice-realtime-test' ||
    new URL(e.SUPABASE_URL).hostname !== 'nyknlyufbwjodbpyehtv.supabase.co' ||
    flags.some(k => e[k] !== 'true')) throw Error('voice_sms_environment_not_verified');
const supabase = createClient(e.SUPABASE_URL, e.SUPABASE_KEY);
const sms = new SmsNotificationService({supabase});
const voice = createVoiceCallService({
 supabase,
 smsService: sms,
 // Preserve all original StayAI tools, tenant routing, hotel info and booking logic.
 buildPromptImpl: ({propertyName, hotelInfo}) => {
   const date = getDateContext();
   return buildSystemPrompt({propertyName, hotelInfo}) + [
     '',
     'ADDITIONAL LIVE TELEPHONE RULES:',
     'Now in Europe/Kyiv: ' + date.today + '. Tomorrow: ' + date.tomorrow +
        '. Day after tomorrow: ' + date.dayAfterTomorrow + '.',
     'Russian: сегодня=today, завтра=tomorrow, послезавтра=day after tomorrow.',
     'Ukrainian: сьогодні=today, завтра=tomorrow, післязавтра=day after tomorrow.',
     'DATE PRONUNCIATION ON THE PHONE: Say dates naturally in words in the caller language. For 2026-10-20 say in Russian “двадцатого октября”, in Ukrainian “двадцятого жовтня”. Never read YYYY-MM-DD digit by digit, never say “twenty twenty” or repeat “двадцать-двадцать” for a date. Normally say the day and month; add the year in natural words only when relevant or the caller asks. For tool arguments (check_availability and create_booking), however, always keep exact ISO YYYY-MM-DD dates. Do not change the date itself when changing how it is spoken.',
     'When someone asks to book today, understand check-in=' + date.today +
        '. Ask only for missing check-out date (one night if guest confirms), guest count and room choice.',
     'Use check_availability immediately after the dates and number of guests are clear.',
     'Never transfer a routine booking request to a person because dates or room catalog are unknown.',
     'First use the original tools and data; give actual dates and accurate prices.',
     'Speak exclusively in the language of the caller: Russian, Ukrainian or English.',
     'A caller must never need to say the word test or know tool names.',
     'The informational SMS text is predefined. NEVER ask the caller to choose or dictate message contents.',
     'After discussing room options, offer one informational SMS to the guest. No booking or payment is needed to send this message.',
     'If the carrier provided a trusted calling number, NEVER ask the guest to dictate it. After explicit consent call send_staging_test_sms with consent=true and no phone argument.',
     'If Caller ID was not received, tell the guest you cannot see their number; ask them to dictate their mobile once, repeat it back for confirmation, and after explicit consent call send_staging_test_sms with phone=confirmed number and consent=true.',
     'When booking cannot be completed because online payment is not set up, explain this accurately AND still offer the informational SMS independently. Do not refuse the SMS merely because payment or booking creation is unavailable.',
     'Never ask the guest to request a test SMS or mention technical tools. Ask naturally: Would you like me to send a short information message to your phone?',
     'The SMS is informational only; it does not confirm the booking and does not contain a payment URL.',
     'If SMS dispatch returns ACCEPTED, say only that the message was accepted for sending, not that it was delivered.',
     'Do not claim a booking is made unless create_booking returned ok=true.',
     'If the caller ends the conversation or says goodbye, call end_call promptly. Give one short goodbye and hang up; do not wait for another question.',
     'No fake confirmations, no invented availability, no second SMS without permission.'
   ].join('\n');
 }
});
const ready = Boolean(voice.isReady() && sms.enabledProvider('turbosms') &&
  voice.config.trustSipCallerId && voice.config.stagingTestSmsEnabled);
// Reconcile receipts for already-sent pilot SMS; this never submits a new SMS.
if (ready) {
 const poll = () => sms.reconcileTurboStatuses()
   .then(result => { if (result.checked) console.log('[sms] polled provider delivery', result); })
   .catch(err => console.warn('[sms] delivery poll unavailable', err?.message?.slice(0, 80)));
 setTimeout(poll, 1000);
 const pollTimer = setInterval(poll, 60000);
 pollTimer.unref?.();
}
function respond(res,code,obj) {
 res.writeHead(code, {'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store'});
 res.end(JSON.stringify(obj));
}
function readBody(req) {
 return new Promise((resolve,reject)=>{
  let chunks='', size=0;
  req.on('data',c=>{
   size+=c.length;
   if(size>65536){reject(new Error('body_too_large'));req.destroy();return;}
   chunks+=c.toString('utf8');
  });
  req.on('end',()=>resolve(chunks));
  req.on('error',reject);
 });
}
http.createServer(async (req,res)=>{
 const path=(req.url||'').split('?')[0];
 if(req.method==='GET' && path==='/health') {
  return respond(res,ready?200:503,{
   ok:ready,mode:'full_concierge_plus_one_opt_in_sms',
   callerIdBound:voice.config.trustSipCallerId,
   voice:voice.health()
  });
 }
 if(req.method!=='POST'||path!=='/webhook/openai/voice')
   return respond(res,404,{error:'not_found'});
 if(!ready)return respond(res,503,{error:'not_ready'});
 try {
  const result=await voice.handleWebhook(await readBody(req),req.headers);
  return respond(res,result.status,result.body);
 } catch(err) {
  console.error('[voice sms] request_failed',err?.name||'Error');
  return respond(res,500,{error:'internal_error'});
 }
}).listen(Number(e.PORT||8080),'0.0.0.0',()=>{
 console.log('[voice sms] full original tools + one consented SMS, ready='+ready);
});
