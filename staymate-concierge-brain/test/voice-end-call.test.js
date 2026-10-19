'use strict';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_KEY ||= 'test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {VoiceCallService,voiceConfig}=require('../voice-calls');
test('guest goodbye invokes a short final response then SIP hangup', async()=>{
 const output=[],timeouts=[],hung=[];
 const socket={OPEN:1,readyState:1,send:value=>output.push(JSON.parse(value)),close:()=>{}};
 const s=new VoiceCallService({
   realtimeClient:{hangupCall:async id=>hung.push(id)},
   repository:{finish:async()=>{}},
   config:voiceConfig(),
   setTimeoutImpl:fn=>{timeouts.push(fn);return fn;},
   clearTimeoutImpl:()=>{},
 });
 const state={callId:'call-end',propertyId:'h',socket,conversationLanguage:'ru',
   toolCalls:new Set(),responseLatencies:[],toolLatencies:[]};
 await s.handleToolCall(state,'end_call','tool-id','{}');
 assert.equal(state.endingCall,true);
 assert.equal(output[0].type,'conversation.item.create');
 assert.equal(output[1].type,'response.create');
 assert.match(output[1].response.instructions,/goodbye/i);
 s.onEvent(state,{type:'response.created'});
 s.onEvent(state,{type:'response.done'});
 assert.equal(hung.length,0);
 assert.equal(timeouts.length,1);
 await timeouts[0]();
 assert.deepEqual(hung,['call-end']);
 assert.equal(state.finished,true);
});
