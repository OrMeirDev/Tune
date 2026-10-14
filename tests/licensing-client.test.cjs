// L02: Tune's own licensing client (electron/licensing/) against the licensing server PoC
// (licensing/) over real HTTP on this PC, with a throwaway profile folder, test data, and one clock
// the test moves for both sides. Storage uses an in-memory stand-in for DPAPI: these tests prove
// what the client does with protected storage (never plaintext, failures handled), not DPAPI itself
// (that is a Windows check: docs/roadmap/README.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { setup, clock, pc, reinstall, MINUTE, DAY } = require('../licensing/tests/helpers.cjs');
const { start } = require('../licensing/server.cjs');
const { createApi } = require('../electron/licensing/api.cjs');
const { createLicensingClient } = require('../electron/licensing/client.cjs');
const { createProtectedStore, MAGIC } = require('../electron/licensing/protected-store.cjs');
const { createEntitlements } = require('../electron/licensing/entitlements.cjs');
const { licensingConfig, serverUrl } = require('../electron/licensing/config.cjs');

// A stand-in for DPAPI: reversible, switchable off, and able to fail a write like a full disk.
function fakeCrypt() {
  const c = { kind: 'dpapi', on: true, failWrites: false };
  c.available = () => c.on;
  c.encrypt = (s) => { if (c.failWrites) throw new Error('disk full'); return Buffer.from(Buffer.from(s, 'utf8').map((x) => x ^ 0x33)); };
  c.decrypt = (b) => Buffer.from(b.map((x) => x ^ 0x33)).toString('utf8');
  return c;
}

// The licensing server on a loopback port, and what a test needs to drive it.
async function server(t, opts = {}) {
  const now = opts.now || clock();
  const env = setup(t, { now });
  const http0 = await start({ service: env.service, adminToken: env.keys.adminToken, log: () => {} });
  t.after(() => http0.close());
  // the customer reads the 6-digit code from their mail (the PoC's outbox)
  const mailCode = (email) => /\b(\d{6})\b/.exec(env.store.readOutbox(email).at(-1).body)[1];
  return { ...env, url: http0.url, now, mailCode, publicKey: crypto.createPublicKey(env.service.publicKey) };
}

// Tune on one PC: a profile folder, its machine id, its protected storage.
function tune(t, srv, { machine = pc('pc-a'), dir, crypt = fakeCrypt(), fetch = globalThis.fetch, timeoutMs = 3000, now = srv.now } = {}) {
  const profile = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'tune-profile-'));
  if (!dir) t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const config = { url: srv.url, publicKey: srv.publicKey, problem: null, development: true };
  const store = createProtectedStore({ file: path.join(profile, 'license.bin'), crypt });
  const client = createLicensingClient({ config, api: createApi({ baseUrl: srv.url, fetch, timeoutMs }), store, machineId: async () => ({ ok: true, machineId: machine.machineId }), now });
  return { client, profile, crypt, machine, file: path.join(profile, 'license.bin') };
}

// Owner verification the way a customer does it: email, then the code from the mail.
async function verifiedOwner(srv, app, email = 'owner@example.com') {
  assert.equal((await app.client.startOwner(email)).data.outcome.result, 'codeSent');
  const r = await app.client.confirmOwner(srv.mailCode(email));
  assert.equal(r.data.outcome.result, 'ownerVerified');
  return r;
}

const code = (srv, opts) => srv.order(opts).units[0].code;
const outcome = (r) => r.data.outcome.result;

