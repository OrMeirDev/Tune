// L02 in the real app: Tune's own licensing client against the licensing server PoC on this PC, with
// a throwaway profile, database and keys, and the service pipe refused. Typed with real keystrokes.
// 1) the licence row before activation; a direct request for a gated action is refused (enforcing
//    policy, set for this check only)
// 2) email -> 6-digit code -> Serial, by keyboard (focus moves to each field, Enter submits)
// 3) the licence row: active, package, dates, last check; the gated request now passes the gate
// 4) the server stops: "Check now" keeps the licence (signed expiry) and leaves the page usable; a
//    second "Check now" right away is answered without a request (the minimum gap), with the wait;
//    recovery without a server -> "isn't confirmed" (never "nothing changed") + Try again; server back
//    -> the same request recovers the licence
// 5) the owner releases this PC on the server: "Check now" shows it in the row (never "Active"), a
//    gated request is refused, and recovery brings the licence back
// 6) the clock alone changes the licence's state (set back, then corrected; Electron's own resume
//    event, no click): the open Settings row follows each time, and a gated request is refused while
//    the clock is behind
// 7) the same in Hebrew (right to left), Escape closes the dialog
// On Windows the profile is protected with DPAPI and the machine id is the PC's own. Elsewhere this
// uses the app's test-only storage and machine id (development builds only): a run off Windows does
// not prove DPAPI. Needs Node 22+ on PATH (for the PoC server). Nothing on the PC changes.
// It passes only when every step ran and no check failed (e2e/harness.cjs): an unexpected error or a
// timeout fails it, and the server and the throwaway folder are cleaned up either way.
// The main process's clock, moved by hand in steps 5 and 6 (Tune's licensing reads Date.now; set
// before main.cjs is loaded). The renderer and the PoC server keep the real time.
const realNow = Date.now;
let clockShift = 0;
Date.now = () => realNow() + clockShift;
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
const { app, BrowserWindow, screen, powerMonitor } = require('electron');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRun } = require('./harness.cjs');
const { recordPowerShell } = require('./ps-timing.cjs');

const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-licensing-e2e-'));
app.setPath('userData', path.join(work, 'profile'));
app.on('window-all-closed', () => {});

const run = createRun({ exit: (code) => app.exit(code) });
const { check, need } = run;
// how long the app's PowerShell questions took (the identity read among them), printed after step 1
const ps = recordPowerShell({ appDir: APP_DIR, now: realNow });
let server = null;
// Cleanup, last registered runs first: the server stops; its database and keys and Tune's licence
// file go at once (retried while the server's process lets go of them); the rest of the folder is
// the app's own Chromium profile, which the running app holds open (on Windows it can't be deleted
// yet), so a small process removes it after the app has exited.
run.onCleanup(() => spawn('node', ['-e', 'setTimeout(() => require("fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }), 3000)', work], { detached: true, stdio: 'ignore', windowsHide: true }).unref());
run.onCleanup(() => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, KEYS, path.join(work, 'profile', 'license.bin')]) fs.rmSync(f, { force: true, maxRetries: 20, retryDelay: 100 });
});
run.onCleanup(() => { if (server) server.kill(); });

