// Regressions for the L02 review (2026-10-14), each written to fail on the implementation reviewed at
// 38a2a98 and to pass after its repair:
// R01  renewal happens on its own while Tune stays open (before the signed certificate ends), with
//      bounded retries after a failure, a fresh look after suspend/resume or a clock change, no
//      overlapping requests, and timers that never keep the process alive
// R02  a release the server confirmed is kept (protected), shown, and enforced; only a server-approved
//      recovery makes this PC active again
// R03  a lost answer is "not confirmed", never "nothing changed"; trying again completes the same
//      request with exactly one licence
// The client runs against the licensing server PoC over real HTTP, on one hand-moved clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pc, MINUTE, DAY } = require('../licensing/tests/helpers.cjs');
const { createEntitlements } = require('../electron/licensing/entitlements.cjs');
const { fakeTimers, server, tune, verifiedOwner, code, outcome, watch, activated } = require('./licensing-app.cjs');

const HOUR = 60 * MINUTE;

// ---- R01: automatic renewal while Tune stays open ----

test('R01 a licence renews on its own while Tune stays open (7-day certificate, 8 days later)', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const refresh = watch('/v1/license/refresh');
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  const activatedAt = srv.now();
  await timers.advance(8 * DAY);
  const s = (await app.client.status()).data.license;
  assert.equal(s.state, 'active', 'renewed in the background, not expired');
  assert.ok(s.certificateExpiresAt > srv.now(), 'a certificate issued after activation');
  assert.ok(s.lastCheckAt > activatedAt + 7 * DAY);
  assert.ok(refresh.count >= 1 && refresh.count <= 20, `a few renewals, not a flood (${refresh.count})`);
});

test('R01 an outage: bounded retries with growing gaps; the certificate expires on time; renewal resumes when the server is back', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const refresh = watch('/v1/license/refresh');
  refresh.now = srv.now;
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  refresh.down = true;
  await timers.advance(6 * DAY);
  assert.equal((await app.client.status()).data.license.state, 'active', 'still inside its signed time');
  await timers.advance(2 * DAY);
  assert.equal((await app.client.status()).data.license.state, 'expired', 'expires at its signed end during the outage');
  assert.ok(refresh.count >= 5, `it kept trying (${refresh.count})`);
  assert.ok(refresh.count <= 8 * 24 + 20, `bounded: at most about one try an hour (${refresh.count})`);
  const gaps = refresh.times.slice(1, 6).map((x, i) => x - refresh.times[i]);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `the gaps grow (${gaps.map((g) => g / MINUTE)} min)`);
  refresh.down = false;
  await timers.advance(2 * HOUR);
  assert.equal((await app.client.status()).data.license.state, 'active', 'renewed after the outage, although the certificate had expired');
});

test('R01 after a suspend (timers did not run) or a clock jump, the next look renews at once', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const app = await activated(t, srv, { timers });
  // the PC slept for 9 days: no timer ran, the clock moved
  srv.now.advance(9 * DAY);
  assert.equal((await app.client.status()).data.license.state, 'expired');
  await app.client.wake();
  assert.equal((await app.client.status()).data.license.state, 'active', 'resume: renewed against the current clock');
  // the clock jumps forward 9 days while Tune runs: the next timer, at most minutes away, sees it
  srv.now.advance(9 * DAY);
  assert.ok(timers.nextIn() <= 15 * MINUTE, `a look at least every 15 minutes (${timers.nextIn() / MINUTE} min)`);
  await timers.advance(15 * MINUTE);
  assert.equal((await app.client.status()).data.license.state, 'active');
});

test('R01 the clock set back stops renewal and is still reported', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const refresh = watch('/v1/license/refresh');
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  await timers.advance(2 * DAY);
  const before = refresh.count;
  srv.now.advance(-DAY);
  await timers.advance(6 * HOUR);
  assert.equal((await app.client.status()).data.license.state, 'clock');
  assert.equal(refresh.count, before, 'no renewal on a clock that went back');
});

