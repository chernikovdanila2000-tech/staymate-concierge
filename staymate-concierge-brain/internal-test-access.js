'use strict';

const crypto = require('crypto');

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// /chat is a development harness, never a public tenant-discovery API.  It
// is disabled unless a deployment deliberately enables it and supplies a
// server-side token.  Voice, hotel widgets, and provider webhooks do not use
// this route.
function hasInternalTestAccess(headers = {}, env = process.env) {
  if (String(env.INTERNAL_TEST_CHAT_ENABLED || '').toLowerCase() !== 'true') return false;
  const expected = String(env.INTERNAL_TEST_CHAT_TOKEN || '');
  if (!expected) return false;
  const authorization = String(headers.authorization || headers.Authorization || '');
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : String(headers['x-internal-test-token'] || '');
  return timingSafeEqual(supplied, expected);
}

module.exports = { hasInternalTestAccess, timingSafeEqual };
