// Redemption (LC01, LC04-LC08): a code grants exactly one license, once; retries are answered
// from the idempotency key but only for the same owner and device; failures say which failure and
// nothing about anyone else; refunds and re-delivery never bring a code back to 'ready'.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('../certificate.cjs');
const { setup, pc, idemKey, MINUTE, DAY } = require('./helpers.cjs');

test('redeeming a ready code: one license, one device, a certificate this PC accepts', (t) => {
  const env = setup(t);
  const { units: [unit] } = env.order();
  const alice = env.owner('alice@example.com');
  const home = pc('alice-home');
  const r = env.redeem(alice, unit.code, home);
  assert.equal(r.result, 'ok');
  assert.equal(r.planId, 'tune-pro');
  const check = verify(r.certificate, env.service.publicKey, { now: env.now(), machineId: home.machineId, devicePublicKey: home.publicKey });
  assert.equal(check.ok, true);
  assert.equal(check.payload.licenseId, r.licenseId);
  assert.equal(check.payload.deviceId, r.deviceId);
  assert.deepEqual(check.payload.features, ['drivers', 'bios', 'cleanup', 'startup', 'sensors']);
  assert.equal(check.payload.expiresAt, env.now() + 7 * DAY, 'default certificate TTL: 7 days');
  assert.equal(env.count('licenses'), 1);
  assert.equal(env.count('devices', "state = 'active'"), 1);
  assert.equal(env.count('codes', "state = 'redeemed'"), 1);
  assert.equal(env.count('delivery_boxes'), 0, 'the box is gone once the code is redeemed');
  assert.deepEqual(env.store.events('code.redeemed').map((e) => e.licenseId), [r.licenseId]);
});

test('the code can be typed in any case, with spaces, and with O/I/L for 0/1', (t) => {
  const env = setup(t);
  const { units: [unit] } = env.order();
  const typed = unit.code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  assert.equal(env.redeem(env.owner('bob@example.com'), typed, pc('bob')).result, 'ok');
});

test('a lost response: the retry with the same key, owner and device gets the same license (LC07)', (t) => {
  const env = setup(t);
  const { units: [unit] } = env.order();
  const alice = env.owner('alice@example.com');
  const home = pc('alice-home');
  const key = idemKey();
  const first = env.redeem(alice, unit.code, home, { key });
  const retry = env.redeem(alice, unit.code, home, { key });
  assert.equal(first.result, 'ok');
  assert.equal(retry.result, 'ok');
  assert.equal(retry.replayed, true);
  assert.equal(retry.licenseId, first.licenseId);
  assert.equal(retry.deviceId, first.deviceId);
  // A retry after the owner token was renewed (the client verified the email again) still matches.
  assert.equal(env.redeem(env.owner('alice@example.com'), unit.code.toLowerCase(), home, { key }).licenseId, first.licenseId);
  assert.equal(env.count('licenses'), 1);
  assert.equal(env.count('devices'), 1);
});

test('the same key from another owner or another device gets nothing (LC07)', (t) => {
  const env = setup(t);
  const { units: [unit, other] } = env.order({ quantity: 2 });
  const alice = env.owner('alice@example.com');
  const home = pc('alice-home');
  const key = idemKey();
  const first = env.redeem(alice, unit.code, home, { key });
  assert.equal(first.result, 'ok');

  const bob = env.owner('bob@example.com');
  const stolen = env.redeem(bob, unit.code, pc('bob'), { key });
  assert.deepEqual(stolen, { result: 'idempotency_conflict' });
  assert.deepEqual(env.redeem(bob, unit.code, home, { key }), { result: 'idempotency_conflict' }, 'even with alice\'s machine and device key');
  assert.deepEqual(env.redeem(alice, unit.code, pc('alice-laptop'), { key }), { result: 'idempotency_conflict' }, 'same owner, other device');
  assert.deepEqual(env.redeem(alice, other.code, home, { key }), { result: 'idempotency_conflict' }, 'same owner and device, other code');
  assert.equal(env.count('licenses'), 1);
  assert.equal(env.count('codes', "state = 'ready'"), 1, 'the other code was not touched');
});

