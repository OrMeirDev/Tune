// Tune's performance center and CPU & memory pages, in Hebrew and English, at the smallest and a
// typical window size. Never reaches the real Tune service: every pipe connection is refused, and
// the live CPU readings are sample values (the installed service is still version 3).
const net = require('net');
const realConnect = net.connect;
// The pipe looks like a service that isn't installed: the connection fails, nothing is sent.
const { EventEmitter } = require('events');
net.connect = (...a) => {
  if (!String(a[0]).includes('pipe')) return realConnect(...a);
  const fake = new EventEmitter();
  Object.assign(fake, { setEncoding() {}, write() {}, destroy() {} });
  setImmediate(() => fake.emit('error', Object.assign(new Error('blocked in test'), { code: 'ECONNREFUSED' })));
  return fake;
};
const { app, BrowserWindow, screen } = require('electron');
// windows open on the second monitor, out of the way
const toSecondScreen = (w) => { const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) w.setPosition(d.workArea.x + 40, d.workArea.y + 40); };
const path = require('path');
const fs = require('fs');
const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const tune = APP_DIR;
const out = OUT_DIR;
app.on('window-all-closed', () => {});
// a throwaway profile, so no zoom level or window state is carried over from earlier runs
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'tune-center-')));

const sys = require(path.join(tune, 'electron', 'system.cjs'));
let n = 0;
const sample = () => ({ cpuTempC: 61 + (n % 3), cpuPowerW: 118 + (n++ % 5), cpuVoltageV: 1.284, cpuClockMHz: 5500, cpuNote: null, powerLimits: { pl1W: 125, pl1On: true, pl2W: 200, pl2On: true } });
sys.sensors = async () => ({ ok: true, data: sample() });
const realPerf = sys.performance;
sys.performance = async () => { const r = await realPerf(); if (r.ok) Object.assign(r.data, sample()); return r; };
sys.serviceStatus = async () => ({ ok: true, data: { installed: true, running: true, version: '6', current: true, pawnio: '2.2.0' } });

const CHECK = `(() => {
  const scope = document.querySelector('.modal') || document.body;
  const runs = [];
  const clip = (el, b) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(hidden|clip|auto|scroll)/.test(s.overflowX + s.overflowY)) { const c = a.getBoundingClientRect(); b = { l: Math.max(b.l, c.left), t: Math.max(b.t, c.top), r: Math.min(b.r, c.right), b: Math.min(b.b, c.bottom) }; } } return b; };
  const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement; const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    const r = document.createRange(); r.selectNodeContents(n);
    for (const rect of r.getClientRects()) { if (rect.width < 2) continue; const box = clip(el, { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }); if (box.r - box.l > 2 && box.b - box.t > 2) runs.push({ el, box, text: n.textContent.trim().slice(0, 28) }); }
  }
  for (const el of scope.querySelectorAll('button, .pill, .stat, input, select, .score')) { const c = el.getBoundingClientRect(); if (c.width < 3) continue; const box = clip(el, { l: c.left + 1, t: c.top + 1, r: c.right - 1, b: c.bottom - 1 }); if (box.r - box.l > 2 && box.b - box.t > 2) runs.push({ el, box, text: '[' + (el.className || el.tagName).toString().split(' ')[0] + ']' }); }
  const o = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) { const a = runs[i], b = runs[j]; if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue; const x = Math.min(a.box.r, b.box.r) - Math.max(a.box.l, b.box.l), y = Math.min(a.box.b, b.box.b) - Math.max(a.box.t, b.box.t); if (x > 3 && y > 3) o.push(a.text + ' <> ' + b.text); }
  return { overlaps: [...new Set(o)].slice(0, 10), pageScroll: document.querySelector('.main').scrollHeight > document.querySelector('.main').clientHeight + 2, wide: document.documentElement.scrollWidth > innerWidth + 1, sideScroll: document.querySelector('.sidebar').scrollHeight > document.querySelector('.sidebar').clientHeight + 2 };
})()`;

const failures = [];
const check = (name, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got)})` : ''}`); if (!cond) failures.push(name); };
const finish = () => { console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED'); app.exit(failures.length ? 1 : 0); };

app.whenReady().then(async () => {
  require(path.join(tune, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => app.exit(1), 420000);
  await wait(2500);
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setZoomFactor(1); win.show(); win.focus();
  const js = (c) => win.webContents.executeJavaScript(c);
  const shot = async (name) => { win.webContents.invalidate(); await wait(300); fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG()); };
  const nav = (id) => js(`[...document.querySelectorAll('.nav-item')][${JSON.stringify(id)}]?.click()`);
  // Wait for the first full scan to finish (sidebar stops saying "scanning").
  for (let i = 0; i < 150 && await js(`!!document.querySelector('.dot-off')`); i++) await wait(1000);
  console.log('SCAN DONE');
  for (const lang of ['he', 'en']) {
    // Switch language the way a user does: Settings → the language buttons.
    await js(`[...document.querySelectorAll('.nav-item')].at(-1).click()`); await wait(500);
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(lang === 'he' ? 'עברית' : 'English')})?.click()`); await wait(800);
    for (const [w, h] of [[1347, 852], [980, 640]]) {
      win.setContentSize(w, h); toSecondScreen(win); await wait(700);
      const navs = await js(`[...document.querySelectorAll('.nav-item')].map((b) => b.textContent)`);
      const idx = (re) => navs.findIndex((t) => re.test(t));
      for (const [label, re] of [['center', /מרכז ביצועים|Performance center/], ['perf', /מעבד וזיכרון|CPU & memory/], ['overview', /סקירה|Overview/], ['diagnose', /פתרון בעיה|Fix a problem/]]) {
        await nav(idx(re)); await wait(2600);
        // the diagnosis page with a problem picked (reads Windows' start-up records; read only)
        if (label === 'diagnose') { await js(`document.querySelector('.problem')?.click()`); await wait(12000); }
        const r = await js(CHECK);
        check(`${lang} ${w}x${h} ${label}: no overlap, no page/sidebar scroll, nothing sideways`, !r.pageScroll && !r.wide && !r.sideScroll && !r.overlaps.length, r.overlaps.length ? r.overlaps : undefined);
        await shot(`tune-${lang}-${w}-${label}.png`);
      }
      // the channels guide
      await nav(idx(/מרכז ביצועים|Performance center/)); await wait(800);
      const opened = await js(`(() => { const b = [...document.querySelectorAll('.drow')].find((r) => /ערוצי זיכרון|Memory channels/.test(r.textContent))?.querySelector('button'); if (b) b.click(); return !!b; })()`);
      await wait(500);
      const g = await js(CHECK);
      check(`${lang} ${w}x${h} guide${opened ? '' : ' (not offered on this PC)'}: no overlap`, !g.overlaps.length, g.overlaps.length ? g.overlaps : undefined);
      await shot(`tune-${lang}-${w}-guide.png`);
      await js(`document.querySelector('.modal .icon-btn')?.click()`); await wait(300);
    }
  }
  finish();
});
