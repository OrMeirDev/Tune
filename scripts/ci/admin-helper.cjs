// Starts or stops one elevated admin helper on a disposable Windows CI runner, the way Tune starts its
// admin session (privilege/admin-session.cjs), but naming the account its pipe must also admit. With
// Windows' over-the-shoulder prompt a standard user's request runs elevated as an administrator's
// account; installer-check.ps1 uses this to check that the standard user then can (or, without the
// account named, can't) talk to the helper. Prints one JSON line.
//   start <TuneAdmin-pipe> <pid the helper serves> <account SID | none>
//   stop  <TuneAdmin-pipe>
const { adminHelper } = require('../../electron/privilege/admin-session.cjs');
const { startElevated } = require('../../electron/privilege/elevated.cjs');
const { pipeCall, wait } = require('../../electron/privilege/pipe.cjs');

if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') { console.log('runs only on a disposable CI runner'); process.exit(2); }
const [command, pipe, pid, sid] = process.argv.slice(2);
const print = (o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code); };
if (!/^TuneAdmin-[0-9a-z]+$/.test(pipe || '')) print({ ok: false, error: 'only an admin helper pipe (TuneAdmin-...)' }, 2);

(async () => {
  if (command === 'stop') return print(await pipeCall(pipe, { op: 'stop' }, { tries: 2, timeoutMs: 5000 }) || { ok: false, error: 'not running' });
  if (command !== 'start') return print({ ok: false, error: `unknown command ${command}` }, 2);
  const started = await startElevated(adminHelper(pipe, Number(pid), sid === 'none' ? null : sid));
  if (!started.ok) return print(started, 1);
  for (let i = 0; i < 200; i++) {
    const r = await pipeCall(pipe, { op: 'status' }, { tries: 1, timeoutMs: 5000 });
    if (r && r.ok) return print({ ok: true, pipe });
    await wait(150);
  }
  return print({ ok: false, error: 'the helper did not answer' }, 1);
})().catch((e) => print({ ok: false, error: String(e.stack || e) }, 1));
