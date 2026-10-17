'use strict';
// How a Serial is written: 32 Crockford Base32 characters, shown as 8 groups of 4. Ships in the app
// (to check what a person typed before anything is sent) and the licensing server PoC uses the same
// file, so both sides read a typed Serial the same way. Nothing here knows any secret.

// Crockford Base32: no I, L, O or U, so a code read aloud or retyped from paper survives.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 32;
const NORMALIZED = /^[0-9A-HJKMNP-TV-Z]{32}$/;

// What a person typed -> the canonical code, or null. Case, spaces and dashes don't matter, and the
// letters people confuse with digits map to them (O -> 0, I and L -> 1), as Crockford intends.
function normalize(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return NORMALIZED.test(s) ? s : null;
}

const format = (code) => code.match(/.{4}/g).join('-');
const suffix = (code) => code.slice(-4);

module.exports = { ALPHABET, LENGTH, normalize, format, suffix };
