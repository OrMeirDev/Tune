// WIN-R03 in the real app: an older background service (version 7) answers on the pipe, as after an
// automatic update of Tune. Nothing here reaches a real pipe or Windows' approval prompt: the service
// pipe is a stand-in in this process that answers like the old service and records every request,
// the admin session is a stand-in that records what reaches it, and installing the service is a
// stand-in whose outcome each step sets. Nothing on the PC changes.
// 1) at start: the notice names both versions; nothing asks for approval or installs by itself
// 2) a change requested straight from the window goes to the admin session, never to the old service;
//    read-only requests (sensors) still go to it
// 3) "Later": the notice closes and stays closed after a reload (remembered for this pair of versions);
//    Settings keeps the reminder
// 4) Update, cancelled at the prompt: Settings says so, the reminder stays, Settings stays usable
// 5) Update that fails: said with its reason; the reminder stays
// 6) Update that works: once version 8 answers, the reminder and the notice are gone and changes go to
//    the service
// 7) another old version later (6): the notice again, in Hebrew, right to left; Escape is "Later"
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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRun } = require('./harness.cjs');
const { createCapture } = require('./capture.cjs');

const APP_DIR = path.join(__dirname, '..');
const PRIV = path.join(APP_DIR, 'electron', 'privilege');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-service-update-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});

// ---- stand-ins, set before the app's modules load (they take these functions when they load) ----
const svc = { version: '7', requests: [] };
const pipe = require(path.join(PRIV, 'pipe.cjs'));
pipe.pipeCall = async (name, req) => {
  if (name !== 'TuneService') return null;
  svc.requests.push(req.op);
  if (req.op === 'version') return { ok: true, data: { version: svc.version, pawnio: null, cpuVendor: 'GenuineIntel' } };
  if (req.op === 'sensors') return { ok: false, error: 'no sensors in this test' };
  return { ok: true, data: req.op === 'restore' ? 'created' : null };
};
const admin = require(path.join(PRIV, 'admin-session.cjs'));
const adminCalls = [];
admin.adminCall = async (req) => { adminCalls.push(req.op); return { ok: true, data: req.op === 'restore' ? 'created' : null }; };
admin.adminStart = async () => ({ ok: false, error: 'not in this test' });
admin.adminStatus = () => 0;
admin.adminStop = () => {};
const service = require(path.join(PRIV, 'service.cjs'));
let installs = 0;
let installOutcome = null;
service.installService = async () => { installs++; return installOutcome(); };

const run = createRun({ exit: (code) => app.exit(code) });
const { check, need } = run;
// the app's Chromium profile is held open until it exits: a small process removes it afterwards
run.onCleanup(() => require('child_process').spawn('node', ['-e', 'setTimeout(() => require("fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }), 3000)', profile], { detached: true, stdio: 'ignore', windowsHide: true }).unref());
const savedLater = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).serviceLater || null; } catch { return null; } };

