// After redemption the license is found by its owner, not by the code (LC09-LC11): a reinstall
// on the same PC gets the same license for its new key; another PC needs a free seat; refresh
// needs the device's private key, a fresh timestamp and a license still in force.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('../certificate.cjs');
const { signRequest } = require('../device.cjs');
const { setup, pc, reinstall, MINUTE, DAY } = require('./helpers.cjs');

const accepts = (env, r, machine) => verify(r.certificate, env.service.publicKey, { now: env.now(), machineId: machine.machineId, devicePublicKey: machine.publicKey });

function refreshAs(env, r, machine, { key = machine.privateKey, at = env.now(), body = {} } = {}) {
  const fields = { licenseId: r.licenseId, deviceId: r.deviceId, machineId: machine.machineId, ...body };
  return env.service.refresh({ ...fields, ...signRequest('refresh', fields, key, at) });
}

function redeemed(t, options) {
  const env = setup(t, options);
  const { units: [unit] } = env.order(options && options.planId ? { planId: options.planId } : {});
  const home = pc('alice-home');
  const first = env.redeem(env.owner('alice@example.com'), unit.code, home);
  assert.equal(first.result, 'ok');
  return { env, unit, home, first };
}

test('reinstall on the same PC: same license, a certificate for the new key, the old key retired', (t) => {
  const { env, home, first } = redeemed(t);
  const again = reinstall(home);
  const r = env.recover(env.owner('alice@example.com'), again);
  assert.equal(r.result, 'ok');
  assert.equal(r.licenseId, first.licenseId);
  assert.notEqual(r.deviceId, first.deviceId);
  assert.equal(accepts(env, r, again).ok, true);
  assert.equal(accepts(env, r, home).reason, 'device', 'bound to the new key, not the old one');
  assert.equal(env.count('licenses'), 1);
  assert.equal(env.count('codes', "state = 'redeemed'"), 1, 'the code is untouched');
  assert.equal(env.count('devices', "state = 'active'"), 1);
  env.now.advance(MINUTE);
  assert.deepEqual(refreshAs(env, first, home), { result: 'device_released' }, 'the old install can no longer refresh');
  assert.equal(refreshAs(env, r, again).result, 'ok');
  // Asking again with the same key is a no-op answer, not a new device.
  assert.equal(env.recover(env.owner('alice@example.com'), again).deviceId, r.deviceId);
});

test('another PC with a 1-device plan: device_limit until the owner releases the old one', (t) => {
  const { env, unit, home, first } = redeemed(t);
  const office = pc('alice-office');
  const alice = env.owner('alice@example.com');
  const refused = env.recover(alice, office);
  assert.equal(refused.result, 'device_limit');
  assert.equal(refused.deviceLimit, 1);
  assert.deepEqual(refused.devices.map((d) => d.deviceId), [first.deviceId], 'the owner sees their own devices to choose from');

  assert.deepEqual(env.service.releaseDevice({ ownerToken: env.owner('bob@example.com'), deviceId: first.deviceId }), { result: 'not_found' }, 'not bob\'s to release');
  assert.deepEqual(env.service.releaseDevice({ ownerToken: alice, deviceId: first.deviceId }), { result: 'ok', deviceId: first.deviceId });
  const moved = env.recover(alice, office);
  assert.equal(moved.result, 'ok');
  assert.equal(moved.licenseId, first.licenseId);
  assert.equal(accepts(env, moved, office).ok, true);
  assert.equal(env.count('licenses'), 1);
  assert.equal(env.count('codes', "state = 'redeemed'"), 1);
  assert.deepEqual(env.service.redeliver({ unitId: unit.unitId }), { result: 'delivery_unavailable', reason: 'redeemed' });

  // The old PC, offline, keeps its certificate until it expires: the TTL is the trade-off.
  assert.equal(accepts(env, first, home).ok, true);
  env.now.advance(7 * DAY);
  assert.equal(accepts(env, first, home).reason, 'expired');
  assert.deepEqual(refreshAs(env, first, home), { result: 'device_released' });
  assert.equal(env.recover(alice, home).result, 'owner_unverified', 'the owner token has long expired');
  assert.equal(env.recover(env.owner('alice@example.com'), home).result, 'device_limit', 'and the seat is taken');
});

