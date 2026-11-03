'use strict';
const { MonoSubscriptionError } = require('./mono-subscriptions');

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_ORIGINS = new Set([
  'https://stayai.online',
  'https://www.stayai.online',
]);

async function readRequestBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new MonoSubscriptionError('Request too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function respond(res, code, result, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(result));
}

function createMonoSubscriptionHttp(service) {
  if (!service ||
      typeof service.createSubscriptionInvoice !== 'function' ||
      typeof service.receiveSignedWebhook !== 'function') {
    throw new Error('Mono subscription service is required');
  }
  return async function monoSubscriptionHttp(req, res) {
    const urlPath = String(req.url || '').split('?')[0];
    const isInvoice = urlPath === '/api/create-subscription-invoice';
    const isWebhook = urlPath === '/webhook/mono-subscription';
    if (!isInvoice && !isWebhook) return false;

    const origin = req.headers.origin;
    const cors = isInvoice && ALLOWED_ORIGINS.has(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Vary': 'Origin',
        }
      : {};

    if (isInvoice && req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store', ...cors });
      res.end();
      return true;
    }
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'Method not allowed' }, cors);
      return true;
    }

    try {
      const rawBody = await readRequestBody(req);
      if (isInvoice) {
        let input;
        try { input = JSON.parse(rawBody.toString('utf8')); } catch {
          throw new MonoSubscriptionError('Некоректний JSON.', 400);
        }
        const auth = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        const result = await service.createSubscriptionInvoice({
          authToken: auth ? auth[1] : null,
          propertyId: input.propertyId,
          plan: input.plan,
        });
        respond(res, 200, result, cors);
        return true;
      }
      await service.receiveSignedWebhook({
        rawBody,
        xSign: req.headers['x-sign'],
      });
      respond(res, 200, { ok: true });
      return true;
    } catch (error) {
      const code = error instanceof MonoSubscriptionError
        ? error.statusCode : 502;
      // Never include upstream exception messages, secrets or stack traces.
      const description = isInvoice && code < 500 && error instanceof MonoSubscriptionError
        ? error.message : 'Помилка обробки платежу.';
      respond(res, code, { error: description }, cors);
      return true;
    }
  };
}

module.exports = { createMonoSubscriptionHttp };
