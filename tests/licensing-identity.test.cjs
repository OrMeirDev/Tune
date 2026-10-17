// WIN-R01: the licence status and this PC's identity read. On Windows the identity is a PowerShell and
// WMI query that took longer than the e2e check's 15 s on a busy CI runner (run 12), while the status
// waited for it although no licence was stored: the Settings row said "Loading…" all that time, and
// the window and the start-up check each started a read of their own. Each case uses a stand-in read
// the test controls (delayed, failing, never answering) and the licensing server PoC.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pc } = require('../licensing/tests/helpers.cjs');
const { IDENTITY_WAIT_MS } = require('../electron/licensing/client.cjs');
const { createEntitlements } = require('../electron/licensing/entitlements.cjs');
const { fakeTimers, server, tune, verifiedOwner, code, outcome } = require('./licensing-app.cjs');

// A read the test answers by hand; counts how often it was started.
function slowIdentity(machine) {
  const r = { reads: 0, pending: [] };
  r.read = () => { r.reads++; return new Promise((resolve) => r.pending.push(resolve)); };
  r.answer = () => { for (const f of r.pending.splice(0)) f({ ok: true, machineId: machine.machineId }); };
  r.fail = () => { for (const f of r.pending.splice(0)) f({ ok: false }); };
  return r;
}
// whether a promise settles within a few event-loop turns (no real waiting)
const settlesSoon = (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);
const state = (r) => r.data.license.state;

test('no licence stored: the status answers while the identity is still being read, and the read happens once', async (t) => {
  const srv = await server(t);
  const machine = pc('pc-a');
  const id = slowIdentity(machine);
  const app = tune(t, srv, { machine, identity: id.read });
  const init = app.client.init();
  const first = app.client.status();
  assert.equal(await settlesSoon(first), true, 'the status did not wait for the identity read');
  const r = await first;
  assert.deepEqual([r.data.available, state(r), r.data.identity], [true, 'none', 'reading']);
  await app.client.status();
  assert.equal(id.reads, 1, 'one read, however many times the status is asked for');
  id.answer();
  await init;
  const after = await app.client.status();
  assert.deepEqual([state(after), after.data.identity, id.reads], ['none', 'ok', 1]);
});

test('no licence stored and the identity read fails: reported as unavailable (not loading); activation says so and sends nothing', async (t) => {
  const srv = await server(t);
  const machine = pc('pc-a');
  const id = slowIdentity(machine);
  const app = tune(t, srv, { machine, identity: id.read });
  const r = await app.client.status();
  assert.equal(r.data.identity, 'reading');
  id.fail();
  await new Promise((res) => setImmediate(res));
  const failed = await app.client.status();
  assert.deepEqual([state(failed), failed.data.identity], ['none', 'unavailable']);
  assert.equal(id.reads, 1, 'a status after a failure does not start another read by itself');
  await verifiedOwner(srv, app);
  const activating = app.client.activate(code(srv));
  await new Promise((res) => setImmediate(res));
  assert.equal(id.reads, 2, 'activation needs the identity, so it reads again');
  id.fail();
  assert.equal(outcome(await activating), 'identityUnavailable');
});

test('a licence stored: the status waits for the identity (bounded loading), then shows the licence; one read', async (t) => {
  const srv = await server(t);
  const machine = pc('pc-a');
  const setupApp = tune(t, srv, { machine });
  await verifiedOwner(srv, setupApp);
  assert.equal(outcome(await setupApp.client.activate(code(srv))), 'activated');
  // Tune starts again on the same profile; the identity is slow this time
  const id = slowIdentity(machine);
  const timers = fakeTimers(srv.now);
  const app = tune(t, srv, { machine, dir: setupApp.profile, identity: id.read, timers });
  const init = app.client.init();
  const first = app.client.status();
  assert.equal(await settlesSoon(first), false, 'a stored licence is not judged without the identity');
  id.answer();
  const r = await first;
  await init;
  assert.deepEqual([state(r), r.data.identity, id.reads], ['active', 'ok', 1]);
});

test('a licence stored and the identity read fails: "identity unavailable", not active and not "damaged"; Check now reads again', async (t) => {
  const srv = await server(t);
  const machine = pc('pc-a');
  const setupApp = tune(t, srv, { machine });
  await verifiedOwner(srv, setupApp);
  assert.equal(outcome(await setupApp.client.activate(code(srv))), 'activated');
  const id = slowIdentity(machine);
  const app = tune(t, srv, { machine, dir: setupApp.profile, identity: id.read });
  const first = app.client.status();
  id.fail();
  const r = await first;
  assert.deepEqual([state(r), r.data.identity], ['identityUnavailable', 'unavailable']);
  const gate = createEntitlements({ policy: 'enforce', license: app.client.current });
  assert.equal(gate.check('cleanup').ok, false, 'nothing gated is allowed while the licence is unchecked');
  const check = app.client.refresh();
  await new Promise((res) => setImmediate(res));
  assert.equal(id.reads, 2, 'Check now reads the identity again');
  id.answer();
  const checked = await check;
  assert.equal(state(checked), 'active');
  assert.equal(gate.check('cleanup').ok, true);
});

test('a licence stored and the identity read never answers: the status answers after IDENTITY_WAIT_MS as unavailable; a late answer is told to the window', async (t) => {
  const srv = await server(t);
  const machine = pc('pc-a');
  const setupApp = tune(t, srv, { machine });
  await verifiedOwner(srv, setupApp);
  assert.equal(outcome(await setupApp.client.activate(code(srv))), 'activated');
  const id = slowIdentity(machine);
  const timers = fakeTimers(srv.now);
  let told = 0;
  const app = tune(t, srv, { machine, dir: setupApp.profile, identity: id.read, timers, onChange: () => { told++; } });
  const first = app.client.status();
  await timers.advance(IDENTITY_WAIT_MS - 1);
  assert.equal(await settlesSoon(first), false, 'still within the bound');
  await timers.advance(1);
  const r = await first;
  assert.deepEqual([state(r), r.data.identity], ['identityUnavailable', 'reading']);
  assert.equal(told, 0);
  id.answer();
  await new Promise((res) => setImmediate(res));
  assert.equal(told, 1, 'the window is told when the identity finally comes');
  assert.equal(state(await app.client.status()), 'active');
  assert.equal(id.reads, 1);
});