test('activation: verified owner, a Serial, a licence stored only under protection', async (t) => {
  const srv = await server(t);
  const app = tune(t, srv);
  const serial = code(srv);
  // no activation before the owner is verified, and nothing is sent
  assert.equal(outcome(await app.client.activate(serial)), 'ownerUnverified');
  assert.equal(srv.count('devices'), 0);

  await verifiedOwner(srv, app);
  const r = await app.client.activate(serial.toLowerCase().replace(/-/g, ' '));
  assert.equal(outcome(r), 'activated');
  const lic = r.data.license;
  assert.equal(lic.state, 'active');
  assert.equal(lic.planId, 'tune-pro');
  assert.deepEqual(lic.features, ['drivers', 'bios', 'cleanup', 'startup', 'sensors']);
  assert.equal(lic.lastCheckAt, srv.now());
  assert.equal(lic.certificateExpiresAt, srv.now() + 7 * DAY, 'the PoC default: a 7-day certificate');
  assert.equal(r.data.busy, false);

  // the summary for the window carries no token, key or certificate
  const text = JSON.stringify(r.data);
  for (const secret of ['ownerToken', 'PRIVATE KEY', 'signature', 'certificate"', 'idempotencyKey']) assert.ok(!text.includes(secret), secret);
  // the file holds no readable key or certificate
  const bytes = fs.readFileSync(app.file);
  assert.ok(bytes.subarray(0, MAGIC.length).equals(MAGIC));
  for (const plain of ['PRIVATE KEY', 'tune-license/1', 'licenseId']) assert.ok(!bytes.includes(Buffer.from(plain)), plain);
  assert.equal(srv.count('licenses'), 1);
  assert.equal(srv.count('devices', "state = 'active'"), 1);
});

test('ownership: a wrong mail code, a direct sale for someone else, a Serial someone else redeemed', async (t) => {
  const srv = await server(t);
  const app = tune(t, srv);
  await app.client.startOwner('owner@example.com');
  const wrong = await app.client.confirmOwner(srv.mailCode('owner@example.com') === '000000' ? '111111' : '000000');
  assert.deepEqual([outcome(wrong), wrong.data.outcome.attemptsLeft, wrong.data.flow.step], ['ownerCodeInvalid', 4, 'code']);
  assert.equal(outcome(await app.client.confirmOwner(srv.mailCode('owner@example.com'))), 'ownerVerified');

  // a direct sale belongs to its purchaser
  const theirs = code(srv, { channel: 'direct', purchaserEmail: 'buyer@example.com' });
  assert.equal(outcome(await app.client.activate(theirs)), 'ownerMismatch');

  // redeemed by someone else: said plainly, and nothing about them is shown
  const other = tune(t, srv, { machine: pc('pc-other') });
  await verifiedOwner(srv, other, 'someone@example.net');
  const taken = code(srv);
  assert.equal(outcome(await other.client.activate(taken)), 'activated');
  const r = await app.client.activate(taken);
  assert.equal(outcome(r), 'alreadyRedeemed');
  assert.ok(!JSON.stringify(r.data).includes('someone@example.net'));
  assert.ok(!JSON.stringify(r.data).includes('lic_'), 'not even their licence id');
  // a typo never reaches the server
  assert.equal(outcome(await app.client.activate('not a serial')), 'invalidCode');
});

test('a lost answer: the retry is the same request and gets the licence the server already made', async (t) => {
  const srv = await server(t);
  // the network drops the first redeem answer after the server carried it out
  let drop = 1;
  const flaky = async (url, init) => {
    const res = await fetch(url, init);
    if (url.endsWith('/v1/redeem') && drop-- > 0) { await res.text(); throw new TypeError('fetch failed'); }
    return res;
  };
  const sent = [];
  const watching = async (url, init) => { if (url.endsWith('/v1/redeem')) sent.push(JSON.parse(init.body)); return flaky(url, init); };
  const app = tune(t, srv, { fetch: watching });
  await verifiedOwner(srv, app);
  const serial = code(srv);
  const first = await app.client.activate(serial);
  assert.deepEqual([outcome(first), first.data.outcome.retryable, first.data.canRetry, first.data.busy], ['unavailable', true, true, false]);
  assert.equal(srv.count('licenses'), 1, 'the server did redeem it');

  const again = await app.client.retry();
  assert.equal(outcome(again), 'activated');
  assert.equal(again.data.license.state, 'active');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], 'the same request: same Serial, owner, device key and idempotency key');
  assert.equal(srv.count('licenses'), 1);
  assert.equal(srv.count('devices'), 1);
  assert.equal(again.data.canRetry, false);

  // typing the same Serial again after no answer is the same request too
  drop = 1;
  const app2 = tune(t, srv, { machine: pc('pc-b'), fetch: watching });
  await verifiedOwner(srv, app2, 'second@example.com');
  const s2 = code(srv);
  assert.equal(outcome(await app2.client.activate(s2)), 'unavailable');
  assert.equal(outcome(await app2.client.activate(s2)), 'activated');
  assert.equal(sent.at(-1).idempotencyKey, sent.at(-2).idempotencyKey);
});

