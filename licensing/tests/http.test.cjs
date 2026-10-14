// The HTTP API end to end, and the rule that the full code exists only on the customer's side
// (LC08): after issuing, redeeming, failing, re-sending and refunding, no table, no database
// byte and no log line holds a code, while the log still carries the suffix for support.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('../server.cjs');
const { verify } = require('../certificate.cjs');
const { signRequest } = require('../device.cjs');
const codes = require('../codes.cjs');
const { setup, pc, idemKey } = require('./helpers.cjs');

async function serve(t, options) {
  const env = setup(t, options);
  const log = [];
  const srv = await start({ service: env.service, adminToken: env.keys.adminToken, log: (line) => log.push(line) });
  env.defer(() => srv.close());
  const call = async (route, body, headers = {}) => {
    const res = await fetch(`${srv.url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const admin = (route, body) => call(route, body, { authorization: `Bearer ${env.keys.adminToken}` });
  // The email step over HTTP; the "mailbox" is the outbox table.
  const ownerToken = async (email) => {
    const c = await call('/v1/owner/challenge', { email });
    const code = /\b(\d{6})\b/.exec(env.store.readOutbox(email).at(-1).body)[1];
    return (await call('/v1/owner/verify', { challengeId: c.body.challengeId, code })).body.ownerToken;
  };
  return { env, srv, log, call, admin, ownerToken };
}

test('admin routes need the admin token', async (t) => {
  const { call, admin, ownerToken } = await serve(t);
  const order = { channel: 'reseller', planId: 'tune-pro', quantity: 1 };
  assert.deepEqual(await call('/v1/admin/orders', order), { status: 401, body: { result: 'unauthorized' } });
  assert.deepEqual(await call('/v1/admin/orders', order, { authorization: 'Bearer wrong' }), { status: 401, body: { result: 'unauthorized' } });
  assert.equal((await call('/v1/admin/orders', order, { authorization: `Bearer ${await ownerToken('alice@example.com')}` })).status, 401, 'an owner token is not an admin token');
  assert.equal((await call('/v1/admin/redeliver', { unitId: 'unit_000000000000000000000000' })).status, 401);
  assert.equal((await call('/v1/admin/revoke', { unitId: 'unit_000000000000000000000000' })).status, 401);
  assert.equal((await admin('/v1/admin/orders', order)).status, 200);
});

test('the API end to end: issue, verify, redeem, lost response, recover, refresh, release', async (t) => {
  const { env, call, admin, ownerToken } = await serve(t);
  const issued = await admin('/v1/admin/orders', { channel: 'direct', purchaserEmail: 'alice@example.com', planId: 'tune-pro', quantity: 1, paymentId: 'pay_1' });
  assert.equal(issued.status, 200);
  const [unit] = issued.body.units;
  assert.equal((await admin('/v1/admin/redeliver', { unitId: unit.unitId })).body.code, unit.code);

  const alice = await ownerToken('alice@example.com');
  const home = pc('alice-home');
  const request = { code: unit.code, ownerToken: alice, machineId: home.machineId, devicePublicKey: home.publicKey, idempotencyKey: idemKey() };
  const first = await call('/v1/redeem', request);
  assert.equal(first.status, 200);
  assert.equal(verify(first.body.certificate, env.service.publicKey, { now: env.now(), machineId: home.machineId, devicePublicKey: home.publicKey }).ok, true);
  const retry = await call('/v1/redeem', request);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.licenseId, first.body.licenseId);

  const bob = await ownerToken('bob@example.com');
  assert.deepEqual(await call('/v1/redeem', { ...request, ownerToken: bob }), { status: 409, body: { result: 'idempotency_conflict' } });
  assert.deepEqual(await call('/v1/redeem', { ...request, ownerToken: bob, idempotencyKey: idemKey() }), { status: 409, body: { result: 'already_redeemed' } });
  assert.deepEqual(await call('/v1/redeem', { ...request, code: 'nope', idempotencyKey: idemKey() }), { status: 404, body: { result: 'invalid_code' } });
  assert.deepEqual(await call('/v1/redeem', { ...request, ownerToken: 'x' }), { status: 401, body: { result: 'owner_unverified' } });
  assert.deepEqual(await admin('/v1/admin/redeliver', { unitId: unit.unitId }), { status: 410, body: { result: 'delivery_unavailable', reason: 'redeemed' } });

  const office = pc('alice-office');
  const limited = await call('/v1/recover', { ownerToken: alice, machineId: office.machineId, devicePublicKey: office.publicKey });
  assert.equal(limited.status, 409);
  assert.equal(limited.body.result, 'device_limit');
  assert.deepEqual(await call('/v1/device/release', { ownerToken: alice, deviceId: first.body.deviceId }), { status: 200, body: { result: 'ok', deviceId: first.body.deviceId } });
  const moved = await call('/v1/recover', { ownerToken: alice, machineId: office.machineId, devicePublicKey: office.publicKey });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.licenseId, first.body.licenseId);

  const fields = { licenseId: moved.body.licenseId, deviceId: moved.body.deviceId, machineId: office.machineId };
  const refreshed = await call('/v1/license/refresh', { ...fields, ...signRequest('refresh', fields, office.privateKey, env.now()) });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.result, 'ok');
  assert.deepEqual(await call('/v1/license/refresh', fields), { status: 401, body: { result: 'bad_signature' } });

  assert.deepEqual(await admin('/v1/admin/revoke', { unitId: unit.unitId, reason: 'refund' }), { status: 200, body: { result: 'ok', unitId: unit.unitId, codeState: 'redeemed', licenseState: 'revoked' } });
  env.now.advance(1000);
  assert.deepEqual(await call('/v1/license/refresh', { ...fields, ...signRequest('refresh', fields, office.privateKey, env.now()) }), { status: 409, body: { result: 'license_inactive', status: 'revoked' } });
});

test('requests the API does not take', async (t) => {
  const { srv, call } = await serve(t);
  assert.deepEqual(await call('/v1/nothing', {}), { status: 404, body: { result: 'not_found' } });
  const get = await fetch(`${srv.url}/v1/redeem`);
  assert.equal(get.status, 405);
  assert.deepEqual(await call('/v1/redeem', '{"code": "broken'), { status: 400, body: { result: 'invalid_request' } });
  assert.deepEqual(await call('/v1/redeem', '[1, 2]'), { status: 400, body: { result: 'invalid_request' } });
  assert.deepEqual(await call('/v1/redeem', 'null'), { status: 400, body: { result: 'invalid_request' } });
  const big = await call('/v1/redeem', { code: 'x'.repeat(20_000) });
  assert.deepEqual(big, { status: 413, body: { result: 'payload_too_large' } });
});

test('no table, database byte or log line ever holds a code', async (t) => {
  const { env, log, call, admin, ownerToken } = await serve(t);
  const { body: { units } } = await admin('/v1/admin/orders', { channel: 'reseller', planId: 'tune-pro', quantity: 4, paymentId: 'pay_secret_test' });
  const [redeemed, failed, resent, refunded] = units;
  const alice = await ownerToken('alice@example.com');
  const bob = await ownerToken('bob@example.com');
  const home = pc('alice-home');
  const redeem = (code, token = alice, machine = home) =>
    call('/v1/redeem', { code, ownerToken: token, machineId: machine.machineId, devicePublicKey: machine.publicKey, idempotencyKey: idemKey() });

  assert.equal((await redeem(redeemed.code.toLowerCase().replace(/-/g, ' '))).body.result, 'ok');
  assert.equal((await redeem(redeemed.code, bob, pc('bob'))).body.result, 'already_redeemed');
  assert.equal((await redeem(redeemed.code, 'bad-token')).body.result, 'owner_unverified');
  assert.equal((await redeem(`${failed.code}X`)).body.result, 'invalid_code');
  await call('/v1/redeem', `{"code": "${failed.code}", "broken`); // the parser would quote this
  assert.equal((await admin('/v1/admin/redeliver', { unitId: resent.unitId })).body.code, resent.code);
  assert.equal((await admin('/v1/admin/revoke', { unitId: refunded.unitId })).body.codeState, 'revoked');
  assert.equal((await redeem(refunded.code)).body.result, 'code_revoked');

  // Every way a code could be written down.
  const forms = units.flatMap((u) => {
    const n = codes.normalize(u.code);
    return [n, u.code, n.toLowerCase(), u.code.toLowerCase(), n.slice(0, 16), n.slice(16)];
  });
  const missing = (haystack, where) => { for (const f of forms) assert.ok(!haystack.includes(f), `${where} contains a code (${f.slice(0, 4)}...)`); };

  // 1. every row of every table
  const db = env.sql();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tables.includes('events') && tables.includes('delivery_boxes') && tables.includes('outbox'));
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    const text = JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
    missing(text, `table ${table}`);
    missing(text.toUpperCase(), `table ${table}`);
  }
  // 2. the raw database files (main file and write-ahead log)
  for (const f of fs.readdirSync(env.dir).filter((n) => n.startsWith('licensing.sqlite'))) {
    missing(fs.readFileSync(path.join(env.dir, f)).toString('latin1'), `file ${f}`);
  }
  // 3. the server log, which does carry the suffixes
  const text = log.join('\n');
  missing(text, 'the log');
  missing(text.toUpperCase(), 'the log');
  const redeemLines = log.map((l) => JSON.parse(l)).filter((l) => l.path === '/v1/redeem');
  assert.ok(redeemLines.some((l) => l.codeSuffix === redeemed.suffix), 'redeem lines name the suffix');
  assert.ok(redeemLines.every((l) => !('body' in l)));
  // The audit log has what support needs: ids, payment id, state changes, suffixes.
  const issuedEvents = env.store.events('code.issued');
  assert.equal(issuedEvents.length, 4);
  assert.ok(issuedEvents.every((e) => e.paymentId === 'pay_secret_test' && e.codeId && JSON.parse(e.detail).suffix.length === 4));
  assert.ok(env.store.events('redeem.refused').length >= 2);
});