run.guard(async () => {
  run.timeout(180000);
  await app.whenReady();
  require(path.join(APP_DIR, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(20);
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) errors.push(message); });
  const js = (c) => win.webContents.executeJavaScript(c).catch((e) => `JS-ERR ${e.message}`);
  const ready = async () => { while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50); };
  win.setContentSize(1347, 852); win.show(); win.focus(); win.webContents.focus();
  await ready();
  win.webContents.setZoomFactor(1);
  const shot = createCapture({ win, outDir: OUT_DIR, run });
  const until = async (fn, ok, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (ok(v)) return v; await wait(150); } return v; };
  const notice = () => js(`(() => { const m = document.querySelector('.service-notice'); return m ? { text: m.innerText, focus: document.activeElement?.textContent?.trim() || null, dir: getComputedStyle(m).direction } : null; })()`);
  const card = () => js(`(() => { const b = [...document.querySelectorAll('.setting')].find((s) => /Background service|שירות רקע/.test(s.querySelector('.setting-title')?.textContent || '')); return b ? { text: b.innerText, buttons: [...b.querySelectorAll('button')].map((x) => ({ t: x.textContent.trim(), disabled: x.disabled })) } : null; })()`);
  const settings = () => js(`[...document.querySelectorAll('.nav-item')].at(-1).click()`);
  const clickIn = (sel, text) => js(`[...document.querySelectorAll('${sel} button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);

  // 1) at start
  let n = await until(notice, (v) => !!v);
  need('1 the notice appears for the older service', !!n, n);
  check('1 it names the installed and the needed version', /version 7/.test(n.text) && /version 8/.test(n.text), n.text);
  check("1 it says changes go through Windows' prompt meanwhile, and that the old service stays reachable until updated", /approval prompt/.test(n.text) && /other programs on this PC can still ask it/.test(n.text), n.text);
  // the dialog moves focus in once it has mounted
  n = await until(notice, (v) => v && v.focus === 'Update', 5000);
  check('1 focus starts on Update', n?.focus === 'Update', n?.focus);
  check('1 nothing asked for approval or installed by itself', installs === 0 && adminCalls.length === 0, { installs, adminCalls });
  await shot('1-en-notice.png');

  // 2) a change straight from the window, and a read-only request
  const before = svc.requests.length;
  const rp = await js('window.tune.createRestorePoint()');
  const sent = svc.requests.slice(before);
  check('2 a change requested straight from the window goes to the admin session', rp?.ok === true && adminCalls.join() === 'restore', { rp, adminCalls });
  check('2 and never to the old service (it was only asked its version)', sent.length > 0 && sent.every((op) => op === 'version'), sent);
  await js('window.tune.sensors()');
  check('2 read-only requests still go to it (sensors)', svc.requests.includes('sensors'), svc.requests.slice(-3));

  // 3) Later
  await clickIn('.service-notice', 'Later');
  n = await until(notice, (v) => !v);
  check('3 Later closes the notice', !n, n);
  check('3 the main process remembers Later for this pair of versions', savedLater() === '7>8', savedLater());
  win.webContents.reload();
  await ready();
  await wait(2500);
  check('3 after a reload the notice stays closed', !(await notice()));
  await settings();
  let c = await until(card, (v) => v && /version 7; this Tune needs version 8/.test(v.text));
  need('3 Settings keeps the reminder', /version 7; this Tune needs version 8/.test(c?.text || ''), c?.text);
  await shot('3-en-settings-reminder.png');

  // 4) Update, cancelled at the prompt
  installOutcome = () => ({ ok: false, error: 'cancelled' });
  await clickIn('.setting', 'Update & start');
  c = await until(card, (v) => v && /cancelled at the approval prompt/.test(v.text));
  check('4 cancelled: Settings says so and the previous service is unchanged', /cancelled at the approval prompt/.test(c?.text || '') && /unchanged/.test(c.text), c?.text);
  check('4 the reminder stays', /version 7; this Tune needs version 8/.test(c?.text || ''), c?.text);
  check('4 Settings stays usable (its buttons are enabled)', c?.buttons.length >= 2 && c.buttons.every((b) => !b.disabled), c?.buttons);
  check('4 the update ran only because of the click', installs === 1, installs);

  // 5) Update that fails
  installOutcome = () => ({ ok: false, error: 'the new background service did not start; the previous version was restored' });
  await clickIn('.setting', 'Update & start');
  c = await until(card, (v) => v && /didn't finish/.test(v.text));
  check('5 failed: said with its reason; the reminder stays', /didn't finish \(the new background service did not start; the previous version was restored\)/.test(c?.text || '') && /needs version 8/.test(c.text), c?.text);

  // 6) Update that works
  installOutcome = () => { svc.version = '8'; return { ok: true, data: { service: 'TuneService', version: '8', pawnio: 'present' } }; };
  await clickIn('.setting', 'Update & start');
  c = await until(card, (v) => v && !/needs version 8/.test(v.text) && !/didn't finish|cancelled/.test(v.text));
  check('6 once version 8 answers, the reminder and the last failure are gone', !!c && !/needs version 8|didn't finish|cancelled|newer service version/.test(c.text), c?.text);
  check('6 the notice is not shown for the current service', !(await notice()));
  const chip = await js(`document.querySelector('.admin-chip')?.textContent.trim()`);
  check('6 the sidebar says the service is on', /service/i.test(chip || '') && !/update/i.test(chip || ''), chip);
  const mark = svc.requests.length;
  await js('window.tune.createRestorePoint()');
  check('6 a change now goes to the (current) service, not the admin session', svc.requests.slice(mark).includes('restore') && adminCalls.length === 1, { sent: svc.requests.slice(mark), adminCalls });
  await shot('6-en-updated.png');

  // 7) another older version later: the notice again, in Hebrew
  svc.version = '6';
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'עברית')?.click()`);
  await wait(500);
  win.webContents.reload();
  await ready();
  n = await until(notice, (v) => !!v);
  check('7 a new pair of versions shows the notice again', !!n && /6/.test(n.text) && /8/.test(n.text), n?.text);
  check('7 Hebrew, right to left', n?.dir === 'rtl' && /עדכון שירות הרקע/.test(n.text) && /אחר כך/.test(n.text), n);
  await shot('7-he-notice.png');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  n = await until(notice, (v) => !v);
  check('7 Escape closes it as "Later" (remembered for 6>8)', !n && savedLater() === '6>8', savedLater());
  check('7 still nothing installed without a click', installs === 3, installs);

  check('no renderer errors', errors.length === 0, errors);
});
