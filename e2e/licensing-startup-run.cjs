// One start of the real app with licensing configured and no licence stored (a new profile), run by
// e2e/licensing-startup.cjs as its own Electron process: how long the Settings licence row takes to be
// ready, and how long this PC's identity read takes (WIN-R01). Mode (argv):
//   real   the identity is read as it is (on Windows, PowerShell and WMI, with the app's own start-up
//          scans running); elsewhere a stand-in answers at once
//   slow   the identity answers only after IDENTITY_DELAY_MS (a stand-in for a slow start)
//   fail   the identity read fails (as when PowerShell is killed at its time limit)
// The delay and the failure are this harness's own stand-in for the read (ps-timing.cjs), never a
// setting of the app. Without a stored licence the identity can't change what the row says, so the
// row must not wait for it; the read itself must happen once (it is needed to activate), and a failed
// read must be reported as such. The service pipe is refused and nothing on the PC changes.
const net = require('net');
const { EventEmitter } = require('events');
const realConnect = net.connect;
net.connect = (...a) => {
  if (!String(a[0]).includes('pipe')) return realConnect(...a);
  const fake = new EventEmitter();
  Object.assign(fake, { setEncoding() {}, write() {}, destroy() {} });
  setImmediate(() => fake.emit('error', Object.assign(new Error('blocked in test'), { code: 'ECONNREFUSED' })));
  return fake;
};
const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRun } = require('./harness.cjs');
const { recordPowerShell } = require('./ps-timing.cjs');

const APP_DIR = path.join(__dirname, '..');
const MODE = process.argv.find((a) => ['real', 'slow', 'fail'].includes(a)) || 'real';
const IDENTITY_DELAY_MS = 20000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-licensing-start-'));
app.setPath('userData', path.join(work, 'profile'));
app.on('window-all-closed', () => {});

const run = createRun({ exit: (code) => app.exit(code) });
const { check, need } = run;
run.onCleanup(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const win32 = process.platform === 'win32';
// a GUID-shaped stand-in where there is no PowerShell (the real one is never printed)
const standIn = () => ({ ok: true, data: { machineGuid: crypto.randomUUID(), smbiosUuid: null } });
const ps = recordPowerShell({
  appDir: APP_DIR,
  hook: async (call, real) => {
    if (call.what !== 'identity') return real();
    if (MODE === 'fail') { await wait(1000); return { ok: false, error: 'no result (exit null)' }; }
    if (MODE === 'slow') await wait(IDENTITY_DELAY_MS);
    return win32 ? real() : standIn();
  },
});

run.guard(async () => {
  run.timeout(90000);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  Object.assign(process.env, {
    // configured, but nothing is sent at start without a licence (a closed local port)
    TUNE_LICENSING_URL: 'http://127.0.0.1:9',
    TUNE_LICENSING_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  if (!win32) process.env.TUNE_TEST_PROTECTED_STORAGE = 'insecure-test-only';
  await app.whenReady();
  require(path.join(APP_DIR, 'electron', 'main.cjs'));
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(20);
  const js = (c) => win.webContents.executeJavaScript(c).catch((e) => `JS-ERR ${e.message}`);
  while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50);
  const windowAt = ps.since();
  await js(`[...document.querySelectorAll('.nav-item')].at(-1).click()`);
  const settingsAt = ps.since();
  const row = () => js(`(() => { const r = document.querySelector('.license-setting'); return r ? { text: r.firstElementChild.innerText, buttons: [...r.querySelectorAll(':scope > .header-actions button')].map((b) => b.textContent.trim()) } : null; })()`);
  const ready = (v) => !!v && /Not activated/.test(v.text) && v.buttons.length > 0;
  const identityDone = () => ps.calls.some((c) => c.what === 'identity' && c.ms !== null);
  let r = await row();
  const end = Date.now() + 45000;
  while (!ready(r) && Date.now() < end) { await wait(100); r = await row(); }
  const rowReadyAt = ready(r) ? ps.since() : null;
  const identityPendingWhenReady = rowReadyAt !== null && !identityDone();
  // the identity read is wanted for activation: let it finish (its own limit is 30 s)
  for (let i = 0; i < 400 && !identityDone(); i++) await wait(100);
  await wait(300);
  const st = await js(`window.tune.licenseStatus().then((s) => s && s.data && { available: s.data.available, state: s.data.license && s.data.license.state, identity: s.data.identity })`);
  console.log(`TIMING ${JSON.stringify({ mode: MODE, windowAt, settingsAt, rowReadyAt, rowWaitMs: rowReadyAt === null ? null : rowReadyAt - settingsAt, ...ps.summary() })}`);

  need(`${MODE}: the licence row is ready (not activated, activation offered)`, ready(r), r);
  const ids = ps.calls.filter((c) => c.what === 'identity');
  check(`${MODE}: this PC's identity is read once, however many times the status is asked for`, ids.length === 1, ids.length);
  if (MODE === 'slow') check('slow: the row did not wait for the identity read (no licence stored)', identityPendingWhenReady, { rowReadyAt, identity: ps.summary().identity });
  if (MODE === 'fail') check('fail: a failed identity read is reported as unavailable (and the row still shows the state)', st && st.state === 'none' && st.identity === 'unavailable', st);
  else check(`${MODE}: afterwards the identity is known`, st && st.state === 'none' && st.identity === 'ok', st);
});
