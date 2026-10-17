'use strict';
// Serials (redemption codes): 32 Crockford Base32 characters from a CSPRNG, shown as 8 groups of 4.
// The server stores only HMAC-SHA256(secret, normalized code) and the last 4 characters (a suffix
// support can talk about); the full code never reaches the database, the events or the logs.
const crypto = require('node:crypto');

// How a Serial is written (alphabet, typing rules, groups) is shared with the app.
const { ALPHABET, LENGTH, normalize, format, suffix } = require('../electron/licensing/serial.cjs');

// 20 random bytes are exactly 160 bits = 32 symbols of 5 bits, so every symbol is uniform (no
// modulo bias). `random` is injectable only so a test can check the bit packing.
function generate(random = crypto.randomBytes) {
  const bytes = random(20);
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

const hmac = (secret, code) => crypto.createHmac('sha256', secret).update(code, 'ascii').digest('hex');

// Last line of defence for log output: anything shaped like a code (grouped or not) is masked.
// Nothing should ever pass a code to a logger; this catches the mistake if something does.
const GROUPED = /\b[0-9A-Z]{4}(?:[\s-][0-9A-Z]{4}){7}\b/gi;
const PLAIN = /\b[0-9A-Z]{32}\b/gi;
const redact = (text) => String(text).replace(GROUPED, '[code]').replace(PLAIN, '[code]');

module.exports = { ALPHABET, LENGTH, generate, normalize, format, hmac, suffix, redact };
