// WIN-R03: which helper runs a change. Only the service version this app was built with may run one;
// an older service (6 or 7, left by an automatic update), one that doesn't answer a well-formed version,
// or none at all means Windows' own prompt (the admin session) instead. After the service was asked,
// the admin session is used only when the change certainly did not run there. Plus the status the
// window gets (the notice and the Settings reminder) and "Later". Off Windows: the pipe, the admin
// session and PowerShell are stand-ins that record what reaches them.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createChannels } = require('../electron/ipc/channels.cjs');

const EL = path.join(__dirname, '..', 'electron');
const CURRENT = require(path.join(EL, 'privilege', 'service-version.cjs'));
const fresh = (m) => { delete require.cache[require.resolve(path.join(EL, m))]; };

// service.cjs (and a feature that changes the PC, restore.cjs) loaded against stand-ins:
// `answer(req)` is what the service pipe says (null: nothing there).
function load(answer, { runPS } = {}) {
  const calls = [];
  const pipe = require(path.join(EL, 'privilege', 'pipe.cjs'));
  const admin = require(path.join(EL, 'privilege', 'admin-session.cjs'));
  const ps = require(path.join(EL, 'infra', 'powershell.cjs'));
  const real = { pipeCall: pipe.pipeCall, adminCall: admin.adminCall, runPS: ps.runPS };
  pipe.pipeCall = async (name, req) => { calls.push(['service', req.op]); return answer(req); };
  admin.adminCall = async (req) => { calls.push(['admin', req.op]); return { ok: true, data: 'via admin' }; };
  ps.runPS = async () => (runPS ? runPS() : { ok: true, data: '' });
  fresh('privilege/service.cjs'); fresh('features/restore.cjs');
  const service = require(path.join(EL, 'privilege', 'service.cjs'));
  const restore = require(path.join(EL, 'features', 'restore.cjs'));
  Object.assign(pipe, { pipeCall: real.pipeCall });
  Object.assign(admin, { adminCall: real.adminCall });
  Object.assign(ps, { runPS: real.runPS });
  fresh('privilege/service.cjs'); fresh('features/restore.cjs');
  return { service, restore, calls };
}
// a service that answers `version` (null: nothing on the pipe) and `change` to anything else
const svc = (version, change = { ok: true, data: { freed: 0 } }) => (req) => (req.op === 'version' ? (version === null ? null : { ok: true, data: { version } }) : change);
const CLEAN = { op: 'clean', keys: [] };

test(`the current service (${CURRENT}) runs the change; it was asked its version first`, async () => {
  const { service, calls } = load(svc(CURRENT));
  assert.deepEqual(await service.privileged(CLEAN), { ok: true, data: { freed: 0 }, via: 'service' });
  assert.deepEqual(calls, [['service', 'version'], ['service', 'clean']]);
  const numeric = load(svc(Number(CURRENT)));
  assert.equal((await numeric.service.privileged(CLEAN)).via, 'service', 'a numeric version counts');
});

test('an older service (6 or 7) never gets the change: Windows\' prompt (the admin session) instead', async () => {
  for (const old of ['6', '7']) {
    const { service, calls } = load(svc(old, { ok: true, data: 'ran in the old service' }));
    assert.deepEqual(await service.privileged(CLEAN), { ok: true, data: 'via admin' });
    assert.deepEqual(calls, [['service', 'version'], ['admin', 'clean']], old);
  }
});

test('no service, or one whose version is missing or malformed: the admin session; the change never reaches it', async () => {
  const answers = [null, { ok: true, data: {} }, { ok: true, data: null }, { ok: true }, { ok: false, error: 'x' },
    { ok: true, data: { version: 'abc' } }, { ok: true, data: { version: '8.1' } }, { ok: true, data: { version: '' } },
    { ok: true, data: { version: { v: 8 } } }, { ok: true, data: { version: 1e21 } }, { ok: true, data: { version: '9999999' } }];
  for (const a of answers) {
    const { service, calls } = load((req) => (req.op === 'version' ? a : { ok: true, data: 'ran in an unverified service' }));
    assert.deepEqual(await service.privileged(CLEAN), { ok: true, data: 'via admin' }, JSON.stringify(a));
    assert.deepEqual(calls, [['service', 'version'], ['admin', 'clean']], JSON.stringify(a));
  }
});

test('after the current service was asked: the admin session only when the change certainly did not run there', async () => {
  // refused before running anything (a standard user, TUN-01): Windows' prompt instead
  let l = load(svc(CURRENT, { ok: false, error: 'only an administrator', code: 'notAllowed' }));
  assert.deepEqual(await l.service.privileged(CLEAN), { ok: true, data: 'via admin' });
  assert.deepEqual(l.calls.map((c) => c[0]), ['service', 'service', 'admin']);
  // gone between the two requests (never connected): nothing ran, so the prompt is safe
  l = load(svc(CURRENT, null));
  assert.deepEqual(await l.service.privileged(CLEAN), { ok: true, data: 'via admin' });
  // answers: used as they are, never a second try through the admin session
  for (const a of [
    { ok: false, error: 'another change is running', code: 'busy' },
    { ok: false, error: 'the operation did not finish in time and was stopped', code: 'timedOut' },
    { ok: false, error: 'the operation did not finish in time; not confirmed', code: 'timedOut', stopped: false },
    { ok: false, error: 'the change was not started: …', code: 'containmentFailed' },
    // sent, but no answer came: it may have run, so it is not sent again anywhere
    { ok: false, error: 'no answer in time', code: 'noAnswer' },
    { ok: false, error: 'the connection closed without an answer', code: 'noAnswer' },
  ]) {
    l = load(svc(CURRENT, a));
    assert.deepEqual(await l.service.privileged(CLEAN), { ...a, via: 'service' }, a.code);
    assert.deepEqual(l.calls.map((c) => c[0]), ['service', 'service'], a.code);
  }
});