test('a 3-device plan seats three PCs; the owner picks the license when they hold several', (t) => {
  const env = setup(t);
  const family = env.order({ planId: 'tune-pro-3' }).units[0];
  const alice = env.owner('alice@example.com');
  const r1 = env.redeem(alice, family.code, pc('pc1'));
  assert.equal(env.recover(alice, pc('pc2')).licenseId, r1.licenseId);
  assert.equal(env.recover(alice, pc('pc3')).licenseId, r1.licenseId);
  assert.equal(env.recover(alice, pc('pc4')).result, 'device_limit');

  const single = env.order().units[0];
  const r2 = env.redeem(alice, single.code, pc('pc4'));
  const choose = env.recover(alice, pc('pc5'));
  assert.equal(choose.result, 'license_required');
  assert.deepEqual(choose.licenses.map((l) => [l.licenseId, l.codeSuffix]).sort(), [[r1.licenseId, family.suffix], [r2.licenseId, single.suffix]].sort());
  assert.equal(env.recover(alice, reinstall(pc('pc2'))).licenseId, r1.licenseId, 'a known PC finds its own license without being told');
  assert.deepEqual(env.recover(env.owner('bob@example.com'), pc('bob'), { licenseId: r1.licenseId }), { result: 'not_found' }, 'not bob\'s license');
  assert.deepEqual(env.recover(env.owner('carol@example.com'), pc('carol')), { result: 'not_found' });
});

test('refresh: signed by the device key works; unsigned, wrongly signed, stale or replayed does not', (t) => {
  const { env, home, first } = redeemed(t);
  env.now.advance(3 * DAY);
  const r = refreshAs(env, first, home);
  assert.equal(r.result, 'ok');
  assert.equal(r.certificate.payload.expiresAt, env.now() + 7 * DAY);
  assert.equal(accepts(env, r, home).ok, true);

  const fields = { licenseId: first.licenseId, deviceId: first.deviceId, machineId: home.machineId };
  assert.deepEqual(env.service.refresh(fields), { result: 'bad_signature' }, 'unsigned');
  assert.deepEqual(env.service.refresh({ ...fields, ts: env.now(), signature: '' }), { result: 'bad_signature' });
  // Someone holding a copy of the certificate, with their own key.
  assert.deepEqual(refreshAs(env, first, home, { key: pc('thief').privateKey }), { result: 'bad_signature' });
  // A signature over other fields.
  const signed = signRequest('refresh', fields, home.privateKey, env.now() + 1);
  assert.deepEqual(env.service.refresh({ ...fields, deviceId: 'dev_000000000000000000000000', ...signed }), { result: 'bad_signature' });
  assert.deepEqual(env.service.refresh({ ...fields, ...signRequest('release', fields, home.privateKey, env.now() + 1) }), { result: 'bad_signature' }, 'signed for another action');
  // Stale, from the future, or a replay of one already used.
  assert.deepEqual(refreshAs(env, first, home, { at: env.now() - 6 * MINUTE }), { result: 'stale_request' });
  assert.deepEqual(refreshAs(env, first, home, { at: env.now() + 6 * MINUTE }), { result: 'stale_request' });
  env.now.advance(1000);
  const once = { ...fields, ...signRequest('refresh', fields, home.privateKey, env.now()) };
  assert.equal(env.service.refresh(once).result, 'ok');
  assert.deepEqual(env.service.refresh(once), { result: 'stale_request' }, 'replayed');
  // The device key copied to another PC (which reports its own machine id).
  env.now.advance(1000);
  assert.deepEqual(refreshAs(env, first, home, { body: { machineId: pc('elsewhere').machineId } }), { result: 'machine_mismatch' });
});

test('refresh of a revoked or expired license is refused; certificates never outlive the license', (t) => {
  const { env, home, first } = redeemed(t);
  env.now.advance(360 * DAY);
  const late = refreshAs(env, first, home);
  assert.equal(late.result, 'ok');
  assert.equal(late.certificate.payload.expiresAt, late.licenseExpiresAt, 'capped at the license end, 5 days away');
  env.now.advance(5 * DAY);
  assert.deepEqual(refreshAs(env, first, home), { result: 'license_inactive', status: 'expired' });

  const other = redeemed(t);
  other.env.now.advance(MINUTE);
  other.env.service.revokeUnit({ unitId: other.unit.unitId, reason: 'chargeback' });
  assert.deepEqual(refreshAs(other.env, other.first, other.home), { result: 'license_inactive', status: 'revoked' });
});
