'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCoexistenceEvents, requestBusinessAppSync } = require('../whatsapp-coexistence');

test('Business App echoes are outbound and never mistaken for new inbound guest messages', () => {
  const payload = { object:'whatsapp_business_account', entry:[{ changes:[{
    field:'smb_message_echoes', value:{
      metadata:{phone_number_id:'123456'},
      message_echoes:[{id:'wamid.echo-1',from:'380111111111',to:'380222222222',
        timestamp:'1790000000',type:'text',text:{body:'We can help with your reservation.'}}],
    }
  }]}]};
  const result = parseCoexistenceEvents(payload);
  assert.equal(result.length,1);
  assert.deepEqual(result[0],{
    kind:'message',source:'business_app',phoneNumberId:'123456',messageId:'wamid.echo-1',
    chatId:'380222222222',direction:'outbound',text:'We can help with your reservation.',
    messageType:'text',sentAt:new Date(1790000000*1000).toISOString(),
  });
});

test('historical messages retain original direction, chat ID and message ID', () => {
  const payload={object:'whatsapp_business_account',entry:[{changes:[{
    field:'history',value:{
      metadata:{phone_number_id:'123456',display_phone_number:'+380 11 111 11 11'},
      history:[{metadata:{phase:0,progress:100},
        threads:[{id:'380222222222',messages:[
          {id:'wamid.in',from:'380222222222',to:'380111111111',timestamp:'1790000000',
           type:'text',text:{body:'Hello'}},
          {id:'wamid.out',from:'380111111111',to:'380222222222',timestamp:'1790000010',
           type:'text',text:{body:'Welcome'}},
        ]}]
      }]
    }
  }]}]};
  const result=parseCoexistenceEvents(payload);
  assert.equal(result.length,3);
  assert.deepEqual(result.slice(0,2).map(m=>[m.messageId,m.direction,m.chatId]),[
    ['wamid.in','inbound','380222222222'],['wamid.out','outbound','380222222222'],
  ]);
  assert.equal(result[2].status,'completed');
});

test('history opt-out and contact sync are handled without generating replies', () => {
  const payload={object:'whatsapp_business_account',entry:[{changes:[
    {field:'history',value:{metadata:{phone_number_id:'123456'},
      history:[{errors:[{code:2593109}]}]}},
    {field:'smb_app_state_sync',value:{metadata:{phone_number_id:'123456'},
      state_sync:[{type:'contact',contact:{phone_number:'380222222222',
        full_name:'Guest Example'},action:'update'}]}},
  ]}]};
  const result=parseCoexistenceEvents(payload);
  assert.equal(result.length,2);
  assert.equal(result[0].status,'not_shared');
  assert.equal(result[1].contactName,'Guest Example');
  assert.equal(result[1].kind,'contact');
});

test('one-time sync uses the correct WhatsApp API with bearer token', async () => {
  const calls=[];
  const fakeFetch=async (url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify({request_id:'req-1'}),{status:200});
  };
  const result=await requestBusinessAppSync({
    phoneNumberId:'123456',accessToken:'secret',syncType:'history',
    graphVersion:'v26.0',fetchImpl:fakeFetch,
  });
  assert.equal(result.request_id,'req-1');
  assert.equal(calls[0].url,'https://graph.facebook.com/v26.0/123456/smb_app_data');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers.Authorization,'Bearer secret');
  assert.deepEqual(JSON.parse(calls[0].options.body),{
    messaging_product:'whatsapp',sync_type:'history',
  });
  await assert.rejects(
    ()=>requestBusinessAppSync({phoneNumberId:'123456',accessToken:'secret',
      syncType:'wrong',fetchImpl:fakeFetch}),/Unsupported/
  );
});

test('unrelated payloads, status updates and unsupported media do not generate text', () => {
  assert.deepEqual(parseCoexistenceEvents({object:'page',entry:[]}),[]);
  const result=parseCoexistenceEvents({object:'whatsapp_business_account',entry:[
    {changes:[{field:'smb_message_echoes',value:{metadata:{phone_number_id:'123456'},
      message_echoes:[{id:'media-1',from:'business',to:'guest',timestamp:'1790000000',
        type:'image',image:{id:'image-1'}}]}}]},
  ]});
  assert.equal(result.length,1);
  assert.equal(result[0].text,null);
});
