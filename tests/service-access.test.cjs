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
  // the current service answers its version (WIN-R03: it is asked first); no service answers nothing
  const version = { ok: true, data: { version: require(path.join(EL, 'service-version.cjs')) } };
  pipe.pipeCall = async (name, req) => { calls.push(['service', name, req.op]); return req.op === 'version' ? serviceAnswer && version : serviceAnswer; };
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
  assert.deepEqual(calls, [['service', 'TuneService', 'version'], ['service', 'TuneService', 'clean'], ['admin', 'clean']]);
});

test('an answer from the service is used as it is; no service means the admin session', async () => {
  let { service, calls } = withFakes({ ok: true, data: { freed: 0 } });
  assert.deepEqual(await service.privileged({ op: 'clean', keys: [] }), { ok: true, data: { freed: 0 }, via: 'service' });
  assert.deepEqual(calls.map((c) => c[0]), ['service', 'service']);
  ({ service, calls } = withFakes({ ok: false, error: 'another change is running', code: 'busy' }));
  assert.equal((await service.privileged({ op: 'clean', keys: [] })).code, 'busy', 'busy is not a reason to ask for elevation');
  assert.deepEqual(calls.map((c) => c[0]), ['service', 'service']);
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
  assert.match(cs, /TerminateJobObject\(c\.Job, 1\)/);
  assert.match(cs, /"timedOut"/);
  // the console run's shorter limit can't reach the installed service (it only exists with --console)
  const start = cs.slice(cs.indexOf('internal static void Start('), cs.indexOf('public TuneService()'));
  assert.ok(start.indexOf('--op-seconds') > start.indexOf('args[0] == "--console"') && start.indexOf('--op-seconds') < start.indexOf('Run(new TuneService())'));
});

// WIN-R02 (static; the Windows behaviour is scripts/ci/service-containment-check.ps1): nothing of an
// operation runs before it is in its job, every native step's result is checked, and the next change
// waits for a confirmed end.
test('the service: an operation runs only once it is contained, and its end is confirmed', () => {
  const cs = fs.readFileSync(path.join(__dirname, '..', 'service', 'TuneService.cs'), 'utf8');
  const contain = cs.slice(cs.indexOf('string Contain('), cs.indexOf('static int ActiveProcesses('));
  const run = cs.slice(cs.indexOf('void RunOperation('), cs.indexOf('// Lines from the operation'));
  const at = (src, s) => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i; };
  // created suspended, then put in the job (checked); resumed only in RunOperation, after Contain succeeded
  assert.match(contain, /CreateProcess\(ps, command, IntPtr\.Zero, IntPtr\.Zero, true, CreateSuspended \| CreateNoWindow/);
  assert.ok(at(contain, 'CreateJobObject(') < at(contain, 'SetInformationJobObject(') && at(contain, 'SetInformationJobObject(') < at(contain, 'CreateProcess('));
  assert.ok(at(contain, 'CreateProcess(') < at(contain, '!AssignProcessToJobObject(c.Job, c.Process)'));
  assert.doesNotMatch(contain, /ResumeThread/, 'nothing is let run while being contained');
  for (const step of ['c.Job == IntPtr.Zero) return Refused', '!SetInformationJobObject(', '!CreatePipe(', '!CreateProcess(', '!AssignProcessToJobObject(']) at(contain, step);
  // the shipped build reports Windows' own error for each refusal
  assert.match(cs, /#else[\s\S]{0,200}static int ErrorOf\(string step\) \{ return Marshal\.GetLastWin32Error\(\); \}\s+#endif/);
  assert.ok(at(run, 'Contain(line, out c)') < at(run, 'if (refused != null)') && at(run, 'if (refused != null)') < at(run, 'ResumeThread(c.Thread) == NoResume'));
  assert.match(run, /"containmentFailed"/);
  // termination is asked for with its result kept, and confirmed by the job's own count
  assert.match(cs, /bool asked = Fault\("terminate"\) \? false : c\.InJob \? TerminateJobObject\(c\.Job, 1\) : TerminateProcess\(c\.Process, 1\);\s+if \(!asked\) c\.Error = ErrorOf\("terminate"\);/);
  assert.match(cs, /return Exited\(c\.Process\) && \(!c\.InJob \|\| ActiveProcesses\(c\.Job\) == 0\);/);
  assert.match(run, /if \(ended\) c\.Close\(\); else Remember\(c\);/, 'an unconfirmed end is kept, never forgotten');
  // the next change first settles what wasn't confirmed, and hears "busy" while anything is left
  const serve = cs.slice(cs.indexOf('void Serve('), cs.indexOf('static string ReadLine('));
  assert.ok(at(serve, 'Monitor.TryEnter(opLock') < at(serve, 'SettleUnconfirmed()') && at(serve, 'SettleUnconfirmed()') < at(serve, 'RunOperation(line, writer, limitMs)'));
  // fault injection exists only in the test build (TUNE_FAULTS), parsed only on the console command line
  const seam = cs.slice(cs.indexOf('#if TUNE_FAULTS', cs.indexOf('string Contain(') - 4000), cs.indexOf('sealed class Contained'));
  assert.ok(at(seam, 'static string fault;') < at(seam, '#else') && at(seam, '#else') < at(seam, 'static bool Fault(string step) { return false; }') && at(seam, '#endif'));
  assert.equal((cs.match(/static string fault;/g) || []).length, 1);
  const start = cs.slice(cs.indexOf('internal static void Start('), cs.indexOf('public TuneService()'));
  assert.match(start, /#if TUNE_FAULTS\s+if \(args\[i\] == "--fault"\) fault = args\[i \+ 1\];\s+#endif/);
  const build = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-service.cjs'), 'utf8');
  assert.match(build, /compile\(path\.join\(out, 'TuneService\.exe'\)\);/, 'the shipped service is compiled without TUNE_FAULTS');
});

test('the service version moved with the service code', () => {
  assert.equal(require(path.join(EL, 'service-version.cjs')), '8');
});