test('reinstall on the same PC: the same licence comes back; nothing new is redeemed', async (t) => {
  const srv = await server(t);
  const machine = pc('pc-a');
  const first = tune(t, srv, { machine });
  await verifiedOwner(srv, first);
  const licenseId = srv.sql().prepare('SELECT id FROM licenses').get()?.id;
  assert.equal(licenseId, undefined);
  assert.equal(outcome(await first.client.activate(code(srv))), 'activated');
  const before = srv.sql().prepare('SELECT id FROM licenses').get().id;

  // a new install: a new profile, so a new device key; same PC
  const again = tune(t, srv, { machine: reinstall(machine) });
  assert.equal((await again.client.status()).data.license.state, 'none');
  await verifiedOwner(srv, again);
  const r = await again.client.recover();
  assert.equal(outcome(r), 'recovered');
  assert.equal(r.data.license.state, 'active');
  assert.equal(srv.count('licenses'), 1, 'no second licence');
  assert.equal(srv.count('codes', "state = 'redeemed'"), 1);
  assert.equal(srv.sql().prepare("SELECT license_id AS l FROM devices WHERE state = 'active'").get().l, before);
  assert.equal(srv.count('devices', "state = 'active'"), 1, 'the old install was replaced, not added');
});

test('another PC: the device limit is reported; nothing is released, redeemed or bought', async (t) => {
  const srv = await server(t);
  const home = tune(t, srv, { machine: pc('home') });
  await verifiedOwner(srv, home);
  assert.equal(outcome(await home.client.activate(code(srv))), 'activated');
  const laptop = tune(t, srv, { machine: pc('laptop') });
  await verifiedOwner(srv, laptop);
  const r = await laptop.client.recover();
  assert.deepEqual([outcome(r), r.data.outcome.deviceLimit], ['deviceLimit', 1]);
  assert.equal(r.data.license.state, 'none');
  assert.equal(srv.count('devices', "state = 'active'"), 1, 'the other PC keeps its seat');
  assert.equal(srv.count('devices', "state = 'released'"), 0);
  assert.equal(srv.count('licenses'), 1);
  assert.equal(srv.count('codes', "state = 'ready'"), 0);
  // the first PC still works
  assert.equal(outcome(await home.client.refresh()), 'refreshed');
});

test('an owner with several licences chooses one; only ids the server listed are accepted', async (t) => {
  const srv = await server(t);
  const a = tune(t, srv, { machine: pc('one') });
  await verifiedOwner(srv, a);
  await a.client.activate(code(srv));
  const b = tune(t, srv, { machine: pc('two') });
  await verifiedOwner(srv, b);
  await b.client.activate(code(srv, { planId: 'tune-pro-3' }));
  const c = tune(t, srv, { machine: pc('three') });
  await verifiedOwner(srv, c);
  const r = await c.client.recover();
  assert.equal(outcome(r), 'chooseLicense');
  assert.equal(r.data.flow.choices.length, 2);
  assert.equal(outcome(await c.client.recover('lic_000000000000000000000000')), 'invalidRequest');
  const three = r.data.flow.choices.find((x) => x.planId === 'tune-pro-3');
  assert.equal(outcome(await c.client.recover(three.licenseId)), 'recovered');
});