// ---- the licensing server PoC, on a fixed free port (so it can be stopped and started again) ----
const DB = path.join(work, 'licensing.sqlite');
const KEYS = path.join(work, 'keys.json');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(APP_DIR, 'licensing', 'server.cjs')], { env: { ...process.env, NODE_NO_WARNINGS: '1', PORT: String(port), TUNE_LICENSING_DB: DB, TUNE_LICENSING_KEYS: KEYS }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('"listening"')) resolve(child); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
const stopServer = () => new Promise((r) => { server.once('exit', r); server.kill(); });
async function post(port, route, body, admin) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${admin}` } : {}) }, body: JSON.stringify(body) });
  return res.json();
}
// the 6-digit code from the PoC's outbox (its stand-in for email), read with Node outside the app
const activeDevice = () => execFileSync('node', ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); process.stdout.write(db.prepare("SELECT id FROM devices WHERE state = 'active'").get().id);`, DB], { env: { ...process.env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' });
// (the code itself is never printed); no message, or none with a code, is said as such
function mailCode(email) {
  const out = execFileSync('node', ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); const rows = db.prepare('SELECT body FROM outbox WHERE to_email = ? ORDER BY id DESC').all(process.argv[2]); const m = rows[0] && /\\b(\\d{6})\\b/.exec(rows[0].body); process.stdout.write(JSON.stringify({ rows: rows.length, code: m ? m[1] : null }));`, DB, email], { env: { ...process.env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' });
  const r = JSON.parse(out);
  if (!r.code) throw new Error(`no sign-in code for ${email} in the licensing server's outbox (${r.rows} message(s) to that address${r.rows ? ', the latest without a 6-digit code' : ''})`);
  return r.code;
}

run.guard(async () => {
  run.timeout(240000);
  const port = await freePort();
  server = await startServer(port);
  const keys = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
  const publicKey = crypto.createPublicKey(keys.signingKey).export({ type: 'spki', format: 'pem' });
  const order = await post(port, '/v1/admin/orders', { channel: 'reseller', planId: 'tune-pro', quantity: 1 }, keys.adminToken);
  const serial = order.units[0].code;
  Object.assign(process.env, {
    TUNE_LICENSING_URL: `http://127.0.0.1:${port}`,
    TUNE_LICENSING_PUBLIC_KEY: publicKey,
    TUNE_LICENSING_POLICY: 'enforce',
  });
  if (process.platform !== 'win32') {
    process.env.TUNE_TEST_PROTECTED_STORAGE = 'insecure-test-only';
    process.env.TUNE_TEST_MACHINE_ID = crypto.createHash('sha256').update('e2e-pc').digest('hex');
  }
  await app.whenReady();
  require(path.join(APP_DIR, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(20);
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (c) => win.webContents.executeJavaScript(c).catch((e) => `JS-ERR ${e.message}`);
  while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50);
  win.webContents.setZoomFactor(1); win.setContentSize(1347, 852);
  const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) win.setPosition(d.workArea.x + 40, d.workArea.y + 40);
  win.show(); win.focus(); win.webContents.focus();
  const shot = async (n) => { win.webContents.invalidate(); await wait(250); fs.writeFileSync(path.join(OUT_DIR, n), (await win.webContents.capturePage()).toPNG()); };
  const settings = () => js(`[...document.querySelectorAll('.nav-item')].at(-1).click()`);
  const lang = async (l) => { await settings(); await wait(300); await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(l === 'he' ? 'עברית' : 'English')})?.click()`); await wait(500); };
  // the row's own text and buttons (the dialog is rendered inside the row's element, so it is left out)
  const row = () => js(`(() => { const r = document.querySelector('.license-setting'); return r ? { text: r.firstElementChild.innerText, buttons: [...r.querySelectorAll(':scope > .header-actions button')].map((b) => ({ t: b.textContent.trim(), disabled: b.disabled })) } : null; })()`);
  const dialog = () => js(`(() => { const m = document.querySelector('.license-dialog'); return m ? { text: m.innerText, focus: document.activeElement?.id || document.activeElement?.tagName, dir: getComputedStyle(m).direction } : null; })()`);
  const until = async (fn, ok, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (ok(v)) return v; await wait(150); } return v; };
  // real keystrokes into the focused field, and Enter
  // (replacing what the focused field holds: a returning owner's email is filled in)
  const type = async (text) => { win.webContents.selectAll(); await wait(50); win.webContents.insertText(text); await wait(150); };
  const enter = async () => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); await wait(200); };
  const escape = async () => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await wait(300); };
  const click = (text) => js(`[...document.querySelectorAll('.license-setting > .header-actions button, .license-dialog button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);

  // 1) before activation. Licensing is ready when the row shows a state (not "Loading…") and offers
  //    activation; nothing after this runs until it is.
  const settingsAt = ps.since();
  await lang('en');
  const offersActivation = (v) => !!v && /Not activated/.test(v.text) && v.buttons.some((b) => b.t === 'Activate or recover' && !b.disabled);
  let r = await until(row, offersActivation);
  const ready = offersActivation(r);
  const rowReadyAt = ready ? ps.since() : null;
  // activation needs this PC's identity (on Windows a PowerShell and WMI read, slow on a busy runner):
  // wait for that read to end (it is ended after 30 s) rather than racing it
  const identity = () => js(`window.tune.licenseStatus().then((s) => s && s.data && s.data.identity)`);
  const id = await until(identity, (v) => v !== 'reading' && v !== 'notRead', 45000);
  console.log(`TIMING ${JSON.stringify({ settingsOpenedAt: settingsAt, rowReadyAt, identityKnownAt: id === 'ok' ? ps.since() : null, ...ps.summary() })}`);
  need('1 licensing is ready: the row says it is not activated and offers activation', ready, r);
  need("1 this PC's identity has been read (activation needs it)", id === 'ok', id);
  check('1 the row says the server is a development one', /development server/.test(r.text), r.text);
  // the storage the main process actually uses (not what a row that isn't ready leaves out)
  const st = await js(`window.tune.licenseStatus().then((s) => s && s.data && { available: s.data.available, storage: s.data.storage })`);
  const win32 = process.platform === 'win32';
  check('1 the storage is what this platform must use: DPAPI on Windows, the labelled test storage elsewhere', st?.available === true && st.storage === (win32 ? 'dpapi' : 'test') && (win32 ? !/Test storage/.test(r.text) : /Test storage/.test(r.text)), { st, text: r.text });
  const denied = await js(`window.tune.junkClean(['not-a-category'])`);
  check('1 a direct request for a gated action is refused without a licence', denied?.error === 'not entitled', denied);
  await shot('1-en-not-activated.png');

  // 2) owner verification and activation, by keyboard
  await click('Activate or recover');
  let m = await until(dialog, (v) => v && v.focus === 'lic-email');
  need('2 the dialog opens with focus in the email field', m?.focus === 'lic-email', m);
  await type('Owner@Example.com'); await enter();
  m = await until(dialog, (v) => v && v.focus === 'lic-code');
  need('2 a code is sent and focus moves to the code field', /code was sent/i.test(m?.text || '') && m.focus === 'lic-code', m);
  await type(mailCode('owner@example.com')); await enter();
  m = await until(dialog, (v) => v && v.focus === 'lic-serial');
  need('2 the email is verified and focus moves to the Serial', /Verified: owner@example\.com/.test(m?.text || '') && m.focus === 'lic-serial', m);
  await shot('2-en-serial.png');
  await type(serial.toLowerCase()); await enter();
  m = await until(dialog, (v) => v && /Tune is activated/.test(v.text));
  need('2 activated', /Tune is activated/.test(m?.text || ''), m);
  await shot('2-en-activated.png');
  await click('Done');

  // 3) the licence row
  r = await until(row, (v) => v && /Active\./.test(v.text));
  need('3 active, with the package, the dates and the last check', /Active\./.test(r?.text || '') && /tune-pro/.test(r.text) && /Valid on this PC until/.test(r.text) && /License until/.test(r.text) && /Last successful check/.test(r.text), r?.text);
  const passes = await js(`window.tune.junkClean(['not-a-category'])`);
  check('3 the gated request now passes the gate (and stops at the scan check: nothing runs)', passes?.error !== 'not entitled', passes);
  const nothingLeaks = await js(`window.tune.licenseStatus().then((s) => JSON.stringify(s))`);
  check('3 the window sees no token, key or certificate', !/ownerToken|PRIVATE KEY|signature|idempotency/.test(nothingLeaks), nothingLeaks.length);
  // On Windows the file is DPAPI-protected: nothing in it is readable (elsewhere it is the labelled
  // test storage, which proves nothing about DPAPI, so it isn't checked)
  if (process.platform === 'win32') {
    const stored = fs.readFileSync(path.join(work, 'profile', 'license.bin'));
    const body = stored.subarray('TUNE-LICENSE/1\n'.length).toString('latin1');
    const readable = ['PRIVATE KEY', 'tune-license', 'tune-pro', 'lic_', 'dev_', 'certificate', 'signature'].filter((x) => body.includes(x));
    check('3 Windows: license.bin is DPAPI-protected, nothing in it is readable', stored.subarray(0, 15).toString() === 'TUNE-LICENSE/1\n' && readable.length === 0, { bytes: stored.length, readable });
  }
  await shot('3-en-active.png');

  // 4) the server goes away
  await stopServer();
  await click('Check now');
  r = await until(row, (v) => v && /Last attempt without a connection/.test(v.text));
  check('4 no connection: the licence stays active on its signed expiry; the failed attempt is shown', /Active\./.test(r?.text || '') && /Last attempt without a connection/.test(r.text), r?.text);
  check('4 the page stays usable (nothing left busy)', r?.buttons.every((b) => !b.disabled), r?.buttons);
  const sent = r.text;
  await click('Check now');
  r = await until(row, (v) => v && /Try again in \d+ seconds/.test(v.text));
  check('4 a second "Check now" within a minute: answered here with the wait, the licence as it was', /Try again in \d+ seconds/.test(r?.text || '') && /^Active\./m.test(r.text) && r.text.includes(sent.split('\n').find((l) => /Last attempt without a connection/.test(l))), r?.text);
  check('4 the page stays usable after the deferral', r?.buttons.every((b) => !b.disabled), r?.buttons);
  await click('Activate or recover');
  await until(dialog, (v) => !!v);
  await click('Start over');
  m = await until(dialog, (v) => v && v.focus === 'lic-email');
  // a reinstall would do the same: recovery needs the owner verified again (the server is back for that)
  server = await startServer(port);
  await type('owner@example.com'); await enter();
  await until(dialog, (v) => v && v.focus === 'lic-code');
  await type(mailCode('owner@example.com')); await enter();
  await until(dialog, (v) => v && /Verified/.test(v.text));
  await stopServer();
  await click('Recover my license on this PC');
  m = await until(dialog, (v) => v && /isn't confirmed/.test(v.text));
  check("4 recovery without a server: not confirmed (never \"nothing changed\"), with Try again", /isn't confirmed/.test(m?.text || '') && !/nothing changed/i.test(m.text) && /Try again/.test(m.text), m?.text);
  await shot('4-en-unavailable.png');
  server = await startServer(port);
  await click('Try again');
  m = await until(dialog, (v) => v && /back on this PC/.test(v.text));
  check('4 server back: Try again recovers the same licence', /back on this PC/.test(m?.text || ''), m?.text);
  await click('Done');

  // 5) a release confirmed by the server (the owner, verified, through the server's API)
  const challenge = await post(port, '/v1/owner/challenge', { email: 'owner@example.com' });
  const verified = await post(port, '/v1/owner/verify', { challengeId: challenge.challengeId, code: mailCode('owner@example.com') });
  const released = await post(port, '/v1/device/release', { ownerToken: verified.ownerToken, deviceId: activeDevice() });
  check('5 the server released this PC', released.result === 'ok', released);
  // past the minimum gap since step 4's check, however long the steps between took
  clockShift = 61_000;
  await click('Check now');
  r = await until(row, (v) => v && /released from the license/.test(v.text));
  check('5 "Check now" shows the release in the row, not "Active"', /released from the license/.test(r?.text || '') && !/^Active\./m.test(r.text), r?.text);
  const deniedAfter = await js(`window.tune.junkClean(['not-a-category'])`);
  check('5 after the release a gated request is refused', deniedAfter?.error === 'not entitled', deniedAfter);
  await shot('5-en-released.png');
  await click('Activate or recover');
  m = await until(dialog, (v) => v && /Recover my license on this PC/.test(v.text));
  await click('Recover my license on this PC');
  m = await until(dialog, (v) => v && /back on this PC/.test(v.text));
  check('5 recovery the server approves makes this PC active again', /back on this PC/.test(m?.text || ''), m?.text);
  await click('Done');
  r = await until(row, (v) => v && /^Active\./m.test(v.text));
  check('5 the row is active again', /^Active\./m.test(r?.text || ''), r?.text);

  // 6) the clock alone changes the state: the row follows without a click
  clockShift = 61_000 - 60 * 60_000;
  powerMonitor.emit('resume');
  r = await until(row, (v) => v && /clock is set earlier/.test(v.text));
  check('6 the clock set back an hour: the open row says so, without a click', /clock is set earlier/.test(r?.text || '') && !/^Active\./m.test(r.text), r?.text);
  const deniedClock = await js(`window.tune.junkClean(['not-a-category'])`);
  check('6 while the clock is behind a gated request is refused', deniedClock?.error === 'not entitled', deniedClock);
  await shot('6-en-clock.png');
  clockShift = 61_000;
  powerMonitor.emit('resume');
  r = await until(row, (v) => v && /^Active\./m.test(v.text));
  check('6 the clock corrected: the row is active again, without a click', /^Active\./m.test(r?.text || '') && !/clock is set earlier/.test(r.text), r?.text);

  // 7) Hebrew, right to left
  await lang('he');
  r = await until(row, (v) => v && /פעיל\./.test(v.text));
  check('7 Hebrew: the licence row', /פעיל\./.test(r?.text || '') && /tune-pro/.test(r.text), r?.text);
  await js(`[...document.querySelectorAll('.license-setting > .header-actions button')].at(-1).click()`);
  m = await until(dialog, (v) => !!v);
  check('7 a new visit to the dialog does not repeat the earlier success', !/חזר למחשב הזה/.test(m?.text || '') && /התחל מחדש/.test(m.text), m?.text);
  await click('התחל מחדש');
  m = await until(dialog, (v) => v && v.focus === 'lic-email');
  check('7 Hebrew: the dialog is right to left and starts in the email field', m?.dir === 'rtl' && /הפעלת Tune/.test(m.text) && m.focus === 'lic-email', m);
  const overlap = await js(`(() => { const els = [...document.querySelectorAll('.license-dialog label, .license-dialog button, .license-dialog input, .license-dialog .dmeta')].map((e) => e.getBoundingClientRect()); const box = document.querySelector('.license-dialog').getBoundingClientRect(); return els.filter((r) => r.width && (r.left < box.left - 1 || r.right > box.right + 1)).length; })()`);
  check('7 Hebrew: nothing sticks out of the dialog', overlap === 0, overlap);
  await shot('7-he-dialog.png');
  await escape();
  check('7 Escape closes the dialog', !(await dialog()));
  await shot('7-he-settings.png');

  check('no renderer errors', errors.length === 0, errors);
});
