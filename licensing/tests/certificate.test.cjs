// The license certificate (LC09/LC11) as Tune's main process would check it offline: only the
// server's public key, this PC's machine id and its own device key.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sign, verify, canonical, FORMAT } = require('../certificate.cjs');
const { pc, T0, DAY, MINUTE } = require('./helpers.cjs');

const server = crypto.generateKeyPairSync('ed25519');
const impostor = crypto.generateKeyPairSync('ed25519');
const home = pc('home-pc');
const fields = {
  licenseId: 'lic_0123456789abcdef01234567', deviceId: 'dev_0123456789abcdef01234567',
  machineId: home.machineId, devicePublicKey: home.publicKey, planId: 'tune-pro',
  features: ['drivers', 'bios'], issuedAt: T0, expiresAt: T0 + 7 * DAY, policyVersion: 1,
};
const cert = sign(fields, server.privateKey);
const check = (c, opts = {}, key = server.publicKey) =>
  verify(c, key, { now: T0 + MINUTE, machineId: home.machineId, devicePublicKey: home.publicKey, ...opts });
const copy = (c) => JSON.parse(JSON.stringify(c));

test('a valid certificate verifies, also from PEM and after a JSON round trip with keys reordered', () => {
  assert.deepEqual(check(cert), { ok: true, reason: null, payload: { format: FORMAT, ...fields } });
  assert.equal(check(cert, {}, server.publicKey.export({ type: 'spki', format: 'pem' })).ok, true);
  const reordered = { signature: cert.signature, payload: Object.fromEntries(Object.entries(copy(cert).payload).reverse()) };
  assert.equal(check(reordered).ok, true);
  assert.equal(check(cert, { devicePublicKey: crypto.createPublicKey(home.privateKey) }).ok, true, 'the device key as a KeyObject');
});

test('a tampered payload or signature fails the signature check', () => {
  for (const change of [
    (p) => { p.features.push('everything'); },
    (p) => { p.expiresAt += 365 * DAY; },
    (p) => { p.planId = 'tune-pro-3'; },
    (p) => { p.machineId = pc('other').machineId; },
    (p) => { p.extra = true; },
  ]) {
    const c = copy(cert);
    change(c.payload);
    assert.equal(check(c).reason, 'signature');
  }
  const flipped = copy(cert);
  flipped.signature = (flipped.signature[0] === 'A' ? 'B' : 'A') + flipped.signature.slice(1);
  assert.equal(check(flipped).reason, 'signature');
  assert.equal(check({ ...cert, signature: cert.signature.slice(0, 40) }).reason, 'signature');
});

test('a certificate signed by any other key fails', () => {
  assert.equal(check(cert, {}, impostor.publicKey).reason, 'signature');
  assert.equal(check(sign(fields, impostor.privateKey)).reason, 'signature');
});

test('expiry: valid up to the last millisecond, then expired', () => {
  assert.equal(check(cert, { now: fields.expiresAt - 1 }).ok, true);
  assert.equal(check(cert, { now: fields.expiresAt }).reason, 'expired');
  assert.equal(check(cert, { now: fields.expiresAt + 30 * DAY }).reason, 'expired');
});

test('a certificate copied to another PC, or used with another device key, is refused', () => {
  const other = pc('other-pc');
  assert.equal(check(cert, { machineId: other.machineId }).reason, 'machine');
  assert.equal(check(cert, { devicePublicKey: other.publicKey }).reason, 'device');
  assert.equal(check(cert, { devicePublicKey: 'not a key' }).reason, 'device');
});

test('a clock rolled back before the issue time is caught (beyond the allowed skew)', () => {
  assert.equal(check(cert, { now: T0 - 4 * MINUTE }).ok, true, 'within the default 5-minute skew');
  assert.equal(check(cert, { now: T0 - 6 * MINUTE }).reason, 'clock');
  assert.equal(check(cert, { now: T0 - 30 * DAY }).reason, 'clock');
  assert.equal(check(cert, { now: T0 - 30_000, skewMs: 0 }).reason, 'clock');
});

test('malformed certificates are refused, and a check without this PC\'s identity is a bug', () => {
  for (const bad of [null, undefined, {}, 'cert', { payload: [], signature: '' }, { payload: fields }, { payload: fields, signature: 5 }]) {
    assert.equal(check(bad).reason, 'malformed');
  }
  const { policyVersion, ...missing } = fields;
  assert.equal(check(sign(missing, server.privateKey)).reason, 'malformed', 'signed, but not a whole certificate');
  assert.equal(check(sign({ ...fields, expiresAt: fields.issuedAt }, server.privateKey)).reason, 'malformed');
  assert.throws(() => verify(cert, server.publicKey, { now: T0 }), TypeError);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.equal(check(cert, {}, rsa.publicKey).reason, 'signature', 'only an Ed25519 server key is accepted');
});

test('canonical JSON: one byte sequence per value, nothing silently dropped', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x', { d: 2, c: 1 }] }), '{"a":[true,null,"x",{"c":1,"d":2}],"b":1}');
  assert.throws(() => canonical({ a: undefined }), TypeError);
  assert.throws(() => canonical({ a: NaN }), TypeError);
});
