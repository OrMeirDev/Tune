// The licence's words (plan L02): every outcome and licence state the main-process client can
// produce has a message in English and Hebrew, so the window never shows a raw key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every outcome and licence state the client can produce has words in English and Hebrew', async () => {
  const { STRINGS } = await import('../src/i18n.js');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'electron', 'licensing', f), 'utf8');
  const client = src('client.cjs');
  const results = new Set([...client.matchAll(/result: '([a-zA-Z]+)'/g)].map((m) => m[1]));
  // the server's refusals as the client names them
  for (const m of client.matchAll(/: '([a-zA-Z]+)'[,\s]/g)) if (/^[a-z][a-zA-Z]+$/.test(m[1])) results.add(m[1]);
  for (const r of ['alreadyYours', 'alreadyRedeemed', 'ownerExpired', 'licenseRevoked', 'licenseExpired', 'chooseLicense', 'unavailable']) results.add(r);
  const states = new Set([...src('license-state.cjs').matchAll(/state: '([a-zA-Z]+)'/g)].map((m) => m[1]));
  for (const s of ['clock', 'expired', 'otherMachine', 'invalid']) states.add(s);
  // names that are other fields, not results
  for (const notResult of ['activate', 'recover', 'refresh', 'retry', 'reset', 'ownerStart', 'ownerConfirm', 'email', 'code', 'ready', 'ok', 'revoked', 'expired', 'active', 'challenge', 'verify', 'redeem', 'unreadable', 'failed', 'unavailable']) results.delete(notResult);
  results.add('failed'); results.add('unavailable');
  for (const lang of ['en', 'he']) {
    for (const r of results) assert.ok(STRINGS[lang][`lic.o.${r}`], `${lang}: lic.o.${r}`);
    for (const s of states) assert.ok(STRINGS[lang][`lic.s.${s}`], `${lang}: lic.s.${s}`);
  }
});
