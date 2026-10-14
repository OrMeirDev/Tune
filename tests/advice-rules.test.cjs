// The 13th–14th gen Intel microcode rule (audit TUN-04): affected desktop chips need 0x12F or later.
const test = require('node:test');
const assert = require('node:assert/strict');
const { microcodeAdvice, MICROCODE_RULE } = require('../electron/advice-rules.cjs');

const K14 = 'Intel(R) Core(TM) i7-14700K';
const K13 = 'Intel(R) Core(TM) i9-13900K';

test('0x12B, the earlier fix, is no longer enough', () => {
  assert.equal(microcodeAdvice({ cpu: K13, rev: 0x12B }).ok, false);
});

test('0x12F and later revisions are fine', () => {
  assert.equal(microcodeAdvice({ cpu: K13, rev: 0x12F }).ok, true);
  assert.equal(microcodeAdvice({ cpu: K14, rev: 0x133 }).ok, true);
  assert.equal(microcodeAdvice({ cpu: K14, rev: 0x133 }).hex, '0x133');
});

test('an unreadable revision gives no finding rather than "fine"', () => {
  for (const rev of [null, undefined, '', 'abc', 0]) assert.equal(microcodeAdvice({ cpu: K14, rev }), null);
});

test('chips outside the affected family get no finding', () => {
  assert.equal(microcodeAdvice({ cpu: 'Intel(R) Core(TM) i7-12700K', rev: 0x20 }), null);
  assert.equal(microcodeAdvice({ cpu: 'AMD Ryzen 7 7800X3D 8-Core Processor', rev: 0xA601203 }), null);
  assert.equal(microcodeAdvice({ cpu: 'Intel(R) Core(TM) i7-13700H', rev: 0x4121 }), null);
  assert.equal(microcodeAdvice({ cpu: K14, rev: 0x100, laptop: true }), null);
});

test('the rule keeps its source and review date', () => {
  assert.match(MICROCODE_RULE.source, /^https:\/\/www\.intel\.com\//);
  assert.match(MICROCODE_RULE.reviewed, /^\d{4}-\d{2}-\d{2}$/);
});
