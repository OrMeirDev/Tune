// Actual pipe/process integration on a disposable runner. Only an isolated console copy with a
// stand-in ops.ps1 is invoked; never the installed service or a real operation body.
if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('service-journal-check runs only on a disposable Windows CI runner');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRun } = require('../../e2e/harness.cjs');
const run = createRun({ exit: code => process.exit(code) });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-journal-ci-'));
const pipe = 'TuneJournalTest-' + randomBytes(6).toString('hex');
let child;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stop() {
  if (!child || child.exitCode !== null) return;
  const owned = child;
  owned.stdin.end('\n');
  for (let i = 0; i < 50 && owned.exitCode === null; i++) await delay(100);
  if (owned.exitCode === null) {
    owned.kill();
    for (let i = 0; i < 50 && owned.exitCode === null; i++) await delay(100);
  }
  if (owned.exitCode === null) throw new Error('owned console service did not stop');
}
run.onCleanup(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
run.timeout(120000);

function ask(req, disconnect = false) {
  if (!/^TuneJournalTest-[a-f0-9]{12}$/.test(pipe)) throw new Error('refuse any installed service pipe');
  return new Promise((resolve, reject) => {
    const sock = net.connect('\\\\.\\pipe\\' + pipe);
    let buf = '', done = false;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('test pipe request timed out')), 10000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('error', err => finish(err));
    sock.on('close', () => finish(new Error('test pipe closed without a result')));
    sock.on('data', data => {
      buf += data;
      for (let at; (at = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
        if (!line) continue;
        let value;
        try { value = JSON.parse(line); } catch (e) { return finish(e); }
        if (value.progress) { if (disconnect) return finish(null, { disconnected: true }); continue; }
        finish(null, value);
      }
    });
  });
}
async function start() {
  child = spawn(path.join(root, 'TuneService.exe'), ['--console', '--pipe', pipe, '--op-seconds', '30'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let error; child.on('error', e => { error = e; });
  child.stdout.on('data', () => {}); child.stderr.on('data', data => console.error(String(data).slice(0, 500)));
  for (let i = 0; i < 60; i++) {
    if (error) throw error;
    if (child.exitCode !== null) throw new Error('console service exited early: ' + child.exitCode);
    try { if ((await ask({ op: 'version' })).ok) return; } catch {}
    await delay(250);
  }
  throw new Error('console service did not become ready');
}
const count = () => fs.readFileSync(path.join(root, 'runs.txt'), 'utf8').trim().split(/\r?\n/).length;
const status = id => ask({ op: 'operationStatus', operationId: id });
run.guard(async () => {
  const bin = path.resolve('service/bin');
  for (const name of fs.readdirSync(bin))
    if (name !== 'ops.ps1' && fs.statSync(path.join(bin, name)).isFile()) fs.copyFileSync(path.join(bin, name), path.join(root, name));
  fs.writeFileSync(path.join(root, 'ops.ps1'), "param([string]$Request)\n$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json\nAdd-Content -LiteralPath (Join-Path $PSScriptRoot 'runs.txt') -Value 'ran'\n[Console]::Out.WriteLine('PROGRESS {\"phase\":\"test\"}')\n[Console]::Out.Flush()\nif ($req.wait) { Start-Sleep -Seconds 20 } else { Start-Sleep -Seconds 1 }\nif ($req.noResult) { exit }\n[Console]::Out.WriteLine('RESULT {\"ok\":true,\"data\":{\"restore\":\"created\",\"reboot\":true,\"results\":[{\"id\":\"sample\",\"code\":2}]}}')\n");
  await start();
  const req = { op: 'hags', operationId: randomUUID() };
  run.need('disconnect only after the stand-in began', (await ask(req, true)).disconnected);
  let result;
  for (let i = 0; i < 60; i++) {
    result = await status(req.operationId);
    if (result.data?.state === 'completed') break;
    await delay(200);
  }
  run.need('a disconnected client can recover the durable result', result.ok && result.data?.state === 'completed', result);
  run.check('per-driver result, restore point and reboot survive', result.data.result.data?.results?.[0]?.code === 2 && result.data.result.data.restore === 'created' && result.data.result.data.reboot === true);
  run.check('the stand-in ran exactly once', count() === 1, count());
  const replay = await ask(req);
  run.check('repeating the exact id returns the recorded result without running again', replay.ok && replay.operationId === req.operationId && count() === 1, replay);
  const conflict = await ask({ ...req, wait: true });
  run.check('reusing an id for different work is refused without execution', !conflict.ok && count() === 1, conflict);
  await stop(); await start();
  const recovered = await status(req.operationId);
  run.check('completed result survives service restart', recovered.ok && recovered.data?.state === 'completed' && count() === 1, recovered);
  const silent = { op: 'hags', operationId: randomUUID(), noResult: true };
  const noResult = await ask(silent);
  run.check('a process that changed something but lost its result stays unconfirmed', noResult.code === 'noAnswer' && (await status(silent.operationId)).data?.state === 'unknown', noResult);
  const interrupted = { op: 'hags', operationId: randomUUID(), wait: true };
  run.need('second stand-in accepted before restart', (await ask(interrupted, true)).disconnected);
  await stop(); await start();
  const pending = await status(interrupted.operationId);
  run.check('restart reports an interrupted operation without claiming a result', pending.ok && pending.data?.state === 'interrupted' && !pending.data?.result, pending);
  run.check('status reads never replay the interrupted operation', count() === 3, count());
});