test('a change from a feature (a restore point, as the window asks for it) follows the same rule', async () => {
  let l = load(svc('7', { ok: true, data: 'created' }));
  assert.deepEqual(await l.restore.createRestorePoint(), { ok: true, data: 'via admin' });
  assert.deepEqual(l.calls, [['service', 'version'], ['admin', 'restore']]);
  l = load(svc(CURRENT, { ok: true, data: 'created' }));
  assert.equal((await l.restore.createRestorePoint()).via, 'service');
});

test("the service's status: current, outdated, unverifiable, stopped, missing", async () => {
  const status = async (answer, runPS) => (await load(answer, { runPS }).service.serviceStatus()).data;
  let s = await status(svc(CURRENT));
  assert.deepEqual([s.installed, s.running, s.version, s.current, s.compat], [true, true, CURRENT, true, 'current']);
  s = await status(svc('7'));
  assert.deepEqual([s.installed, s.running, s.version, s.current, s.compat], [true, true, '7', false, 'outdated']);
  s = await status(() => ({ ok: true, data: { version: 'v7' } }));
  assert.deepEqual([s.installed, s.running, s.version, s.current, s.compat], [true, true, null, false, 'unverifiable']);
  s = await status(svc(null), () => ({ ok: true, data: 'Stopped' }));
  assert.deepEqual([s.installed, s.running, s.current, s.compat], [true, false, false, 'stopped']);
  s = await status(svc(null), () => ({ ok: true, data: '' }));
  assert.deepEqual([s.installed, s.running, s.current, s.compat], [false, false, false, 'missing']);
});

// The window's view: the reminder until the main process sees this version answer; the notice for a
// running older or unverifiable service until "Later" for that pair of versions.
test('the notice, "Later" and the Settings reminder', async () => {
  let status = { installed: true, running: true, version: '7', current: false, compat: 'outdated' };
  let stored = {};
  const ch = createChannels({
    sys: { serviceStatus: async () => ({ ok: true, data: { ...status } }), SERVICE_VERSION: CURRENT },
    settings: { get: () => ({ ...stored }), save: (s) => { stored = s; } },
    offers: {}, entitlements: { featureOf: () => null },
  });
  const view = () => ch['service:status'].run();
  let v = await view();
  assert.deepEqual([v.needsUpdate, v.notice, v.bundled], [true, true, CURRENT]);
  assert.deepEqual(ch['service:later'].args, [], '"Later" takes nothing from the window');
  v = await ch['service:later'].run();
  assert.equal(stored.serviceLater, `7>${CURRENT}`);
  assert.deepEqual([v.needsUpdate, v.notice], [true, false], 'the reminder stays after Later');
  // a cancelled or failed update changes nothing: the same status, the same reminder
  assert.deepEqual([(await view()).needsUpdate, (await view()).notice], [true, false]);
  // another older version later: the notice again
  status = { ...status, version: '6' };
  assert.equal((await view()).notice, true);
  // unverifiable: a pair of its own
  status = { installed: true, running: true, version: null, current: false, compat: 'unverifiable' };
  assert.deepEqual([(await view()).needsUpdate, (await view()).notice], [true, true]);
  await ch['service:later'].run();
  assert.equal(stored.serviceLater, `unknown>${CURRENT}`);
  // stopped: the reminder, no notice (it can't be checked, nothing runs on it)
  status = { installed: true, running: false, version: null, current: false, compat: 'stopped' };
  assert.deepEqual([(await view()).needsUpdate, (await view()).notice], [true, false]);
  // the updated service answers this version: no reminder, no notice
  status = { installed: true, running: true, version: CURRENT, current: true, compat: 'current' };
  assert.deepEqual([(await view()).needsUpdate, (await view()).notice], [false, false]);
  // "Later" with nothing to update stores nothing
  stored = {};
  await ch['service:later'].run();
  assert.equal(stored.serviceLater, undefined);
});

test("once a request was sent, a missing answer is 'noAnswer' (it may have run); never connecting is null", async () => {
  const { pipeOnce } = require(path.join(EL, 'privilege', 'pipe.cjs'));
  const real = net.connect;
  const fake = (events) => () => { const s = new EventEmitter(); Object.assign(s, { setEncoding() {}, write() {}, destroy() {} }); setImmediate(() => events(s)); return s; };
  try {
    net.connect = fake((s) => { s.emit('connect'); s.emit('close'); });
    assert.deepEqual(await pipeOnce('X', { op: 'clean' }), { ok: false, error: 'the connection closed without an answer', code: 'noAnswer' });
    net.connect = fake((s) => { s.emit('connect'); s.emit('error', Object.assign(new Error('pipe broke'), { code: 'EPIPE' })); });
    assert.deepEqual(await pipeOnce('X', { op: 'clean' }), { ok: false, error: 'pipe broke', code: 'noAnswer' });
    net.connect = fake((s) => { s.emit('connect'); });
    assert.deepEqual(await pipeOnce('X', { op: 'clean' }, { timeoutMs: 30 }), { ok: false, error: 'no answer in time', code: 'noAnswer' });
    net.connect = fake((s) => { s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })); });
    assert.equal(await pipeOnce('X', { op: 'clean' }), null);
  } finally { net.connect = real; }
});
