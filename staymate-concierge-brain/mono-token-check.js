'use strict';
// Read-only local credential scope check. Does not store or print the token.
// Run directly on FULLCHILL in PowerShell: node mono-token-check.js
const { checkMerchantToken } = require('./mono-acquiring');

async function verify(token) {
  try {
    const result = await checkMerchantToken(token);
    console.log('\nHTTP 200: merchant acquiring access confirmed.');
    console.log('Merchant:', result.merchantName || '(no name)');
    console.log('Merchant ID:', result.merchantId);
  } catch (error) {
    if (error.status === 403) {
      console.log('\nHTTP 403: this token is NOT valid for mono merchant acquiring API.');
    } else if (error.status) {
      console.log('\nHTTP ' + error.status + ': acquiring API declined the request.');
    } else {
      console.log('\nCould not verify acquiring token: ' + (error.code || error.name || 'network error'));
    }
    process.exitCode = 1;
  }
}

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.error('Run this script in the interactive PowerShell terminal on FULLCHILL.');
  process.exitCode = 1;
} else {
  process.stdout.write('Paste mono token (hidden) and press Enter: ');
  let token = '';
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', async (data) => {
    for (const char of data.toString('utf8')) {
      if (char === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        await verify(token.trim());
        token = '';
        return;
      }
      if (char === '\b' || char === '\u007f') {
        token = token.slice(0, -1);
      } else if (!/[\x00-\x1F]/.test(char)) {
        token += char;
      }
    }
  });
}