test('malformed and unknown codes are invalid_code; a revoked code is refused (LC04)', (t) => {
  const env = setup(t);
  const { units: [unit] } = env.order();
  const alice = env.owner('alice@example.com');
  const home = pc('alice-home');
  const unknown = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789';
  for (const code of ['', 'hello', unit.code.slice(0, -1), `${unit.code}X`, unknown, 12345, null, undefined, { code: unit.code }]) {
    assert.deepEqual(env.redeem(alice, code, home), { result: 'invalid_code' }, JSON.stringify(code));
  }
  assert.equal(env.service.revokeUnit({ unitId: unit.unitId, reason: 'cancelled' }).codeState, 'revoked');
  assert.deepEqual(env.redeem(alice, unit.code, home), { result: 'code_revoked' });
  assert.equal(env.count('licenses'), 0);
});

test('a code someone else redeemed: already_redeemed, and nothing about them (LC04)', (t) => {
  const env = setup(t);
  const { units: [unit] } = env.order();
  const alice = env.owner('alice@example.com');
  const won = env.redeem(alice, unit.code, pc('alice-home'));
  const bob = env.owner('bob@example.com');
  const lost = env.redeem(bob, unit.code, pc('bob'));
  assert.deepEqual(lost, { result: 'already_redeemed' });
  const ownerId = env.sql().prepare('SELECT owner_id FROM licenses').get().owner_id;
  for (const secret of ['alice', won.licenseId, won.deviceId, ownerId]) assert.ok(!JSON.stringify(lost).includes(secret));
  // The owner typing it again (say, after a reinstall) is pointed at recovery instead.
  assert.deepEqual(env.redeem(env.owner('alice@example.com'), unit.code, pc('alice-home')), { result: 'already_redeemed', yours: true, licenseId: won.licenseId });
});

test('a direct sale belongs to its purchaser; a reseller code to the first verified owner (LC01)', (t) => {
  const env = setup(t);
  const direct = env.order({ channel: 'direct', purchaserEmail: 'Buyer@Example.com' }).units[0];
  assert.deepEqual(env.redeem(env.owner('bob@example.com'), direct.code, pc('bob')), { result: 'owner_mismatch' });
  assert.equal(env.count('codes', "state = 'ready'"), 1);
  assert.equal(env.redeem(env.owner(' buyer@EXAMPLE.com'), direct.code, pc('buyer')).result, 'ok');

  const resold = env.order({ channel: 'reseller' }).units[0];
  assert.equal(env.redeem(env.owner('carol@example.com'), resold.code, pc('carol')).result, 'ok');
  assert.deepEqual(env.redeem(env.owner('dave@example.com'), resold.code, pc('dave')), { result: 'already_redeemed' });

  assert.deepEqual(env.service.createOrder({ channel: 'direct', planId: 'tune-pro' }), { result: 'invalid_request' }, 'a direct sale needs the purchaser');
  assert.deepEqual(env.service.createOrder({ channel: 'reseller', planId: 'nope' }), { result: 'invalid_request', field: 'planId' });
});

test('an unverified owner cannot redeem', (t) => {
  const env = setup(t);
  const { units: [unit] } = env.order();
  const home = pc('home');
  for (const token of [undefined, '', 'x'.repeat(43), 'not a token']) assert.deepEqual(env.redeem(token, unit.code, home), { result: 'owner_unverified' });
  const alice = env.owner('alice@example.com');
  env.now.advance(31 * MINUTE);
  assert.deepEqual(env.redeem(alice, unit.code, home), { result: 'owner_unverified' }, 'owner tokens are short-lived');
  assert.equal(env.count('codes', "state = 'ready'"), 1);
});

