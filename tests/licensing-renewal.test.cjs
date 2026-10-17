// Regressions for the second L02 review (2026-10-14), each written to fail on the implementation
// reviewed at bc8d17f and to pass after its repair:
// R06  every renewal outcome plans the next request on purpose: the server's own delay, spaced-out
//      retries after an answer that didn't renew (a refusal, a certificate that doesn't verify), a
//      cadence after a success that holds when the certificate is shorter than the renewal lead (the
//      licence's last day), and no renewal at all once the server confirmed the licence ended, even
//      after its certificate ran out. Neither the timers nor resume/unlock signals bypass it.
// R07  a state change that the clock alone makes (set back, corrected, a certificate running out)
//      reaches the window once, without floods.
// The client runs against the licensing server PoC over real HTTP, on one hand-moved clock and timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pc, MINUTE, DAY } = require('../licensing/tests/helpers.cjs');
const { generateKeys } = require('../licensing/keys.cjs');
const { sign } = require('../electron/licensing/certificate.cjs');
const { createDeviceKey } = require('../electron/licensing/device-keys.cjs');
const { evaluate } = require('../electron/licensing/license-state.cjs');
const { createEntitlements } = require('../electron/licensing/entitlements.cjs');
const { fakeTimers, server, tune, watch, activated } = require('./licensing-app.cjs');

const HOUR = 60 * MINUTE;
const REFRESH = '/v1/license/refresh';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const license = async (app) => (await app.client.status()).data.license;
// resume, unlock, resume: the same clock time, one after the other
const wakes = async (app, n = 3) => { for (let i = 0; i < n; i++) await app.client.wake(); };
const gapsOf = (times) => times.slice(1).map((x, i) => x - times[i]);

// ---- R06: every outcome plans the next request ----

test('R06-A the server asks for a delay (rate_limited, 120 s): neither the timer nor wake signals send before it', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  let limit = false;
  const limiting = (url, init) => (limit && url.endsWith(REFRESH) ? json({ result: 'rate_limited', retryAfterSeconds: 120 }, 429) : fetch(url, init));
  const refresh = watch(REFRESH, limiting);
  refresh.now = srv.now;
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  srv.now.advance(13 * HOUR);
  limit = true;
  await app.client.wake();
  assert.equal(refresh.count, 1, 'the due renewal was sent and refused with a delay');
  assert.ok(timers.nextIn() >= 120_000, `the next look waits for the server's delay (${timers.nextIn()} ms)`);
  await wakes(app);
  assert.equal(refresh.count, 1, 'resume and unlock do not bypass the delay');
  await timers.advance(119_000);
  assert.equal(refresh.count, 1, 'nor does a timer');
  limit = false;
  await timers.advance(2_000);
  assert.equal(refresh.count, 2, 'one request once the delay has passed');
  const l = await license(app);
  assert.equal(l.state, 'active');
  assert.equal(l.lastCheckAt, refresh.times[1], 'renewed');
  await wakes(app);
  assert.equal(refresh.count, 2, 'and then the regular cadence again');
  // a server that keeps asking for a delay: each one respected, the gaps grow, the total stays small
  limit = true;
  srv.now.advance(13 * HOUR);
  await timers.advance(DAY);
  const asked = refresh.times.slice(2);
  assert.ok(asked.length >= 5 && asked.length <= 40, `bounded (${asked.length} requests in a day)`);
  assert.ok(gapsOf(asked).every((g) => g >= 120_000), `never sooner than asked (${gapsOf(asked).map((g) => g / 1000)} s)`);
});

test('R06-B a renewed certificate that does not verify: the stored licence keeps its signed end, and retries are spaced out', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  let corrupt = false;
  const corrupting = async (url, init) => {
    const res = await fetch(url, init);
    if (!corrupt || !url.endsWith(REFRESH)) return res;
    const body = await res.json();
    if (body.certificate) {
      const s = Buffer.from(body.certificate.signature, 'base64url');
      s[0] ^= 1;
      body.certificate.signature = s.toString('base64url');
    }
    return json(body, res.status);
  };
  const refresh = watch(REFRESH, corrupting);
  refresh.now = srv.now;
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  const before = await license(app);
  corrupt = true;
  srv.now.advance(13 * HOUR);
  await app.client.wake();
  assert.equal(refresh.count, 1);
  let l = await license(app);
  assert.equal(l.state, 'active', 'the stored certificate is kept');
  assert.equal(l.certificateExpiresAt, before.certificateExpiresAt, 'with its signed end');
  assert.equal(l.lastCheckAt, before.lastCheckAt, 'and the answer is not a successful check');
  assert.ok(timers.nextIn() > 0, 'the next look is in the future');
  await wakes(app);
  assert.equal(refresh.count, 1, 'resume and unlock do not send it again at once');
  // a restart reads the same licence back
  const again = tune(t, srv, { dir: app.profile, crypt: app.crypt });
  l = await license(again);
  assert.equal(l.state, 'active');
  assert.equal(l.certificateExpiresAt, before.certificateExpiresAt);
  // timers: spaced-out retries, a handful a day
  await timers.advance(DAY);
  assert.ok(refresh.count >= 3 && refresh.count <= 8, `a few retries in a day (${refresh.count})`);
  assert.ok(gapsOf(refresh.times).every((g) => g >= HOUR), `at least an hour apart (${gapsOf(refresh.times).map((g) => g / MINUTE)} min)`);
  // the server's answers verify again: a later retry renews
  corrupt = false;
  await timers.advance(12 * HOUR);
  l = await license(app);
  assert.equal(l.state, 'active');
  assert.ok(l.certificateExpiresAt > before.certificateExpiresAt, 'renewed once an answer verifies');
});

