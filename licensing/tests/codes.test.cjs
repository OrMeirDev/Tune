// Serial format (LC08): 32 Crockford Base32 characters from a CSPRNG, grouped 8 x 4 for people,
// normalized forgivingly on the way in, and only ever stored as an HMAC plus a 4-character suffix.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const codes = require('../codes.cjs');

// Back from symbols to bytes: if every code decodes to exactly the bytes it came from, the
// packing loses no randomness and adds no bias.
function decode(code) {
  let value = 0;
  let bits = 0;
  const out = [];
  for (const ch of code) {
    value = (value << 5) | codes.ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; }
  }
  return Buffer.from(out);
}

test('a generated code: 32 symbols of the Crockford alphabet, shown as 8 groups of 4', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = codes.generate();
    assert.equal(code.length, 32);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{32}$/);
    assert.match(codes.format(code), /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    assert.equal(codes.normalize(code), code);
    assert.equal(codes.normalize(codes.format(code)), code);
    seen.add(code);
  }
  assert.equal(seen.size, 500);
});

test('the 160 random bits map one to one onto the 32 symbols', () => {
  assert.equal(codes.generate(() => Buffer.alloc(20, 0)), '0'.repeat(32));
  assert.equal(codes.generate(() => Buffer.alloc(20, 0xff)), 'Z'.repeat(32));
  for (let i = 0; i < 50; i++) {
    const bytes = crypto.randomBytes(20);
    assert.deepEqual(decode(codes.generate(() => bytes)), bytes);
  }
});

test('what people type: case, spaces and dashes are ignored; O, I and L read as 0 and 1', () => {
  const code = codes.ALPHABET; // 32 symbols: a valid code that contains both 0 and 1
  assert.equal(codes.normalize(code.toLowerCase()), code);
  assert.equal(codes.normalize(` ${codes.format(code).replace(/-/g, ' - ')} `), code);
  assert.equal(codes.normalize(`OI${code.slice(2)}`), code);
  assert.equal(codes.normalize(`ol${code.slice(2)}`), code);
  assert.equal(codes.normalize(`0L${code.slice(2)}`), code);
});

test('malformed input is not a code', () => {
  const code = codes.generate();
  for (const bad of ['', code.slice(1), `${code}0`, `U${code.slice(1)}`, `${code.slice(1)}!`, 'x'.repeat(1000), `${code.slice(0, 31)}é`]) {
    assert.equal(codes.normalize(bad), null, JSON.stringify(bad));
  }
  for (const bad of [undefined, null, 42, {}, [code]]) assert.equal(codes.normalize(bad), null);
});

test('only an HMAC and the last four characters are kept', () => {
  const code = codes.generate();
  const a = crypto.randomBytes(32);
  const b = crypto.randomBytes(32);
  assert.match(codes.hmac(a, code), /^[0-9a-f]{64}$/);
  assert.equal(codes.hmac(a, code), codes.hmac(a, codes.normalize(codes.format(code).toLowerCase())));
  assert.notEqual(codes.hmac(a, code), codes.hmac(b, code));
  assert.equal(codes.suffix(code), code.slice(28));
});

test('the log guard masks anything shaped like a code', () => {
  const code = codes.generate();
  const out = codes.redact(`a ${codes.format(code)} b ${code} c ${codes.format(code).toLowerCase().replace(/-/g, ' ')}`);
  assert.ok(!out.includes(code) && !out.includes(codes.format(code)) && !out.toUpperCase().includes(code.slice(0, 8)), out);
  assert.equal(codes.redact('requestId 0123abcd suffix WXYZ'), 'requestId 0123abcd suffix WXYZ');
});