test('owner email codes: hashed, single use, expiring, limited attempts', (t) => {
  const env = setup(t);
  const ask = () => env.service.challenge({ email: 'alice@example.com' });
  const codeFor = () => /\b(\d{6})\b/.exec(env.store.readOutbox('alice@example.com').at(-1).body)[1];
  const wrong = (c) => String((Number(c) + 1) % 1_000_000).padStart(6, '0');

  const c1 = ask();
  const code1 = codeFor();
  assert.equal(env.sql().prepare('SELECT COUNT(*) AS n FROM owner_challenges WHERE code_hash LIKE ?').get(`%${code1}%`).n, 0);
  assert.equal(env.service.verify({ challengeId: c1.challengeId, code: wrong(code1) }).result, 'owner_code_invalid');
  const ok = env.service.verify({ challengeId: c1.challengeId, code: code1 });
  assert.equal(ok.result, 'ok');
  assert.equal(env.count('owner_tokens', 'token_hash = ?', ok.ownerToken), 0, 'only the token\'s hash is stored');
  assert.equal(env.service.verify({ challengeId: c1.challengeId, code: code1 }).result, 'owner_code_invalid', 'single use');

  const c2 = ask();
  const code2 = codeFor();
  for (let i = 0; i < 5; i++) env.service.verify({ challengeId: c2.challengeId, code: wrong(code2) });
  assert.equal(env.service.verify({ challengeId: c2.challengeId, code: code2 }).result, 'too_many_attempts');

  const c3 = ask();
  const code3 = codeFor();
  env.now.advance(10 * MINUTE);
  assert.equal(env.service.verify({ challengeId: c3.challengeId, code: code3 }).result, 'owner_code_expired');

  // Five codes per email per window; a sixth would be mail bombing.
  ask(); ask();
  assert.equal(ask().result, 'rate_limited');
  assert.equal(env.service.challenge({ email: 'not an email' }).result, 'invalid_request');
});

test('repeated failures are rate limited, per address and per owner (LC05)', (t) => {
  const env = setup(t, { limits: { redeemPerAddress: { max: 5, windowMs: 15 * MINUTE }, redeemPerOwner: { max: 3, windowMs: 15 * MINUTE } } });
  const { units: [unit, second] } = env.order({ quantity: 2 });
  const guess = () => 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ';

  // One owner guessing from three addresses.
  const mallory = env.owner('mallory@example.com');
  for (const address of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
    assert.equal(env.redeem(mallory, guess(), pc('m'), { address }).result, 'invalid_code');
  }
  const blocked = env.redeem(mallory, unit.code, pc('m'), { address: '203.0.113.4' });
  assert.equal(blocked.result, 'rate_limited');
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 15 * 60);
  assert.equal(env.count('codes', "state = 'ready'"), 2, 'not even a valid code goes through while blocked');

  // Many owners guessing from one address (also counts requests with no valid owner).
  const address = '203.0.113.50';
  for (let i = 0; i < 4; i++) env.redeem(env.owner(`guesser${i}@example.com`), guess(), pc(`g${i}`), { address });
  assert.equal(env.redeem('bogus-token', unit.code, pc('g'), { address }).result, 'owner_unverified');
  assert.equal(env.redeem(env.owner('newcomer@example.com'), unit.code, pc('n'), { address }).result, 'rate_limited');

  // The window passes.
  env.now.advance(15 * MINUTE);
  assert.equal(env.redeem(env.owner('mallory@example.com'), unit.code, pc('m'), { address: '203.0.113.4' }).result, 'ok');
  assert.equal(env.redeem(env.owner('newcomer@example.com'), second.code, pc('n'), { address }).result, 'ok');
});

