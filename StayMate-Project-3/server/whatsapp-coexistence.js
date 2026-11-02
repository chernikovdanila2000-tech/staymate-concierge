'use strict';

/** WhatsApp Business App + Cloud API coexistence.
 * Webhooks are only processed after Meta HMAC verification in server.js.
 * Always resolve a customer's connected phone ID before writing any data.
 */
function normalizeTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 4102444800
    ? new Date(n * 1000).toISOString()
    : new Date().toISOString();
}

function textForMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.type === 'text') return String(message.text?.body || '').slice(0, 4096);
  if (message.type === 'button') return String(message.button?.text || '').slice(0, 4096);
  return null; // Do not invent text for audio/media or private attachments.
}

function parseCoexistenceEvents(payload) {
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return [];
  const events = [];
  for (const entry of payload.entry) {
    for (const change of entry?.changes || []) {
      const field = change?.field;
      const value = change?.value || {};
      const phoneNumberId = String(value.metadata?.phone_number_id || '');
      if (!phoneNumberId) continue;
      if (field === 'smb_message_echoes') {
        for (const message of value.message_echoes || []) {
          if (!message?.id || !message?.to) continue;
          events.push({
            kind: 'message', source: 'business_app', phoneNumberId,
            messageId: String(message.id), chatId: String(message.to),
            direction: 'outbound', text: textForMessage(message),
            messageType: String(message.type || 'unknown'),
            sentAt: normalizeTimestamp(message.timestamp),
          });
        }
      } else if (field === 'history') {
        const businessNumber = String(value.metadata?.display_phone_number || '').replace(/\D/g, '');
        for (const chunk of value.history || []) {
          if (Array.isArray(chunk?.errors) && chunk.errors.length) {
            events.push({kind: 'history_status', phoneNumberId, status: 'not_shared'});
            continue;
          }
          for (const thread of chunk?.threads || []) {
            if (!thread?.id) continue;
            for (const message of thread.messages || []) {
              if (!message?.id) continue;
              const sender = String(message.from || '').replace(/\D/g, '');
              events.push({
                kind: 'message', source: 'history', phoneNumberId,
                messageId: String(message.id), chatId: String(thread.id),
                direction: businessNumber && sender === businessNumber ? 'outbound' : 'inbound',
                text: textForMessage(message),
                messageType: String(message.type || 'unknown'),
                sentAt: normalizeTimestamp(message.timestamp),
              });
            }
          }
          if (chunk?.metadata?.progress === 100) {
            events.push({kind:'history_status', phoneNumberId, status:'completed'});
          }
        }
      } else if (field === 'smb_app_state_sync') {
        for (const item of value.state_sync || []) {
          if (item?.type !== 'contact' || !item.contact?.phone_number) continue;
          events.push({
            kind:'contact', phoneNumberId, contactId:String(item.contact.phone_number),
            contactName:String(item.contact.full_name || item.contact.first_name || '').slice(0,200),
            action:String(item.action || '').slice(0,32),
          });
        }
      }
    }
  }
  return events;
}

async function requestBusinessAppSync({ phoneNumberId, accessToken, syncType, graphVersion = 'v24.0', fetchImpl = globalThis.fetch }) {
  if (!['history','smb_app_state_sync'].includes(syncType)) throw new Error('Unsupported WhatsApp sync type.');
  if (!/^[0-9]{5,30}$/.test(String(phoneNumberId)) || !accessToken) throw new Error('Missing WhatsApp sync credentials.');
  const response = await fetchImpl('https://graph.facebook.com/' + graphVersion + '/' + phoneNumberId + '/smb_app_data', {
    method:'POST',
    headers:{Authorization:'Bearer ' + accessToken,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',sync_type:syncType}),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('WhatsApp ' + syncType + ' sync request failed (HTTP ' + response.status + ').');
  return json;
}

module.exports = { parseCoexistenceEvents, requestBusinessAppSync, textForMessage };