test('R01 no overlapping requests: "Check now" during a background renewal joins it; another action waits for it', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  let hold = null;
  const slow = async (url, init) => {
    if (hold && url.endsWith('/v1/license/refresh')) await hold.promise;
    return fetch(url, init);
  };
  const refresh = watch('/v1/license/refresh', slow);
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  const holdNext = () => { hold = {}; hold.promise = new Promise((r) => { hold.release = r; }); };
  const tick = () => new Promise((r) => setTimeout(r, 20));
  // the fake clock walks to the 12-hour mark through its 15-minute looks: wait for the request itself
  const inFlight = async () => { for (let i = 0; i < 500 && refresh.inFlight === 0; i++) await tick(); };

  // a background renewal waits on the network; "Check now" joins it instead of sending another
  holdNext();
  let background = timers.advance(13 * HOUR);
  await inFlight();
  assert.equal(refresh.inFlight, 1, 'the background renewal is in flight');
  const manual = app.client.refresh();
  await tick();
  assert.equal(refresh.inFlight, 1, 'no second renewal');
  hold.release();
  const [m] = await Promise.all([manual, background]);
  assert.equal(outcome(m), 'refreshed', '"Check now" reports the renewal it joined');
  assert.equal(refresh.count, 1);

  // the next background renewal: another action starts only after it
  holdNext();
  background = timers.advance(13 * HOUR);
  await inFlight();
  assert.equal(refresh.inFlight, 1);
  const other = app.client.startOwner('owner@example.com');
  await tick();
  assert.equal((await app.client.status()).data.busy, true, 'the other action is waiting');
  hold.release();
  const [o] = await Promise.all([other, background]);
  assert.equal(outcome(o), 'codeSent', 'it ran after the renewal');
  assert.equal(refresh.maxInFlight, 1, 'never two renewals at once');
  assert.equal(refresh.count, 2);
});

test('R01 a resume and an unlock right after it, while a renewal is in flight, send one request', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  let hold = null;
  const slow = async (url, init) => {
    if (hold && url.endsWith('/v1/license/refresh')) await hold.promise;
    return fetch(url, init);
  };
  const refresh = watch('/v1/license/refresh', slow);
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  hold = {};
  hold.promise = new Promise((r) => { hold.release = r; });
  // asleep past the renewal's due time; Windows then reports a resume and an unlock
  srv.now.advance(13 * HOUR);
  const resume = app.client.wake();
  const unlock = app.client.wake();
  for (let i = 0; i < 100 && refresh.inFlight === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(refresh.inFlight, 1, 'one renewal in flight');
  hold.release();
  await Promise.all([resume, unlock]);
  assert.equal(refresh.count, 1, 'one request for both');
  assert.equal(refresh.maxInFlight, 1);
  assert.equal((await app.client.status()).data.license.state, 'active');
  assert.equal(timers.pending(), 1, 'one look planned afterwards');
});

test('R01 no renewal without a server, without a licence, or after a confirmed release; timers stop on dispose and never hold the process', async (t) => {
  const srv = await server(t);
  // without a licence: nothing scheduled
  const timers = fakeTimers(srv.now);
  const empty = tune(t, srv, { timers, machine: pc('empty') });
  await empty.client.init();
  assert.equal(timers.pending(), 0);
  // with one: scheduled; dispose clears it
  const timers2 = fakeTimers(srv.now);
  const app = await activated(t, srv, { timers: timers2, machine: pc('with') });
  assert.ok(timers2.pending() >= 1);
  app.client.dispose();
  assert.equal(timers2.pending(), 0);
  // the default timers are unref'd: they never keep Tune (or a test) running
  const { realTimers } = require('../electron/licensing/client.cjs');
  const h = realTimers.set(() => {}, 60 * 60 * 1000);
  assert.equal(h.hasRef(), false);
  realTimers.clear(h);
});

test('R01 a background renewal tells the window, so the row shows it', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  let changes = 0;
  await activated(t, srv, { timers, onChange: () => { changes++; } });
  const before = changes;
  await timers.advance(13 * HOUR);
  assert.ok(changes > before, 'the window was told about the renewal');
});

// ---- R02: a confirmed release ----

async function releaseOnServer(srv, email = 'owner@example.com') {
  const token = srv.owner(email);
  const ids = srv.sql().prepare("SELECT id FROM devices WHERE state = 'active'").all().map((r) => r.id);
  for (const deviceId of ids) assert.equal(srv.service.releaseDevice({ ownerToken: token, deviceId }).result, 'ok');
  return ids;
}

test('R02 a release the server confirms is shown and enforced at once', async (t) => {
  const srv = await server(t);
  const app = await activated(t, srv);
  await releaseOnServer(srv);
  const r = await app.client.refresh();
  assert.equal(outcome(r), 'deviceReleased');
  assert.equal(r.data.license.state, 'released', 'not left "active"');
  assert.equal(srv.count('devices', "state = 'active'"), 0);
  const enforce = createEntitlements({ policy: 'enforce', license: app.client.current });
  assert.equal(enforce.check('cleanup').ok, false, 'no new gated action after the release');
  // the shipped policy keeps everything open, as before licensing
  assert.equal(createEntitlements({ policy: 'open', license: app.client.current }).check('cleanup').ok, true);
});

