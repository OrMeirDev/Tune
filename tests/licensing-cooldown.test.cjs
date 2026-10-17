// Regressions for the third L02 review (2026-10-15), written to fail on the implementation reviewed
// at 62105d1 and to pass after its repair:
// R08  a wait the server asked for (rate_limited) and the minimum gap between refresh requests hold
//      for every way a refresh is sent: the background, "Check now", Try again, and a request straight
//      from the window. A deferred check sends nothing, says how long is left, keeps the licence and
//      the pending request, and doesn't move the deadline. A check the person asks for doesn't wait
//      for the next scheduled renewal.
// The client runs against the licensing server PoC over real HTTP; only refresh answers are replaced
// by a valid HTTP 429 when the test says so. One hand-moved clock: srv.now.advance moves time without
// running timers, timers.advance runs them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MINUTE } = require('../licensing/tests/helpers.cjs');
const { dispatch, isTrustedSender } = require('../electron/ipc/guard.cjs');
const { createChannels } = require('../electron/ipc/channels.cjs');
const { createOffers } = require('../electron/ipc/offers.cjs');
const { fakeTimers, server, watch, activated, outcome } = require('./licensing-app.cjs');

const HOUR = 60 * MINUTE;
const REFRESH = '/v1/license/refresh';
const WAIT_MS = 120_000;
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const waitOf = (r) => r.data.outcome.retryAfterSeconds;
const pause = () => new Promise((r) => setTimeout(r, 20));

// Tune activated against the PoC. ctl.limit: refresh is answered "rate_limited, retry after 120 s";
// ctl.holdNext(): the next refresh waits on the network until ctl.hold.release().
async function cooled(t) {
  const srv = await server(t);
  const timers = fakeTimers(srv.now);
  const ctl = { limit: false, hold: null };
  const inner = async (url, init) => {
    if (!url.endsWith(REFRESH)) return fetch(url, init);
    if (ctl.hold) await ctl.hold.promise;
    return ctl.limit ? json({ result: 'rate_limited', retryAfterSeconds: 120 }, 429) : fetch(url, init);
  };
  ctl.holdNext = () => {
    let release;
    const promise = new Promise((r) => { release = r; });
    ctl.hold = { promise, release: () => { ctl.hold = null; release(); } };
  };
  const refresh = watch(REFRESH, inner);
  refresh.now = srv.now;
  const app = await activated(t, srv, { timers, fetch: refresh.fetch });
  const inFlight = async () => { for (let i = 0; i < 300 && refresh.inFlight === 0; i++) await pause(); };
  return { srv, timers, refresh, app, ctl, inFlight };
}

test('R08 the server asked to wait 120 s: refresh, wake, refresh, refresh send one request, and the deadline stays put', async (t) => {
  const { srv, timers, refresh, app, ctl } = await cooled(t);
  const before = (await app.client.status()).data.license;
  ctl.limit = true;
  const first = await app.client.refresh();
  assert.deepEqual([outcome(first), waitOf(first)], ['rateLimited', 120]);
  assert.equal(refresh.count, 1);
  assert.equal(timers.nextIn(), WAIT_MS, 'the next look waits for the server');
  await app.client.wake();
  const second = await app.client.refresh();
  const third = await app.client.refresh();
  assert.equal(refresh.count, 1, 'one request in all');
  for (const r of [second, third]) {
    assert.deepEqual([outcome(r), waitOf(r), r.data.outcome.deferred], ['rateLimited', 120, true], 'deferred here, with the time left');
    assert.equal(r.data.license.state, 'active');
    assert.equal(r.data.license.certificateExpiresAt, before.certificateExpiresAt, 'the stored licence is unchanged');
    assert.equal(r.data.license.lastCheckAt, before.lastCheckAt);
  }
  assert.equal(timers.nextIn(), WAIT_MS, 'clicks neither restart nor extend the wait');
  // half way: the same deadline
  srv.now.advance(60_000);
  assert.equal(waitOf(await app.client.refresh()), 60);
  assert.equal(timers.nextIn(), 60_000);
  // the timers up to a millisecond before the deadline send nothing; a click then is told 1 s
  await timers.advance(60_000 - 1);
  await app.client.wake();
  const last = await app.client.refresh();
  assert.deepEqual([outcome(last), waitOf(last)], ['rateLimited', 1]);
  assert.equal(refresh.count, 1);
  // at the deadline the timer sends one request, which renews
  ctl.limit = false;
  await timers.advance(1);
  assert.equal(refresh.count, 2);
  assert.equal((await app.client.status()).data.license.lastCheckAt, srv.now());
});