test('a stored certificate is checked again on every load: altered, copied or for another key', async (t) => {
  const srv = await server(t);
  const app = tune(t, srv);
  await verifiedOwner(srv, app);
  await app.client.activate(code(srv));
  const raw = fs.readFileSync(app.file);
  const data = JSON.parse(app.crypt.decrypt(raw.subarray(MAGIC.length)));
  const rewrite = (d) => fs.writeFileSync(app.file, Buffer.concat([MAGIC, app.crypt.encrypt(JSON.stringify(d))]));
  const reload = async (machine = app.machine) => (await tune(t, srv, { dir: app.profile, crypt: app.crypt, machine }).client.status()).data.license;

  // more features than were signed
  rewrite({ ...data, license: { ...data.license, certificate: { ...data.license.certificate, payload: { ...data.license.certificate.payload, features: ['everything'] } } } });
  assert.equal((await reload()).state, 'invalid');
  // a later expiry than was signed
  rewrite({ ...data, license: { ...data.license, certificate: { ...data.license.certificate, payload: { ...data.license.certificate.payload, expiresAt: srv.now() + 999 * DAY } } } });
  assert.equal((await reload()).state, 'invalid');
  // another install's key with this certificate
  rewrite({ ...data, device: { ...data.device, ...(() => { const k = crypto.generateKeyPairSync('ed25519'); return { privateKey: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; })() } });
  assert.equal((await reload()).state, 'invalid');
  // the profile copied to another PC
  rewrite(data);
  assert.equal((await reload(pc('elsewhere'))).state, 'otherMachine');
  assert.equal((await reload()).state, 'active', 'the untouched file is fine');
});

test('offline: a valid certificate follows its signed expiry; then it is expired, not deleted', async (t) => {
  const srv = await server(t);
  const app = tune(t, srv);
  await verifiedOwner(srv, app);
  await app.client.activate(code(srv));
  const checked = (await app.client.status()).data.license.lastCheckAt;
  // the server goes away
  const dead = tune(t, { ...srv, url: 'http://127.0.0.1:9' }, { dir: app.profile, crypt: app.crypt, machine: app.machine });
  srv.now.advance(6 * DAY);
  const r = await dead.client.refresh();
  assert.deepEqual([outcome(r), r.data.outcome.retryable], ['unavailable', true]);
  assert.equal(r.data.license.state, 'active', 'still inside its signed time');
  assert.equal(r.data.license.lastCheckAt, checked, 'the last successful check stays the last successful one');
  assert.ok(r.data.license.lastCheckFailedAt > checked);
  srv.now.advance(1 * DAY + 1);
  const later = (await dead.client.status()).data.license;
  assert.equal(later.state, 'expired');
  assert.equal(later.planId, 'tune-pro');
  assert.ok(fs.existsSync(app.file));
  // back online: renewed
  const back = tune(t, srv, { dir: app.profile, crypt: app.crypt, machine: app.machine });
  assert.equal(outcome(await back.client.refresh()), 'refreshed');
  assert.equal((await back.client.status()).data.license.state, 'active');
});

test('the clock set back is noticed and handled explicitly', async (t) => {
  const srv = await server(t);
  const app = tune(t, srv);
  await verifiedOwner(srv, app);
  await app.client.activate(code(srv));
  srv.now.advance(2 * DAY);
  await app.client.status(); // Tune ran two days later
  // the clock is set back a day: a time-limited licence can't be judged on it
  const behind = clock(srv.now() - DAY);
  const rolled = tune(t, srv, { dir: app.profile, crypt: app.crypt, machine: app.machine, now: behind });
  const s = (await rolled.client.status()).data.license;
  assert.equal(s.state, 'clock');
  const enforce = createEntitlements({ policy: 'enforce', license: rolled.client.current });
  assert.deepEqual(enforce.check('cleanup'), { ok: false, reason: 'noLicense', feature: 'cleanup' });
  // the clock corrected: fine again
  const fixed = tune(t, srv, { dir: app.profile, crypt: app.crypt, machine: app.machine });
  assert.equal((await fixed.client.status()).data.license.state, 'active');
});

test("an answer that doesn't verify never replaces the licence this PC holds", async (t) => {
  const srv = await server(t);
  let tamper = false;
  const mitm = async (url, init) => {
    const res = await fetch(url, init);
    if (!tamper) return res;
    const body = await res.json();
    if (body.certificate) body.certificate.payload.features.push('everything');
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  const app = tune(t, srv, { fetch: mitm });
  await verifiedOwner(srv, app);
  await app.client.activate(code(srv));
  const before = fs.readFileSync(app.file);
  tamper = true;
  srv.now.advance(DAY);
  const r = await app.client.refresh();
  assert.equal(outcome(r), 'invalidCertificate');
  assert.ok(fs.readFileSync(app.file).equals(before), 'the stored licence is untouched');
  assert.equal(r.data.license.state, 'active');
  assert.ok(!r.data.license.features.includes('everything'));
  // a certificate for a different (valid-looking) key: refused the same way
  const other = createLicensingClient({
    config: { url: srv.url, publicKey: crypto.generateKeyPairSync('ed25519').publicKey, problem: null },
    api: createApi({ baseUrl: srv.url, fetch }), store: createProtectedStore({ file: path.join(app.profile, 'x.bin'), crypt: fakeCrypt() }),
    machineId: async () => ({ ok: true, machineId: app.machine.machineId }), now: srv.now,
  });
  await other.startOwner('owner@example.com');
  await other.confirmOwner(srv.mailCode('owner@example.com'));
  const fake = await other.activate(code(srv));
  assert.deepEqual([outcome(fake), fake.data.license.state], ['invalidCertificate', 'none'], 'signed by a key Tune does not trust');
});

test('the server ends the licence: shown as revoked, the file is kept', async (t) => {
  const srv = await server(t);
  const app = tune(t, srv);
  await verifiedOwner(srv, app);
  const o = srv.order();
  await app.client.activate(o.units[0].code);
  srv.service.revokeUnit({ unitId: o.units[0].unitId });
  const r = await app.client.refresh();
  assert.deepEqual([outcome(r), r.data.license.state], ['licenseRevoked', 'revoked']);
  assert.ok(fs.existsSync(app.file));
});

test('storage: without protection nothing is activated or written; a failed write leaves Tune usable', async (t) => {
  const srv = await server(t);
  const off = fakeCrypt();
  off.on = false;
  const app = tune(t, srv, { crypt: off });
  await verifiedOwner(srv, app);
  const r = await app.client.activate(code(srv));
  assert.deepEqual([outcome(r), r.data.storage, r.data.busy], ['storageUnavailable', 'unavailable', false]);
  assert.equal(srv.count('devices'), 0, 'no request left: the device key could not be kept');
  assert.ok(!fs.existsSync(app.file), 'nothing written in plaintext instead');

  // the device key is stored, then the disk fills before the licence is
  const full = fakeCrypt();
  const app2 = tune(t, srv, { crypt: full, machine: pc('pc-full') });
  await verifiedOwner(srv, app2, 'full@example.com');
  const serial = code(srv);
  let writes = 0;
  const encrypt = full.encrypt;
  full.encrypt = (s) => { if (++writes > 1) throw new Error('disk full'); return encrypt(s); };
  const w = await app2.client.activate(serial);
  assert.deepEqual([outcome(w), w.data.busy], ['storageFailed', false]);
  assert.equal(w.data.license.state, 'active', 'valid for this session');
  assert.equal((await app2.client.status()).data.busy, false, 'the next request works');
  // next start: the licence wasn't saved, and recovery brings it back on this PC
  full.encrypt = encrypt;
  const next = tune(t, srv, { dir: app2.profile, crypt: full, machine: app2.machine });
  assert.equal((await next.client.status()).data.license.state, 'none');
  await verifiedOwner(srv, next, 'full@example.com');
  assert.equal(outcome(await next.client.recover()), 'recovered');
  assert.equal(srv.count('licenses'), 1);
});

test("an unreadable licence file is kept, and set aside only when a new licence replaces it", async (t) => {
  const srv = await server(t);
  const app = tune(t, srv);
  fs.writeFileSync(app.file, Buffer.concat([MAGIC, Buffer.from('damaged')]));
  const s = (await app.client.status()).data;
  assert.deepEqual([s.storage, s.license.state], ['unreadable', 'none']);
  assert.ok(fs.existsSync(app.file), 'not deleted');
  await verifiedOwner(srv, app);
  assert.equal(outcome(await app.client.activate(code(srv))), 'activated');
  assert.ok(fs.existsSync(`${app.file}.unreadable`), 'the old file is kept aside');
});

test('a server that never answers: a bounded wait, then "unavailable", and the request can be retried', async (t) => {
  const srv = await server(t);
  const sockets = new Set();
  const hang = http.createServer(() => { /* never answers */ });
  hang.on('connection', (s) => sockets.add(s));
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); hang.close(); });
  const url = `http://127.0.0.1:${hang.address().port}`;
  const app = tune(t, { ...srv, url }, { timeoutMs: 300 });
  const started = Date.now();
  const r = await app.client.startOwner('owner@example.com');
  assert.deepEqual([outcome(r), r.data.outcome.reason, r.data.busy, r.data.canRetry], ['unavailable', 'timeout', false, true]);
  assert.ok(Date.now() - started < 3000, 'bounded');
});

