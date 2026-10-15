// The admin session on a disposable Windows CI runner (audit TUN-02): it starts elevated from the
// command line alone (no script file in %TEMP%), answers over its own pipe, runs the fixed operations
// (two that change nothing: cleaning no category, switching a startup entry that doesn't exist), and
// stops when asked. The runner is an administrator, so Windows elevates without a prompt.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') { console.log('runs only on a disposable CI runner'); process.exit(2); }
const { adminStart, adminCall, adminStatus, adminStop } = require('../../electron/privilege/admin-session.cjs');
const { pipeCall, wait } = require('../../electron/privilege/pipe.cjs');

const failures = [];
const check = (name, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got).slice(0, 300)})` : ''}`);
  if (!cond) failures.push(name);
};
// every script file and tune-admin folder in the temp folder (where the old helper wrote its script)
const tempScripts = () => fs.readdirSync(os.tmpdir()).filter((n) => /\.ps1$/i.test(n) || /^tune-admin-/.test(n)).sort();
// the admin helpers' pipes that exist right now
const adminPipes = () => fs.readdirSync('\\\\.\\pipe\\').filter((n) => n.startsWith('TuneAdmin-'));

(async () => {
  const before = tempScripts();
  const started = await adminStart();
  check('the admin session starts (elevated, no prompt on the runner)', started.ok, started);
  const until = adminStatus();
  check('it reports when its 10 minutes end', until - Date.now() > 9 * 60 * 1000 && until - Date.now() <= 10 * 60 * 1000, until - Date.now());
  const clean = await adminCall({ op: 'clean', keys: [] }, { timeoutMs: 60000 });
  check('a fixed operation runs over the pipe (cleaning no category frees nothing)', clean.ok && clean.data && Number(clean.data.freed) === 0, clean);
  const refused = await adminCall({ op: 'startup', hive: 'HKLM', key: 'no-such-entry-tune-ci', enable: false });
  check("the operation's own checks still refuse (a startup entry that doesn't exist)", refused.ok === false && /unknown startup entry/.test(refused.error), refused);
  const unknown = await adminCall({ op: 'format-c' });
  check('an operation outside the fixed list is refused', unknown.ok === false && /unknown request/.test(unknown.error), unknown);
  const after = tempScripts();
  check('no script file or request folder was written to %TEMP%', JSON.stringify(after) === JSON.stringify(before), after.filter((n) => !before.includes(n)));
  // between two requests the helper briefly has no pipe instance (it makes a new one per connection)
  let open = adminPipes();
  for (let i = 0; i < 20 && open.length !== 1; i++) { await wait(150); open = adminPipes(); }
  check('one admin helper pipe while the session runs', open.length === 1, open);
  adminStop();
  for (let i = 0; i < 20 && adminPipes().length; i++) await wait(500);
  check('asked to stop, the helper ends and its pipe is gone', adminPipes().length === 0, adminPipes());
  const late = open.length ? await pipeCall(open[0], { op: 'status' }, { tries: 1, timeoutMs: 2000 }) : null;
  check('nothing answers on it any more', late === null, late);
  console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`FAIL unexpected error: ${e.stack || e}`); console.log('1 FAILED (stopped before the end)'); process.exit(1); });