test('R08 Try again during a wait is deferred and keeps the pending request; at the deadline one request succeeds', async (t) => {
  const { srv, timers, refresh, app, ctl } = await cooled(t);
  // an unanswered check leaves a request to try again
  refresh.down = true;
  const lost = await app.client.refresh();
  assert.deepEqual([outcome(lost), lost.data.canRetry], ['unavailable', true]);
  // Try again at once: within the minimum gap, deferred, the pending request kept
  const early = await app.client.retry();
  assert.deepEqual([outcome(early), waitOf(early), early.data.outcome.deferred, early.data.canRetry], ['rateLimited', 60, true, true]);
  assert.equal(refresh.count, 1);
  // the network is back but the server is busy: the background renewal a minute later is asked to wait
  refresh.down = false;
  ctl.limit = true;
  await timers.advance(MINUTE);
  assert.equal(refresh.count, 2, 'the background renewal, answered with a wait');
  const deadline = srv.now() + WAIT_MS;
  // Try again during that wait: deferred, nothing sent, still pending
  srv.now.advance(30_000);
  const during = await app.client.retry();
  assert.deepEqual([outcome(during), waitOf(during), during.data.canRetry], ['rateLimited', 90, true]);
  assert.equal(refresh.count, 2);
  // at the deadline: one request, renewed, nothing left to try again
  ctl.limit = false;
  srv.now.advance(deadline - srv.now());
  const done = await app.client.retry();
  assert.deepEqual([outcome(done), done.data.canRetry], ['refreshed', false]);
  assert.equal(refresh.count, 3);
  assert.equal(done.data.license.lastCheckAt, srv.now());
});

test('R08 "Check now" does not wait for the next scheduled renewal, only for the minimum gap after the last request', async (t) => {
  const { srv, timers, refresh, app } = await cooled(t);
  // just activated: the next scheduled renewal is 12 hours away
  assert.equal(outcome(await app.client.refresh()), 'refreshed');
  assert.equal(refresh.count, 1);
  srv.now.advance(30_000);
  const soon = await app.client.refresh();
  assert.deepEqual([outcome(soon), waitOf(soon), soon.data.outcome.deferred], ['rateLimited', 30, true], 'within a minute of the last request');
  assert.equal(refresh.count, 1);
  srv.now.advance(30_000);
  assert.equal(outcome(await app.client.refresh()), 'refreshed', 'a minute after it: sent, hours before the scheduled renewal');
  assert.equal(refresh.count, 2);
  // the background cadence is its own: nothing for the next 11 hours
  await timers.advance(11 * HOUR);
  assert.equal(refresh.count, 2);
});

test('R08 at the deadline a manual and a background check together send one request', async (t) => {
  const { srv, timers, refresh, app, ctl, inFlight } = await cooled(t);
  ctl.limit = true;
  await app.client.refresh();
  ctl.limit = false;
  // the background renewal goes first; "Check now" joins it
  ctl.holdNext();
  const background = timers.advance(WAIT_MS);
  await inFlight();
  const manual = app.client.refresh();
  await pause();
  assert.equal(refresh.inFlight, 1);
  ctl.hold.release();
  const [m] = await Promise.all([manual, background]);
  assert.equal(outcome(m), 'refreshed');
  assert.equal(refresh.count, 2);
  // the next time "Check now" goes first, and the timer fires while it is on the network
  ctl.limit = true;
  srv.now.advance(MINUTE);
  assert.equal(outcome(await app.client.refresh()), 'rateLimited');
  ctl.limit = false;
  srv.now.advance(WAIT_MS);
  ctl.holdNext();
  const first = app.client.refresh();
  await inFlight();
  await timers.advance(0);
  assert.equal(refresh.inFlight, 1);
  ctl.hold.release();
  assert.equal(outcome(await first), 'refreshed');
  await timers.advance(MINUTE);
  assert.equal(refresh.count, 4, 'one request each time');
  assert.equal(refresh.maxInFlight, 1);
});

test('R08 requests straight from the window (license:refresh, license:retry) get the same deferral', async (t) => {
  const { refresh, app } = await cooled(t);
  const PAGE = 'file:///C:/Program%20Files/Tune/resources/app.asar/dist/index.html';
  const webContents = { mainFrame: { url: PAGE } };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const channels = createChannels({ sys: {}, offers: createOffers(), licensing: app.client, entitlements: { check: () => ({ ok: true }), featureOf: () => null } });
  const send = (name) => dispatch(channels[name], event, [], (e) => isTrustedSender(e, { webContents, pageUrl: PAGE }));
  // an unanswered check (it leaves a request to try again), then five more within the minimum gap
  refresh.down = true;
  assert.equal(outcome(await send('license:refresh')), 'unavailable');
  refresh.down = false;
  for (let i = 0; i < 5; i++) {
    const r = await send(i % 2 ? 'license:retry' : 'license:refresh');
    assert.deepEqual([outcome(r), r.data.outcome.deferred], ['rateLimited', true]);
  }
  assert.equal(refresh.count, 1, 'one request for six from the window');
});