test('one request at a time; a second one is told, not queued', async (t) => {
  const srv = await server(t);
  let release;
  const slow = async (url, init) => { await new Promise((r) => { release = r; }); return fetch(url, init); };
  const app = tune(t, srv, { fetch: slow });
  const first = app.client.startOwner('owner@example.com');
  await new Promise((r) => setImmediate(r));
  assert.equal(outcome(await app.client.confirmOwner('123456')), 'busy');
  release();
  assert.equal(outcome(await first), 'codeSent');
});

test('without a configured server, licensing is off and says so', async () => {
  const store = createProtectedStore({ file: path.join(os.tmpdir(), `tune-none-${process.pid}.bin`), crypt: fakeCrypt() });
  const client = createLicensingClient({ config: { url: null, publicKey: null, problem: 'notConfigured' }, api: null, store, machineId: async () => ({ ok: false }) });
  const r = await client.activate('x');
  assert.deepEqual([r.data.available, r.data.problem, outcome(r), r.data.license.state], [false, 'notConfigured', 'notConfigured', 'none']);
});

test('configuration: packaged builds ignore development settings; only https or this PC', () => {
  const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const env = { TUNE_LICENSING_URL: 'http://127.0.0.1:8787', TUNE_LICENSING_PUBLIC_KEY: key, TUNE_LICENSING_POLICY: 'enforce', TUNE_TEST_PROTECTED_STORAGE: 'insecure-test-only', TUNE_TEST_MACHINE_ID: 'a'.repeat(64) };
  const shipped = licensingConfig({ packaged: true, env });
  assert.deepEqual([shipped.url, shipped.publicKey, shipped.policy, shipped.testStorage, shipped.testMachineId, shipped.problem], [null, null, 'open', false, null, 'notConfigured']);
  const dev = licensingConfig({ packaged: false, env });
  assert.deepEqual([dev.url, dev.policy, dev.testStorage, dev.problem], ['http://127.0.0.1:8787', 'enforce', true, null]);
  assert.equal(licensingConfig({ packaged: false, env: {} }).problem, 'notConfigured');
  assert.equal(licensingConfig({ packaged: false, env: { ...env, TUNE_LICENSING_URL: 'http://licensing.example.com' } }).problem, 'misconfigured');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(licensingConfig({ packaged: false, env: { ...env, TUNE_LICENSING_PUBLIC_KEY: rsa } }).problem, 'misconfigured');
  assert.equal(serverUrl('https://user:pw@licensing.example.com', { development: false }), null);
  assert.equal(serverUrl('https://licensing.example.com/', { development: false }), 'https://licensing.example.com');
});