test("R06-B a refusal (the server doesn't accept the request) is retried later, not at once", async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  let refuse = false;
  const refusing = (url, init) => (refuse && url.endsWith(REFRESH) ? json({ result: 'bad_signature' }, 401) : fetch(url, init));
  const refresh = watch(REFRESH, refusing);
  refresh.now = srv.now;
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  refuse = true;
  srv.now.advance(13 * HOUR);
  await app.client.wake();
  await wakes(app);
  assert.equal(refresh.count, 1, 'one request at the due time');
  assert.ok(timers.nextIn() > 0);
  await timers.advance(DAY);
  assert.ok(refresh.count <= 8, `bounded (${refresh.count})`);
  assert.ok(gapsOf(refresh.times).every((g) => g >= HOUR));
  assert.equal((await license(app)).state, 'active', 'the stored certificate still counts until its signed end');
});

test("R06-C a renewal on the licence's last day: the certificate ends with the licence (24 h), and the next check is planned, not immediate", async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const refresh = watch(REFRESH);
  refresh.now = srv.now;
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  const licEnd = (await license(app)).licenseExpiresAt;
  assert.ok(licEnd > srv.now() + 360 * DAY, 'an annual licence');
  // the PC was off; it starts with one day of the licence left
  srv.now.advance(licEnd - DAY - srv.now());
  await app.client.wake();
  assert.equal(refresh.count, 1);
  let l = await license(app);
  assert.equal(l.state, 'active');
  assert.equal(l.lastCheckAt, srv.now(), 'a successful check');
  assert.equal(l.certificateExpiresAt, licEnd, 'the certificate ends with the licence (24 h), not later');
  assert.equal(l.licenseExpiresAt, licEnd, 'the licence end is unchanged');
  assert.ok(timers.nextIn() > 0, `the next look is in the future (${timers.nextIn()} ms)`);
  await wakes(app);
  assert.equal(refresh.count, 1, 'resume and unlock right after a success send nothing');
  await timers.advance(11 * HOUR);
  assert.equal(refresh.count, 1, 'no check before the regular 12 hours');
  await timers.advance(HOUR);
  assert.equal(refresh.count, 2, 'one check at 12 hours');
  l = await license(app);
  assert.equal(l.certificateExpiresAt, licEnd, 'still ends with the licence');
  await timers.advance(12 * HOUR);
  assert.equal(refresh.count, 3, 'one more when the licence ends');
  l = await license(app);
  assert.equal(l.state, 'licenseExpired', 'the server confirmed the end');
  assert.equal(timers.pending(), 0, 'and renewal stopped');
  assert.ok(gapsOf(refresh.times).every((g) => g >= 12 * HOUR));
});

test('R06-D a licence the server confirmed as ended stays ended after its certificate ran out: no renewal, kept across a restart', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const refresh = watch(REFRESH);
  refresh.now = srv.now;
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  const licEnd = (await license(app)).licenseExpiresAt;
  // the PC was off past the licence's end: its certificate ran out too
  srv.now.advance(licEnd + DAY - srv.now());
  assert.equal((await license(app)).state, 'expired', 'before the server answers, only the certificate is known to have ended');
  await app.client.wake();
  assert.equal(refresh.count, 1, 'one renewal, answered "licence inactive, expired"');
  assert.equal((await license(app)).state, 'licenseExpired', 'the confirmed end is shown, not the certificate state');
  assert.equal(timers.pending(), 0, 'no further looks are planned');
  await wakes(app, 2);
  await timers.advance(3 * DAY);
  assert.equal(refresh.count, 1, 'no renewal by wake or by timer');
  // a restart: the same state, and still no renewal
  const later = fakeTimers(srv.now);
  const again = tune(t, srv, { dir: app.profile, crypt: app.crypt, timers: later, fetch: refresh.fetch });
  await again.client.init();
  assert.equal((await license(again)).state, 'licenseExpired');
  assert.equal(later.pending(), 0);
  await again.client.wake();
  assert.equal(refresh.count, 1);
  // the gate refuses under an enforcing policy; the open policy is unchanged
  assert.equal(createEntitlements({ policy: 'enforce', license: again.client.current }).check('cleanup').ok, false);
  assert.equal(createEntitlements({ policy: 'open', license: again.client.current }).check('cleanup').ok, true);
});

