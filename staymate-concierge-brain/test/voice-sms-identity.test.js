'use strict';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_KEY ||= 'test-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VoiceCallService, voiceConfig, phoneFromSipIdentity, sipCallerIdentity } = require('../voice-calls');

test('SIP caller parser accepts phone URI and does not mix display-name extensions', () => {
 assert.equal(phoneFromSipIdentity('sip:+380501234567@zadarma'), '+380501234567');
 assert.equal(phoneFromSipIdentity('"Office 101" <sip:+380501234567@carrier.example>;tag=x'), '+380501234567');
 assert.equal(phoneFromSipIdentity('<tel:+380501234567>'), '+380501234567');
 assert.equal(phoneFromSipIdentity('"380501234567" <sip:anonymous@pbx.example>'), '+380501234567');
 assert.equal(phoneFromSipIdentity('"380501234567" sip:<@pbx.example>'), '+380501234567');
 assert.equal(phoneFromSipIdentity('"Office 101" <sip:anonymous@pbx.example>'), null);
 assert.equal(phoneFromSipIdentity('sip:1001@pbx.example'), null);
 assert.equal(phoneFromSipIdentity('sip:proj_AJV3lMNB4yT4ITo42ScEZMmC@sip.api.openai.com'), null);
 assert.equal(phoneFromSipIdentity('anonymous'), null);
});

test('uses asserted identity if From is absent; never mistakes hotel DID for guest', () => {
 const header = [
  {name:'From',value:'anonymous'},
  {name:'P-Asserted-Identity',value:'<sip:+380501234567@carrier.example>'}
 ];
 assert.deepEqual(sipCallerIdentity(header,'+380443002819'), {phone:'+380501234567',source:'p-asserted-identity'});
 assert.deepEqual(sipCallerIdentity([
  {name:'From',value:'sip:+380443002819@provider'},
  {name:'Remote-Party-ID',value:'<tel:+380501234567>'}
 ],'+380443002819'), {phone:'+380501234567',source:'remote-party-id'});
 assert.deepEqual(sipCallerIdentity([{name:'From',value:'anonymous'}],'+380443002819'), {phone:null,source:'not_available'});
});

function configuredService(sipHeaders, sent) {
 const socket = new EventEmitter();
 socket.OPEN=1; socket.readyState=1; socket.send=()=>{}; socket.close=()=>{};
 const sessions=[];
 const cfg=voiceConfig({VOICE_ENABLED:'true',VOICE_OPENAI_API_KEY:'key',VOICE_OPENAI_WEBHOOK_SECRET:'secret',VOICE_TRUST_SIP_CALLER_ID:'true',VOICE_STAGING_TEST_SMS_ENABLED:'true'});
 const client={
  unwrapWebhook:async()=>({type:'realtime.call.incoming',data:{call_id:'call-sms-recipient',sip_headers:sipHeaders}}),
  acceptCall:async(_,session)=>sessions.push(session),
  openMonitor:()=>socket,
  hangupCall:async()=>{},
 };
 const svc=new VoiceCallService({
  repository:{
   begin:async()=>({ok:true,property_id:'hotel-a',admin_transfer_uri:null}),
   property:async()=>({property_id:'hotel-a',hotel_name:'Hotel A'}),
   finish:async()=>{},
  },
  realtimeClient:client, config:cfg, logger:{info(){},warn(){},error(){}},
  getHotelInfoImpl:async()=>({}),buildPromptImpl:()=> 'Hotel A booking help',
  toolsFactory:()=>({}),
  smsService:{
   config:{stagingTestEnabled:true},
   createStagingTestSms:async input=>{sent.push(input);return {ok:true,status:'ACCEPTED'}},
  },
  setTimeoutImpl:()=>({}),clearTimeoutImpl:()=>{}
 });
 return {svc,sessions};
}

test('missing SIP caller allows consented SMS to guest-confirmed spoken phone without invoice',async()=>{
 const sent=[];
 const {svc,sessions}=configuredService([{name:'To',value:'sip:+380443002819@carrier'}],sent);
 assert.equal((await svc.handleWebhook('{}',{})).status,200);
 const state=svc.calls.get('call-sms-recipient');
 assert.equal(state.callerPhone,null);
 const tool=sessions[0].tools.find(t=>t.name==='send_staging_test_sms');
 assert.deepEqual(tool.parameters.required,['phone','consent']);
 assert.equal((await svc.deliverStagingTestSms(state,{phone:'+380501234567',consent:false})).error,'guest_consent_required');
 assert.equal(sent.length,0);
 assert.deepEqual(await svc.deliverStagingTestSms(state,{phone:'+380501234567',consent:true}),{ok:true,status:'ACCEPTED'});
 assert.deepEqual(sent,[{propertyId:'hotel-a',phone:'+380501234567',callId:'call-sms-recipient',consent:true,phoneSource:'spoken_confirmed'}]);
});

test('trusted SIP Caller ID overrides a hallucinated or spoken replacement SMS destination',async()=>{
 const sent=[];
 const {svc,sessions}=configuredService([
  {name:'To',value:'sip:+380443002819@carrier'},
  {name:'From',value:'sip:+380991234567@carrier'}
 ],sent);
 assert.equal((await svc.handleWebhook('{}',{})).status,200);
 const state=svc.calls.get('call-sms-recipient');
 assert.equal(state.callerPhone,'+380991234567');
 const tool=sessions[0].tools.find(t=>t.name==='send_staging_test_sms');
 assert.deepEqual(tool.parameters.required,['consent']);
 await svc.deliverStagingTestSms(state,{phone:'+380501234567',consent:true});
 assert.deepEqual(sent,[{propertyId:'hotel-a',phone:'+380991234567',callId:'call-sms-recipient',consent:true,phoneSource:'trusted_sip_caller_id'}]);
});