test('the open policy (shipped) allows everything whatever the licence; enforce needs the signed feature', () => {
  const open = createEntitlements({ policy: 'open', license: () => ({ state: 'none', features: [] }) });
  for (const f of ['drivers', 'bios', 'cleanup', 'startup', 'settings']) assert.equal(open.check(f).ok, true);
  const enforce = createEntitlements({ policy: 'enforce', license: () => ({ state: 'active', features: ['drivers'] }), free: ['settings'] });
  assert.equal(enforce.check('drivers').ok, true);
  assert.equal(enforce.check('settings').ok, true, 'free');
  assert.deepEqual(enforce.check('cleanup'), { ok: false, reason: 'notInPlan', feature: 'cleanup' });
  const broken = createEntitlements({ policy: () => { throw new Error('x'); } });
  assert.deepEqual(broken.check('drivers'), { ok: false, reason: 'policyError', feature: 'drivers' });
});

test('the background renewal at start never leaves a message or throws', async (t) => {
  const srv = await server(t);
  const app = tune(t, srv);
  await verifiedOwner(srv, app);
  await app.client.activate(code(srv));
  srv.now.advance(13 * 60 * MINUTE);
  const restart = tune(t, srv, { dir: app.profile, crypt: app.crypt, machine: app.machine });
  await restart.client.init();
  const s = (await restart.client.status()).data;
  assert.equal(s.license.lastCheckAt, srv.now(), 'renewed');
  assert.equal(s.outcome, null);
  const dead = tune(t, { ...srv, url: 'http://127.0.0.1:9' }, { dir: app.profile, crypt: app.crypt, machine: app.machine });
  srv.now.advance(13 * 60 * MINUTE);
  await assert.doesNotReject(dead.client.init());
  assert.equal((await dead.client.status()).data.license.state, 'active');
});
