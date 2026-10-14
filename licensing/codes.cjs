'use strict';
// Serials (redemption codes): 32 Crockford Base32 characters from a CSPRNG, shown as 8 groups of 4.
// The server stores only HMAC-SHA256(secret, normalized code) and the last 4 characters (a suffix
// support can talk about); the full code never reaches the database, the events or the logs.
const crypto = require('node:crypto');

// Crockford Base32: no I, L, O or U, so a code read aloud or retyped from paper survives.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 32;
const NORMALIZED = /^[0-9A-HJKMNP-TV-Z]{32}$/;

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

// What a person typed -> the canonical code, or null. Case, spaces and dashes don't matter, and the
// letters people confuse with digits map to them (O -> 0, I and L -> 1), as Crockford intends.
function normalize(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return NORMALIZED.test(s) ? s : null;
}

const format = (code) => code.match(/.{4}/g).join('-');
const hmac = (secret, code) => crypto.createHmac('sha256', secret).update(code, 'ascii').digest('hex');
const suffix = (code) => code.slice(-4);

// Last line of defence for log output: anything shaped like a code (grouped or not) is masked.
// Nothing should ever pass a code to a logger; this catches the mistake if something does.
const GROUPED = /\b[0-9A-Z]{4}(?:[\s-][0-9A-Z]{4}){7}\b/gi;
const PLAIN = /\b[0-9A-Z]{32}\b/gi;
const redact = (text) => String(text).replace(GROUPED, '[code]').replace(PLAIN, '[code]');

module.exports = { ALPHABET, LENGTH, generate, normalize, format, hmac, suffix, redact };
