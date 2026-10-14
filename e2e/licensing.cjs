// L02 in the real app: Tune's own licensing client against the licensing server PoC on this PC, with
// a throwaway profile, database and keys, and the service pipe refused. Typed with real keystrokes.
// 1) the licence row before activation; a direct request for a gated action is refused (enforcing
//    policy, set for this check only)
// 2) email -> 6-digit code -> Serial, by keyboard (focus moves to each field, Enter submits)
// 3) the licence row: active, package, dates, last check; the gated request now passes the gate
// 4) the server stops: "Check now" keeps the licence (signed expiry) and leaves the page usable;
//    recovery without a server -> "couldn't be reached" + Try again; server back -> recovered
// 5) the same in Hebrew (right to left), Escape closes the dialog
// On Windows the profile is protected with DPAPI and the machine id is the PC's own. Elsewhere this
// uses the app's test-only storage and machine id (development builds only): a run off Windows does
// not prove DPAPI. Needs Node 22+ on PATH (for the PoC server). Nothing on the PC changes.
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
const { app, BrowserWindow, screen } = require('electron');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-licensing-e2e-'));
app.setPath('userData', path.join(work, 'profile'));
app.on('window-all-closed', () => {});

const failures = [];
const check = (name, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got).slice(0, 300)})` : ''}`); if (!cond) failures.push(name); };
let server = null;
const finish = () => {
  console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
  if (server) server.kill();
  fs.rmSync(work, { recursive: true, force: true });
  app.exit(failures.length ? 1 : 0);
};

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
const mailCode = (email) => execFileSync('node', ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); const m = db.prepare('SELECT body FROM outbox WHERE to_email = ? ORDER BY id DESC').get(process.argv[2]); process.stdout.write(/\\b(\\d{6})\\b/.exec(m.body)[1]);`, DB, email], { env: { ...process.env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' });

(async () => {
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
  setTimeout(() => { console.log('FAIL timeout'); finish(); }, 240000);
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

  // 1) before activation
  await lang('en');
  let r = await until(row, (v) => v && /Not activated/.test(v.text));
  check('1 the licence row says it is not activated, and that the server is a development one', /Not activated/.test(r?.text || '') && /development server/.test(r.text), r);
  check('1 the storage is labelled for what it is', process.platform === 'win32' ? !/Test storage/.test(r.text) : /Test storage/.test(r.text), r?.text);
  const denied = await js(`window.tune.junkClean(['not-a-category'])`);
  check('1 a direct request for a gated action is refused without a licence', denied?.error === 'not entitled', denied);
  await shot('1-en-not-activated.png');

  // 2) owner verification and activation, by keyboard
  await click('Activate or recover');
  let m = await until(dialog, (v) => v && v.focus === 'lic-email');
  check('2 the dialog opens with focus in the email field', m?.focus === 'lic-email', m);
  await type('Owner@Example.com'); await enter();
  m = await until(dialog, (v) => v && v.focus === 'lic-code');
  check('2 a code is sent and focus moves to the code field', /code was sent/i.test(m?.text || '') && m.focus === 'lic-code', m);
  await type(mailCode('owner@example.com')); await enter();
  m = await until(dialog, (v) => v && v.focus === 'lic-serial');
  check('2 the email is verified and focus moves to the Serial', /Verified: owner@example\.com/.test(m?.text || ''), m);
  await shot('2-en-serial.png');
  await type(serial.toLowerCase()); await enter();
  m = await until(dialog, (v) => v && /Tune is activated/.test(v.text));
  check('2 activated', /Tune is activated/.test(m?.text || ''), m);
  await shot('2-en-activated.png');
  await click('Done');

  // 3) the licence row
  r = await until(row, (v) => v && /Active\./.test(v.text));
  check('3 active, with the package, the dates and the last check', /Active\./.test(r?.text || '') && /tune-pro/.test(r.text) && /Valid on this PC until/.test(r.text) && /License until/.test(r.text) && /Last successful check/.test(r.text), r?.text);
  const passes = await js(`window.tune.junkClean(['not-a-category'])`);
  check('3 the gated request now passes the gate (and stops at the scan check: nothing runs)', passes?.error !== 'not entitled', passes);
  const nothingLeaks = await js(`window.tune.licenseStatus().then((s) => JSON.stringify(s))`);
  check('3 the window sees no token, key or certificate', !/ownerToken|PRIVATE KEY|signature|idempotency/.test(nothingLeaks), nothingLeaks.length);
  await shot('3-en-active.png');

  // 4) the server goes away
  await stopServer();
  await click('Check now');
  r = await until(row, (v) => v && /Last attempt without a connection/.test(v.text));
  check('4 no connection: the licence stays active on its signed expiry; the failed attempt is shown', /Active\./.test(r?.text || '') && /Last attempt without a connection/.test(r.text), r?.text);
  check('4 the page stays usable (nothing left busy)', r?.buttons.every((b) => !b.disabled), r?.buttons);
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
  m = await until(dialog, (v) => v && /couldn't be reached/.test(v.text));
  check("4 recovery without a server: said plainly, with Try again", /couldn't be reached/.test(m?.text || '') && /Try again/.test(m.text), m?.text);
  await shot('4-en-unavailable.png');
  server = await startServer(port);
  await click('Try again');
  m = await until(dialog, (v) => v && /back on this PC/.test(v.text));
  check('4 server back: Try again recovers the same licence', /back on this PC/.test(m?.text || ''), m?.text);
  await click('Done');

  // 5) Hebrew, right to left
  await lang('he');
  r = await until(row, (v) => v && /פעיל\./.test(v.text));
  check('5 Hebrew: the licence row', /פעיל\./.test(r?.text || '') && /tune-pro/.test(r.text), r?.text);
  await js(`[...document.querySelectorAll('.license-setting > .header-actions button')].at(-1).click()`);
  m = await until(dialog, (v) => !!v);
  check('5 a new visit to the dialog does not repeat the earlier success', !/חזר למחשב הזה/.test(m?.text || '') && /התחל מחדש/.test(m.text), m?.text);
  await click('התחל מחדש');
  m = await until(dialog, (v) => v && v.focus === 'lic-email');
  check('5 Hebrew: the dialog is right to left and starts in the email field', m?.dir === 'rtl' && /הפעלת Tune/.test(m.text) && m.focus === 'lic-email', m);
  const overlap = await js(`(() => { const els = [...document.querySelectorAll('.license-dialog label, .license-dialog button, .license-dialog input, .license-dialog .dmeta')].map((e) => e.getBoundingClientRect()); const box = document.querySelector('.license-dialog').getBoundingClientRect(); return els.filter((r) => r.width && (r.left < box.left - 1 || r.right > box.right + 1)).length; })()`);
  check('5 Hebrew: nothing sticks out of the dialog', overlap === 0, overlap);
  await shot('5-he-dialog.png');
  await escape();
  check('5 Escape closes the dialog', !(await dialog()));
  await shot('5-he-settings.png');

  check('no renderer errors', errors.length === 0, errors);
  finish();
})().catch((e) => { console.log(`FAIL ${e.stack}`); finish(); });