test('R06-D a confirmed end is read only from a certificate that is still this PC\'s, signed, for this install (checked as at its last moment)', () => {
  const keys = generateKeys();
  const serverPublic = crypto.createPublicKey(keys.signingKey);
  const signing = crypto.createPrivateKey(keys.signingKey);
  const device = createDeviceKey();
  const machineId = pc('pc-a').machineId;
  const t0 = Date.UTC(2026, 0, 1);
  const certificate = sign({
    licenseId: 'lic_000000000000000000000001', deviceId: 'dev_000000000000000000000001', machineId, devicePublicKey: device.publicKey,
    planId: 'tune-pro', features: ['cleanup'], issuedAt: t0, expiresAt: t0 + 7 * DAY, policyVersion: 1,
  }, signing);
  const lic = (serverStatus, cert = certificate) => ({ licenseId: 'lic_000000000000000000000001', deviceId: 'dev_000000000000000000000001', certificate: cert, serverStatus });
  const at = (license, over = {}) => evaluate({ license, lastSeenAt: t0, publicKey: serverPublic, machineId, devicePublicKey: device.publicKey, now: t0 + 30 * DAY, ...over }).state;
  assert.equal(at(lic('expired')), 'licenseExpired');
  assert.equal(at(lic('revoked')), 'revoked');
  assert.equal(at(lic('active')), 'expired', 'a certificate that ran out while the licence is fine: renewable');
  assert.equal(at(lic('expired'), { machineId: pc('pc-b').machineId }), 'otherMachine', 'another PC: not read as this licence');
  assert.equal(at(lic('expired'), { devicePublicKey: createDeviceKey().publicKey }), 'invalid', 'another install: not read as this licence');
  const forged = { ...certificate, signature: Buffer.alloc(64).toString('base64url') };
  assert.equal(at(lic('expired', forged)), 'invalid', 'a certificate that does not verify');
  assert.equal(at(lic('expired'), { now: t0 + DAY }), 'licenseExpired', 'and while the certificate is valid');
});

// ---- R07: a change the clock alone makes reaches the window ----

// the client, with every change notice recorded with the state the window would read then
async function watched(t, opts = {}) {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const refresh = watch(REFRESH);
  refresh.now = srv.now;
  const notices = [];
  let app = null;
  const onChange = () => notices.push({ state: app.client.current().state, at: srv.now(), requests: refresh.count });
  app = await activated(t, srv, { timers, fetch: refresh.fetch, onChange, ...opts });
  return { srv, timers, refresh, notices, app };
}

test('R07 the clock set back, then corrected (no renewal due): the window is told each time, once', async (t) => {
  const { srv, timers, refresh, notices, app } = await watched(t);
  await timers.advance(13 * HOUR);
  assert.equal(refresh.count, 1, 'a background renewal at 12 hours');
  assert.equal(notices.at(-1).state, 'active', 'the renewal was reported');
  const after = notices.length;
  srv.now.advance(-HOUR);
  await app.client.wake();
  assert.equal(app.client.current().state, 'clock');
  assert.deepEqual(notices.slice(after).map((n) => n.state), ['clock'], 'active -> clock reported once');
  await wakes(app);
  await timers.advance(30 * MINUTE);
  assert.equal(notices.length, after + 1, 'no repeats while it stays so');
  srv.now.advance(HOUR);
  await app.client.wake();
  assert.equal(app.client.current().state, 'active');
  assert.equal(refresh.count, 1, 'no renewal was due');
  assert.deepEqual(notices.slice(after).map((n) => n.state), ['clock', 'active'], 'clock -> active reported once');
});

test('R07 a stable licence sends no notices between renewals', async (t) => {
  const { timers, notices, app } = await watched(t);
  const after = notices.length;
  await wakes(app, 5);
  await timers.advance(11 * HOUR);
  assert.equal(notices.length, after, 'none while nothing changed');
  await timers.advance(2 * HOUR);
  assert.equal(notices.length, after + 1, 'one for the renewal');
});

test('R07 the certificate runs out during an outage, between retries: the window is told when it happens', async (t) => {
  const { srv, timers, refresh, notices, app } = await watched(t);
  const end = (await license(app)).certificateExpiresAt;
  refresh.down = true;
  await timers.advance(end - srv.now() + 20 * MINUTE);
  const first = notices.find((n) => n.state === 'expired');
  assert.ok(first, 'the change was reported');
  assert.ok(first.at - end <= 15 * MINUTE, `soon after the end (${(first.at - end) / MINUTE} min)`);
  assert.ok(!refresh.times.some((x) => x >= end && x <= first.at), 'by a look, not by a renewal attempt');
  assert.equal(notices.filter((n) => n.state === 'expired' && n.requests === first.requests).length, 1, 'once');
  // the outage ends: renewal recovers and is reported
  refresh.down = false;
  await timers.advance(2 * HOUR);
  assert.equal(app.client.current().state, 'active');
  assert.equal(notices.at(-1).state, 'active');
});