test('R02 the release survives a restart (kept in protected storage), and stops background renewal', async (t) => {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const refresh = watch('/v1/license/refresh');
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  await releaseOnServer(srv);
  await app.client.refresh();
  const again = tune(t, srv, { dir: app.profile, crypt: app.crypt, machine: app.machine, timers: fakeTimers(srv.now) });
  await again.client.init();
  assert.equal((await again.client.status()).data.license.state, 'released');
  const enforce = createEntitlements({ policy: 'enforce', license: again.client.current });
  assert.equal(enforce.check('cleanup').ok, false);
  const after = refresh.count;
  await timers.advance(3 * DAY);
  assert.equal(refresh.count, after, 'no renewal for a released device');
});

test('R02 without a confirmation (offline) the licence follows its signed certificate', async (t) => {
  const srv = await server(t);
  const refresh = watch('/v1/license/refresh');
  const app = await activated(t, srv, { fetch: refresh.fetch });
  await releaseOnServer(srv);
  refresh.down = true;
  const r = await app.client.refresh();
  assert.equal(outcome(r), 'unavailable');
  assert.equal(r.data.license.state, 'active', 'no confirmation: still valid until its signed end');
});

test('R02 only a server-approved recovery makes this PC active again; another PC is not affected', async (t) => {
  const srv = await server(t);
  const a = await activated(t, srv, { machine: pc('a'), order: { planId: 'tune-pro-3' } });
  const b = tune(t, srv, { machine: pc('b') });
  await verifiedOwner(srv, b);
  assert.equal(outcome(await b.client.recover()), 'recovered');
  // the owner releases PC a only
  const token = srv.owner('owner@example.com');
  const aId = srv.sql().prepare("SELECT d.id FROM devices d WHERE d.state = 'active' ORDER BY d.created_at LIMIT 1").get().id;
  assert.equal(srv.service.releaseDevice({ ownerToken: token, deviceId: aId }).result, 'ok');
  assert.equal((await a.client.refresh()).data.license.state, 'released');
  assert.equal((await b.client.refresh()).data.license.state, 'active', 'the other PC keeps working');
  // recovery on PC a, approved by the server, with a certificate that verifies
  await verifiedOwner(srv, a);
  const back = await a.client.recover();
  assert.deepEqual([outcome(back), back.data.license.state], ['recovered', 'active']);
  assert.equal(createEntitlements({ policy: 'enforce', license: a.client.current }).check('cleanup').ok, true);
  assert.equal(srv.count('licenses'), 1, 'the same licence, nothing redeemed');
});

// ---- R03: a lost answer is "not confirmed" ----

test('R03 a lost activation answer: not confirmed (never "nothing changed"); retry completes it with one licence', async (t) => {
  const srv = await server(t);
  let drop = 1;
  const lossy = async (url, init) => {
    const res = await fetch(url, init);
    if (url.endsWith('/v1/redeem') && drop-- > 0) { await res.text(); throw new TypeError('fetch failed'); }
    return res;
  };
  const app = tune(t, srv, { fetch: lossy });
  await verifiedOwner(srv, app);
  const lost = await app.client.activate(code(srv));
  assert.deepEqual([outcome(lost), lost.data.outcome.retryable], ['unavailable', true]);
  // the server did carry it out
  assert.equal(srv.count('licenses'), 1);
  assert.equal(srv.count('codes', "state = 'redeemed'"), 1);

  // what the person reads for this outcome
  const { STRINGS } = await import('../src/i18n.js');
  let keyOf = () => 'lic.o.unavailable';
  try { keyOf = (await import('../src/features/license/outcomeKey.mjs')).outcomeKey; } catch { /* the reviewed version had one message */ }
  const key = keyOf(lost.data.outcome);
  const en = STRINGS.en[key];
  const he = STRINGS.he[key];
  assert.ok(en && he, key);
  assert.doesNotMatch(en, /nothing changed/i);
  assert.doesNotMatch(he, /שום דבר לא השתנה/);
  assert.match(en, /isn't confirmed/);
  assert.match(en, /same request/);
  assert.match(he, /לא ידוע/);
  assert.match(he, /אותה בקשה/);

  const again = await app.client.retry();
  assert.deepEqual([outcome(again), again.data.license.state], ['activated', 'active']);
  assert.equal(srv.count('licenses'), 1, 'exactly one licence');
  assert.equal(srv.count('devices'), 1);
});

test("R03 no message for an answer that didn't arrive claims that nothing changed", async () => {
  const { STRINGS } = await import('../src/i18n.js');
  for (const lang of ['en', 'he']) {
    for (const [k, v] of Object.entries(STRINGS[lang])) {
      if (!k.startsWith('lic.o.unavailable') && k !== 'lic.o.failed') continue;
      assert.doesNotMatch(v, /nothing changed|שום דבר לא השתנה/i, `${lang} ${k}`);
    }
  }
});
