// Audit TUN-01 (who may ask the LocalSystem service to change the PC) and TUN-06 (deadlines), as far
// as they can be checked off Windows: the app's side of a refusal, and the shape of the service's
// rules in service/TuneService.cs. The service itself is exercised on the Windows CI runner
// (scripts/ci/service-probe.cjs: an administrator and a standard user against the installed service;
// a silent client, a half-sent request and a hung operation against a console copy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EL = path.join(__dirname, '..', 'electron', 'privilege');

// service.cjs with its pipe and admin-session calls replaced by recorders
function withFakes(serviceAnswer) {
  const calls = [];
  const pipe = require(path.join(EL, 'pipe.cjs'));
  const admin = require(path.join(EL, 'admin-session.cjs'));
  const real = { pipeCall: pipe.pipeCall, adminCall: admin.adminCall };
  pipe.pipeCall = async (name, req) => { calls.push(['service', name, req.op]); return serviceAnswer; };
  admin.adminCall = async (req) => { calls.push(['admin', req.op]); return { ok: true, data: 'via admin' }; };
  delete require.cache[require.resolve(path.join(EL, 'service.cjs'))];
  const service = require(path.join(EL, 'service.cjs'));
  Object.assign(pipe, { pipeCall: real.pipeCall });
  Object.assign(admin, { adminCall: real.adminCall });
  delete require.cache[require.resolve(path.join(EL, 'service.cjs'))];
  return { service, calls };
}

test("a user the service refuses (not an administrator) gets Windows' own prompt instead", async () => {
  const { service, calls } = withFakes({ ok: false, error: 'only an administrator of this PC can ask the Tune service to change it', code: 'notAllowed' });
  const r = await service.privileged({ op: 'clean', keys: ['userTemp'] });
  assert.deepEqual(r, { ok: true, data: 'via admin' });
  assert.deepEqual(calls, [['service', 'TuneService', 'clean'], ['admin', 'clean']]);
});

test('an answer from the service is used as it is; no service means the admin session', async () => {
  let { service, calls } = withFakes({ ok: true, data: { freed: 0 } });
  assert.deepEqual(await service.privileged({ op: 'clean', keys: [] }), { ok: true, data: { freed: 0 }, via: 'service' });
  assert.deepEqual(calls.map((c) => c[0]), ['service']);
  ({ service, calls } = withFakes({ ok: false, error: 'another change is running', code: 'busy' }));
  assert.equal((await service.privileged({ op: 'clean', keys: [] })).code, 'busy', 'busy is not a reason to ask for elevation');
  assert.deepEqual(calls.map((c) => c[0]), ['service']);
  ({ service, calls } = withFakes(null));
  assert.deepEqual(await service.privileged({ op: 'restore' }), { ok: true, data: 'via admin' });
  assert.deepEqual(calls.map((c) => c[0]), ['service', 'admin']);
});

test('the service: read-only questions for everyone, changes only for administrators, with deadlines', () => {
  const cs = fs.readFileSync(path.join(__dirname, '..', 'service', 'TuneService.cs'), 'utf8');
  const serve = cs.slice(cs.indexOf('void Serve('), cs.indexOf('static string ReadLine('));
  const at = (s) => { const i = serve.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('ReadLine(pipe, RequestDeadlineMs)') < at('op == "version"'), 'the request line has a deadline');
  assert.ok(at('op == "sensors"') < at('CallerIsAdministrator(pipe)'), 'read-only answers need no check');
  assert.ok(at('CallerIsAdministrator(pipe)') < at('Monitor.TryEnter(opLock, OperationWaitMs)'), 'refused before waiting for the lock');
  assert.ok(at('Monitor.TryEnter(opLock, OperationWaitMs)') < at('RunOperation(line, writer, limitMs)'), 'one change at a time, without waiting forever');
  assert.match(serve, /"notAllowed"/);
  assert.match(serve, /"busy"/);
  assert.match(cs, /const int RequestDeadlineMs = 5000;/);
  assert.match(cs, /PipeOptions\.Asynchronous/, 'reads can be abandoned at the deadline');
  // the administrator check counts an enabled or a UAC "deny only" Administrators group, nothing else
  assert.match(cs, /new SecurityIdentifier\(WellKnownSidType\.BuiltinAdministratorsSid, null\)/);
  assert.match(cs, /!id\.IsAnonymous && HasGroup\(id\.Token, Administrators\)/);
  // every operation has a time limit, and a late one ends with everything it started
  for (const op of ['drivers', 'enable', 'clean', 'startup', 'hags', 'restore']) assert.match(cs, new RegExp(`\\{ "${op}", \\d+ \\}`), op);
  assert.match(cs, /KillOnJobClose = 0x2000/);
  assert.match(cs, /TerminateJobObject\(job, 1\)/);
  assert.match(cs, /"timedOut"/);
  // the console run's shorter limit can't reach the installed service (it only exists with --console)
  const start = cs.slice(cs.indexOf('internal static void Start('), cs.indexOf('public TuneService()'));
  assert.ok(start.indexOf('--op-seconds') > start.indexOf('args[0] == "--console"') && start.indexOf('--op-seconds') < start.indexOf('Run(new TuneService())'));
});

test('the service version moved with the service code', () => {
  assert.equal(require(path.join(EL, 'service-version.cjs')), '7');
});
