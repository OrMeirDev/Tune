// All ten pages, both languages and two window sizes, with synthetic data. Real renderer and IPC;
// every Windows read and change is replaced before main.cjs loads. No pipe request may escape.
const net = require('net');
const { EventEmitter } = require('events');
const realConnect = net.connect;
net.connect = (...args) => {
  if (!String(args[0]).includes('pipe')) return realConnect(...args);
  const socket = new EventEmitter();
  Object.assign(socket, { setEncoding() {}, write() {}, destroy() {} });
  setImmediate(() => socket.emit('error', new Error('pipe refused in ui-polish')));
  return socket;
};
const { app, BrowserWindow, shell, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createRun } = require('./harness.cjs');
const sample = require('./ui-samples.cjs');
const root = process.env.TUNE_UI_BASELINE_DIR || path.join(__dirname, '..');
const baseline = !!process.env.TUNE_UI_BASELINE_DIR;
const output = path.join(__dirname, 'output', 'ui-polish', baseline ? 'before' : 'after');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-ui-polish-'));
const downloads = path.join(profile, 'SAMPLE-Downloads');
fs.mkdirSync(downloads);
app.setPath('userData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const run = createRun({ exit: code => app.exit(code) });
run.onCleanup(() => {
  // Chromium holds some profile files until Electron exits on Windows (also see licensing.cjs).
  if (process.platform === 'win32') {
    spawn('node', ['-e', 'setTimeout(() => require("fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }), 3000)', profile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});
const at = '2026-10-20T09:00:00.000Z';
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ lang: 'en', sound: false, saveDir: downloads }));
fs.writeFileSync(path.join(profile, 'history.json'), JSON.stringify([
  { id: 'SAMPLE-startup', at, action: 'startup', detail: { name: 'SAMPLE utility', enabled: false } },
  { id: 'SAMPLE-setting', at, action: 'setting', detail: { key: 'gamemode' } },
]));
const { record } = require(path.join(root, 'electron/domain/measurement-policy.cjs'));
fs.writeFileSync(path.join(profile, 'measurements.json'), JSON.stringify([
  record({ metric: 'bootToDesktopMs', value: 31200, at, method: 'windowsBootLog', conditions: { startedAt: at, bootType: 'full' } }),
  record({ metric: 'restCpuLoad', value: 4, at, method: 'restSampling', conditions: { loadBand: 'rest', samples: 10 } }),
]));
const sys = require(path.join(root, 'electron/system.cjs'));
let failed = false;
const ok = data => ({ ok: true, data });
Object.assign(sys, {
  scanHardware: async () => ok(sample.hardware), driverUpdates: async () => ok(sample.updates),
  gpuVendorCheck: async () => ok(failed ? [{gpu:'AMD Radeon RX 7900 XTX',vendor:'AMD',status:'error',page:'https://www.amd.com/en/support/download/drivers.html',newer:false}] : sample.gpu), biosCheck: async () => ok(sample.bios),
  junkScan: async () => failed ? { ok: false, error: 'SAMPLE failed read' } : ok(sample.junk),
  startupList: async () => failed ? { ok: false, error: 'SAMPLE failed read' } : ok(sample.startup),
  recommendations: async () => ok(sample.recommendations), performance: async () => ok(sample.performance),
  sensors: async () => ok(sample.live()), adminStatus: async () => 0,
  serviceStatus: async () => ok({ installed: true, running: true, current: true, version: sys.SERVICE_VERSION, pawnio: '2.2.0' }),
  operationHistoryView: () => [], bootInfo: async () => ok({ timings: 'needsAdmin', current: {}, systemMedia: 'ssd', fastStartup: true }),
  diskFree: async () => ok({ drive: 'C:', freeBytes: 310e9, at: new Date().toISOString() }),
});
const changes = [];
for (const name of ['installDrivers', 'enableDevice', 'downloadGpuInstaller', 'downloadBios', 'junkClean', 'startupToggle', 'applyRecommendation', 'createRestorePoint', 'openSystemRestore', 'adminStart', 'adminStop', 'installService', 'uninstallService', 'restMeasure']) {
  sys[name] = async (...args) => { changes.push(name); return { ok: false, error: 'SAMPLE action: no machine change' }; };
}
shell.openExternal = async () => {};
shell.openPath = async () => '';
shell.showItemInFolder = () => {};
dialog.showSaveDialog = async () => ({ canceled: true });
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const routes = ['updates', 'hardware', 'diagnose', 'overview', 'clean', 'startup', 'perf', 'recs', 'history', 'settings'];
const errors = [];

run.guard(async () => {
  run.timeout(120000);
  await app.whenReady();
  require(path.join(root, 'electron/main.cjs'));
  let win;
  for (let i = 0; i < 200 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; if (!win) await wait(25); }
  run.need('app window opened', !!win);
  run.onCleanup(() => win.destroy());
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.on('render-process-gone', (_e, details) => errors.push(details.reason));
  const js = code => win.webContents.executeJavaScript(code);
  for (let i = 0; i < 100 && !await js(`document.querySelectorAll('.nav-item').length === 10 && !document.querySelector('.dot-off')`); i++) await wait(50);
  const go = async route => { await js(`document.querySelectorAll('.nav-item')[${routes.indexOf(route)}].click()`); await wait(650); };
  const screenshot = async name => {
    win.webContents.invalidate(); await wait(650);
    const image = await win.webContents.capturePage();
    run.need(`${name}: a real rendered frame`, !image.isEmpty() && image.getSize().width > 900);
    fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
  };
  const geometry = () => js(`(() => {
    const main=document.querySelector('.main'), side=document.querySelector('.sidebar'), nav=side.querySelector('nav'), selected=nav.querySelector('.active');
    const nb=nav.getBoundingClientRect(), ib=selected.getBoundingClientRect(), p=getComputedStyle(nav,'::before');
    const glassLeft=nb.left+nav.clientLeft+parseFloat(p.left)-nav.scrollLeft;
    const glassTop=nb.top+nav.clientTop+parseFloat(p.top)-nav.scrollTop;
    const aligned=Math.abs(glassLeft-ib.left)<1.5 && Math.abs(glassTop-ib.top)<1.5 && Math.abs(parseFloat(p.width)-ib.width)<1.5 && Math.abs(parseFloat(p.height)-ib.height)<1.5;
    const footer=side.querySelector('.sidebar-footer').getBoundingClientRect();
    const navFits=nav.scrollHeight<=nav.clientHeight+1 && [...nav.querySelectorAll('button')].every(e=>{const r=e.getBoundingClientRect();return r.top>=nb.top-1 && r.bottom<=Math.min(nb.bottom,footer.top)+1;});
    const visible=e=>{const d=e.closest('details:not([open])');return e.getClientRects().length && (!d || d.querySelector(':scope > summary').contains(e));};
    const clipped=[...main.querySelectorAll('button,summary,input,select')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.textContent.trim().slice(0,50));
    return {aligned,navFits,wide:document.documentElement.scrollWidth>innerWidth+1,main:main.scrollHeight>main.clientHeight+2,sidebar:side.scrollHeight>side.clientHeight+2,clipped};
  })()`);
  for (const lang of ['en', 'he']) {
    await go('settings');
    await js(`[...document.querySelectorAll('.segmented button')].find(b=>b.textContent.trim()===${JSON.stringify(lang === 'he' ? 'עברית' : 'English')}).click()`);
    await wait(120);
    run.check(`${lang}: language and reading direction`, await js(`document.documentElement.lang==='${lang}' && document.documentElement.dir==='${lang === 'he' ? 'rtl' : 'ltr'}'`));
    for (const [width, height] of [[1347,852], [980,640]]) {
      win.setContentSize(width,height); await wait(120);
      for (const route of routes) {
        await go(route);
        const g = await geometry();
        run.check(`${lang} ${width} ${route}: fits the window and controls`, !g.wide && !g.main && !g.sidebar && !g.clipped.length && g.aligned && g.navFits, g);
        if (width === 1347 || route === 'overview' || route === 'settings') await screenshot(`${lang}-${width}-${route}`);
      }
    }
    // Force the OS scrollbar even though the compact production menu does not need one.
    // This reproduces the RTL-only coordinate error independently of the spacing fix.
    await js(`document.querySelector('.sidebar nav').style.overflowY='scroll'`); await wait(150);
    await go('overview');
    const scrolled = await geometry();
    run.check(`${lang}: glass still aligns when a scrollbar is present`,scrolled.aligned,scrolled);
    await js(`document.querySelector('.sidebar nav').style.removeProperty('overflow-y')`); await wait(100);
  }
  run.check('browsing all pages never starts a machine change', changes.length === 0, changes);
  run.check('ten destinations remain accessible', await js(`document.querySelectorAll('.nav-item').length===10`));
  if (!baseline) {
    win.setContentSize(1347,852);
    for (const route of ['updates','hardware','startup','recs','perf','settings']) {
      await go(route);
      const result=await js(`(() => {
        const ds=[...document.querySelectorAll('.main details')];
        const result=ds.map(d=>{const s=d.querySelector('summary');s.click();const shown=d.open&&d.querySelector('.details-content').getBoundingClientRect().height>0;s.click();return shown&&!d.open;});
        return {count:ds.length,passed:result.every(Boolean)};
      })()`);
      run.check(`${route}: details open and close without losing content`, result.count>0 && result.passed, result);
      await js(`document.querySelector('.main summary').click()`);
      const expanded = await geometry();
      run.check(`${route}: expanded details fit the window`, !expanded.wide && !expanded.main && !expanded.clipped.length, expanded);
      await js(`document.querySelector('.main summary').click()`);
    }
    await go('startup');
    win.show(); win.focus(); win.webContents.focus();
    await js(`document.querySelector('summary').focus()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'}); await wait(100);
    run.check('details open with the keyboard', await js(`document.querySelector('details').open`));
    await js(`document.querySelector('summary').click()`);
    await js(`document.querySelector('[role="switch"]').click()`); await wait(120);
    run.check('startup switch still reaches its existing action', changes.includes('startupToggle'));
    await go('recs');
    await js(`document.querySelector('.drow .btn-primary').click()`); await wait(120);
    run.check('recommendation still reaches its existing action', changes.includes('applyRecommendation'));
    await go('updates');
    await js(`document.querySelector('.drow .btn-ghost').click()`); await wait(80);
    run.check('BIOS guide keeps its warning and download action', await js(`!!document.querySelector('.modal .warn-box') && !!document.querySelector('.modal .btn-primary')`));
    await js(`document.querySelector('.modal .btn-primary').click()`); await wait(100);
    run.check('BIOS download still reaches its existing action', changes.includes('downloadBios'));
    await js(`document.querySelector('.modal .icon-btn').click()`);
    await js(`[...document.querySelectorAll('.panel .drow')].find(r=>r.textContent.includes('Intel Wi-Fi')).querySelector('.acts button').click()`); await wait(100);
    run.check('individual driver install still reaches its existing action', changes.includes('installDrivers'));
    await js(`[...document.querySelectorAll('.panel .drow')].find(r=>r.textContent.includes('NVIDIA GeForce')).querySelector('.acts button').click()`); await wait(100);
    run.check('GPU installer still reaches its existing action', changes.includes('downloadGpuInstaller'));
    await js(`[...document.querySelectorAll('.panel .drow')].find(r=>r.textContent.includes('SAMPLE Bluetooth')).querySelector('.acts button').click()`); await wait(100);
    run.check('disabled device still reaches its existing action', changes.includes('enableDevice'));
    await go('hardware');
    await js(`document.querySelectorAll('.header-actions button')[0].click()`); await wait(100);
    await js(`document.querySelectorAll('.header-actions button')[1].click()`); await wait(100);
    const exported = fs.readdirSync(downloads);
    run.check('both hardware exports still produce their sample files', exported.some(p=>p.endsWith('.csv')) && exported.some(p=>p.endsWith('.txt')), exported);
    await go('clean');
    await js(`window.confirm=()=>true; document.querySelector('footer .btn-primary').click()`); await wait(100);
    run.check('selected cleanup still reaches its existing action', changes.includes('junkClean'));
    await go('history');
    await js(`document.querySelectorAll('.header-actions button')[0].click()`); await wait(100);
    await js(`document.querySelectorAll('.header-actions button')[1].click()`); await wait(100);
    run.check('restore point creation and System Restore remain accessible', changes.includes('createRestorePoint') && changes.includes('openSystemRestore'));
  }
  // A failed fresh scan must leave the old figures historical, never turn them into a healthy zero.
  failed=true; await go('updates');
  await js(`document.querySelector('header .btn-primary').click()`); await wait(250);
  run.check('failed GPU check makes the sidebar status incomplete, never green',await js(`!!document.querySelector('.sidebar-footer .dot-warning') && !document.querySelector('.sidebar-footer').textContent.includes('הסריקה הושלמה')`));
  await go('overview');
  run.check('failed cleanup and startup are not presented as current values', await js(`[...document.querySelectorAll('.ohead')].slice(0,2).every(e=>e.textContent.includes('—'))`));
  await screenshot('he-failed-overview');
  await go('diagnose'); await js(`document.querySelector('.problem').click()`); await wait(200);
  run.check('administrator-only boot reading stays not checked and historical', await js(`!!document.querySelector('.dx-row .c-historical') && !!document.querySelector('.dx-row .c-unknown')`));
  await screenshot('he-boot-history');
  run.check('no renderer errors', errors.length===0, errors);
});
