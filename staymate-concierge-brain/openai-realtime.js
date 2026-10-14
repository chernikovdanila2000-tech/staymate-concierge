'use strict';

const OpenAI = require('openai');
const WebSocket = require('ws');

const API = 'https://api.openai.com/v1/realtime/calls';

/** A small sideband client. Audio stays between the SIP provider and OpenAI. */
class OpenAIRealtimeClient {
  constructor({ apiKey, webhookSecret, fetchImpl = global.fetch, WebSocketImpl = WebSocket }) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.sdk = new OpenAI({ apiKey, webhookSecret });
  }

  async unwrapWebhook(rawBody, headers) {
    return this.sdk.webhooks.unwrap(rawBody, headers);
  }

  async request(callId, action, method, body) {
    // Encode the call id only. Encoding the complete path would turn the
    // action separator into %2F and make OpenAI receive a different route.
    const response = await this.fetch(`${API}/${encodeURIComponent(callId)}${action}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = new Error(`OpenAI Realtime ${method} ${response.status}`);
      error.status = response.status;
      // A provider error code identifies the rejected parameter without
      // retaining the response body (which can contain request context).
      const body = await response.json().catch(() => null);
      error.providerCode = typeof body?.error?.code === 'string' ? body.error.code : null;
      throw error;
    }
    // SIP call-control endpoints, including /accept, return 200 with an
    // empty body. Treat every successful empty response as success instead
    // of attempting JSON parsing and hanging up an already accepted call.
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  acceptCall(callId, session) { return this.request(callId, '/accept', 'POST', session); }
  referCall(callId, targetUri) { return this.request(callId, '/refer', 'POST', { target_uri: targetUri }); }
  rejectCall(callId, statusCode = 486) { return this.request(callId, '/reject', 'POST', { status_code: statusCode }); }
  // The Realtime API uses POST /hangup (not HTTP DELETE) for SIP/WebRTC calls.
  hangupCall(callId) { return this.request(callId, '/hangup', 'POST', {}); }

  openMonitor(callId, { onOpen, onEvent, onError, onClose }) {
    const socket = new this.WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    socket.on('open', () => onOpen?.());
    socket.on('message', raw => {
      try { onEvent?.(JSON.parse(raw.toString())); } catch (error) { onError?.(error); }
    });
    socket.on('error', error => onError?.(error));
    socket.on('close', () => onClose?.());
    return socket;
  }
}

module.exports = { OpenAIRealtimeClient };
