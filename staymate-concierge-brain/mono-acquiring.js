'use strict';

/**
 * mono acquiring API client for StayAI.
 * This module DOES NOT accept partner onboarding tokens or personal statement tokens.
 * Requires the acquiring merchant's own server-side X-Token.
 * No raw tokens or payment data are ever logged.
 */
const crypto = require('node:crypto');
const MONO_API = 'https://api.monobank.ua';

class MonoApiError extends Error {
  constructor(status) {
    super('mono acquiring API rejected request (HTTP ' + status + ')');
    this.name = 'MonoApiError';
    this.status = status;
  }
}

async function requestMono(path, { token, method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('MONO_MERCHANT_TOKEN is not configured');
  }
  if (typeof fetchImpl !== 'function') throw new Error('HTTP fetch is unavailable');
  if (!/^\/api\/merchant\/[a-zA-Z0-9/?=_-]+$/.test(path)) throw new TypeError('Invalid mono acquiring API path');
  const res = await fetchImpl(MONO_API + path, {
    method,
    headers: {
      'X-Token': token,
      'X-Cms': 'StayAI',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new MonoApiError(res.status);
  return res.json();
}

async function checkMerchantToken(token, options = {}) {
  const data = await requestMono('/api/merchant/details', { token, ...options });
  if (!data || typeof data.merchantId !== 'string' || !data.merchantId) {
    throw new Error('mono response did not identify an acquiring merchant');
  }
  return { merchantId: data.merchantId, merchantName: data.merchantName || '' };
}

function httpsUrl(value, label) {
  if (value === undefined || value === null) return undefined;
  let url;
  try { url = new URL(value); } catch { throw new TypeError(label + ' must be valid HTTPS'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError(label + ' must be HTTPS without credentials or fragment');
  }
  return url.toString();
}

function isValidPaymentLink(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'pay.mbnk.biz' && !u.username && !u.password;
  } catch { return false; }
}

async function createInvoice({ token, amountKopecks, reference, destination, redirectUrl, webHookUrl, fetchImpl } = {}) {
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) {
    throw new TypeError('Amount must be positive integer kopecks');
  }
  if (typeof reference !== 'string' || !/^[A-Za-z0-9_-]{3,80}$/.test(reference)) {
    throw new TypeError('Invalid order reference');
  }
  const body = {
    amount: amountKopecks,
    ccy: 980,
    paymentType: 'debit',
    merchantPaymInfo: {
      reference,
      ...(destination ? { destination: String(destination).slice(0, 200) } : {}),
    },
    ...(httpsUrl(webHookUrl, 'webHookUrl') ? { webHookUrl: httpsUrl(webHookUrl, 'webHookUrl') } : {}),
    ...(httpsUrl(redirectUrl, 'redirectUrl') ? { redirectUrl: httpsUrl(redirectUrl, 'redirectUrl') } : {}),
  };
  const r = await requestMono('/api/merchant/invoice/create', { token, method: 'POST', body, fetchImpl });
  if (typeof r?.invoiceId !== 'string' || !isValidPaymentLink(r.pageUrl)) {
    throw new Error('mono invoice response is invalid');
  }
  return { invoiceId: r.invoiceId, invoiceUrl: r.pageUrl };
}

async function getInvoiceStatus({ token, invoiceId, fetchImpl } = {}) {
  if (typeof invoiceId !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(invoiceId)) {
    throw new TypeError('Invalid invoice ID');
  }
  return requestMono('/api/merchant/invoice/status?invoiceId=' + encodeURIComponent(invoiceId), { token, fetchImpl });
}

async function getWebhookPublicKey({ token, fetchImpl } = {}) {
  const result = await requestMono('/api/merchant/pubkey', { token, fetchImpl });
  if (typeof result?.key !== 'string' || !result.key) throw new Error('mono public key missing');
  return result.key;
}

function verifyWebhookSignature({ publicKeyBase64, rawBody, signatureBase64 } = {}) {
  if (typeof publicKeyBase64 !== 'string' || typeof signatureBase64 !== 'string' ||
      !(Buffer.isBuffer(rawBody) || typeof rawBody === 'string') ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyBase64) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)) return false;
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(Buffer.from(publicKeyBase64, 'base64'),
      Buffer.from(signatureBase64, 'base64'));
  } catch { return false; }
}

function matchesPaidInvoice(event, { invoiceId, reference, amountKopecks }) {
  return Boolean(event && event.status === 'success' &&
    event.invoiceId === invoiceId && event.reference === reference &&
    event.ccy === 980 && event.amount === amountKopecks &&
    Number.isSafeInteger(amountKopecks) && amountKopecks > 0);
}

module.exports = {
  MonoApiError, requestMono, checkMerchantToken, createInvoice,
  getInvoiceStatus, getWebhookPublicKey, verifyWebhookSignature,
  matchesPaidInvoice,
};