test('a refunded unit: its code is revoked for good and never ready again (LC06)', (t) => {
  const env = setup(t);
  const { units: [ready, redeemed] } = env.order({ quantity: 2, paymentId: 'pay_123' });
  const alice = env.owner('alice@example.com');
  assert.equal(env.redeem(alice, redeemed.code, pc('alice-home')).result, 'ok');

  assert.deepEqual(env.service.revokeUnit({ unitId: ready.unitId }), { result: 'ok', unitId: ready.unitId, codeState: 'revoked', licenseState: null });
  assert.deepEqual(env.redeem(alice, ready.code, pc('alice-home')), { result: 'code_revoked' });
  assert.deepEqual(env.service.redeliver({ unitId: ready.unitId }), { result: 'delivery_unavailable', reason: 'revoked' });
  assert.equal(env.service.revokeUnit({ unitId: ready.unitId }).codeState, 'revoked', 'a second refund changes nothing');

  // Refunding a redeemed unit revokes its license; the code itself stays 'redeemed'.
  assert.deepEqual(env.service.revokeUnit({ unitId: redeemed.unitId }), { result: 'ok', unitId: redeemed.unitId, codeState: 'redeemed', licenseState: 'revoked' });
  assert.deepEqual(env.recover(env.owner('alice@example.com'), pc('alice-home')), { result: 'license_inactive', status: 'revoked' });
  assert.equal(env.count('licenses'), 1);

  // Not even a direct write to the database brings a code back.
  const db = env.sql();
  assert.throws(() => db.exec("UPDATE codes SET state = 'ready'"), /never returns/);
  assert.throws(() => db.exec('DELETE FROM codes'), /never deleted/);
  assert.throws(() => db.exec("UPDATE licenses SET state = 'active'"), /stays revoked/);
  assert.throws(() => db.exec('DELETE FROM licenses'), /never deleted/);
  assert.throws(() => db.prepare('INSERT INTO licenses (id, code_id, owner_id, plan_id, state, created_at) SELECT ?, code_id, owner_id, plan_id, ?, 0 FROM licenses').run('lic_x', 'active'), /UNIQUE/);
  assert.deepEqual(db.prepare('SELECT state FROM codes ORDER BY state').all().map((r) => r.state), ['redeemed', 'revoked']);
  assert.ok(env.store.events('license.revoked').every((e) => e.paymentId === 'pay_123'), 'events carry the payment id');
});

test('re-delivery: the same code while the box lives, nothing after redemption or expiry', (t) => {
  const env = setup(t);
  const { units: [a, b, c] } = env.order({ quantity: 3 });
  assert.equal(env.service.redeliver({ unitId: a.unitId }).code, a.code);
  assert.equal(env.service.redeliver({ unitId: a.unitId }).code, a.code, 'again: still the same code, nothing new minted');
  assert.equal(env.count('codes'), 3);

  env.redeem(env.owner('alice@example.com'), a.code, pc('alice'));
  assert.deepEqual(env.service.redeliver({ unitId: a.unitId }), { result: 'delivery_unavailable', reason: 'redeemed' });

  // A box whose expiry was stretched in the database no longer opens (the expiry is authenticated).
  env.sql().prepare('UPDATE delivery_boxes SET expires_at = expires_at + 1 WHERE code_id = (SELECT id FROM codes WHERE order_unit_id = ?)').run(c.unitId);
  assert.deepEqual(env.service.redeliver({ unitId: c.unitId }), { result: 'delivery_unavailable', reason: 'unreadable' });

  env.now.advance(30 * DAY);
  assert.deepEqual(env.service.redeliver({ unitId: b.unitId }), { result: 'delivery_unavailable', reason: 'expired' });
  assert.equal(env.count('delivery_boxes', 'code_id = (SELECT id FROM codes WHERE order_unit_id = ?)', b.unitId), 0, 'an expired box is deleted');
  assert.equal(env.redeem(env.owner('bob@example.com'), b.code, pc('bob')).result, 'ok', 'the code itself still works');
  env.now.advance(MINUTE);
  env.service.purgeExpired();
  assert.equal(env.count('delivery_boxes'), 0, 'housekeeping drops the rest once expired');
});

test('issuing: N units give N codes once; a payment id cannot issue twice', (t) => {
  const env = setup(t);
  const o = env.order({ quantity: 4, paymentId: 'pay_abc' });
  assert.equal(o.units.length, 4);
  assert.equal(new Set(o.units.map((u) => u.code)).size, 4);
  for (const u of o.units) assert.equal(u.suffix, u.code.slice(-4));
  assert.deepEqual(env.service.createOrder({ channel: 'reseller', planId: 'tune-pro', quantity: 1, paymentId: 'pay_abc' }), { result: 'duplicate_payment', orderId: o.orderId });
  assert.equal(env.count('codes'), 4);
  assert.equal(env.service.createOrder({ channel: 'reseller', planId: 'tune-pro', quantity: 101 }).result, 'invalid_request');
});
