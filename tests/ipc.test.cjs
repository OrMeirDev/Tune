// The window -> main process connection (audit TUN-05): a request from anyone but Tune's own page,
// with the wrong shape, or pointing at something the main process didn't offer, is refused and
// runs nothing. Uses the real channel table with fake Windows operations that record every call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const V = require('../electron/ipc/validate.cjs');
const { isTrustedSender, dispatch, REFUSED, INVALID } = require('../electron/ipc/guard.cjs');
const { createOffers } = require('../electron/ipc/offers.cjs');
const { createChannels } = require('../electron/ipc/channels.cjs');

const PAGE = 'file:///C:/Program%20Files/Tune/resources/app.asar/dist/index.html';
const mainFrame = { url: PAGE };
const webContents = { mainFrame };
const ok = (data) => ({ ok: true, data });
const GUID1 = '11111111-2222-3333-4444-555555555555';
const GUID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// a world where the main process' own scans found these things
function world() {
  const calls = [];
  const rec = (name, result = ok('done')) => (...args) => { calls.push([name, ...args]); return Promise.resolve(result); };
  const sys = {
    scanHardware: rec('scanHardware', ok({ boardMaker: 'ASUSTeK', boardModel: 'PRIME Z790-P WIFI', bios: { version: '1836', date: '2025' }, gpus: [{ name: 'AMD Radeon RX 7900 XTX' }], amdSoftware: '25.1', problems: [{ id: 'USB\\VID_1234\\5', name: 'Bluetooth', code: 31 }] })),
    driverUpdates: rec('driverUpdates', ok([{ id: GUID1, title: 'Realtek audio' }])),
    gpuVendorCheck: rec('gpuVendorCheck', ok([{ gpu: 'AMD Radeon RX 7900 XTX', newer: true, url: 'https://drivers.amd.com/x.exe' }])),
    biosCheck: rec('biosCheck', ok({ supported: true, newer: true, maker: 'ASUS', latest: { version: '1901', url: 'https://dlcdnets.asus.com/b.zip', sha256: 'ab' } })),
    junkScan: rec('junkScan', ok([{ key: 'userTemp', dirs: ['C:\\Users\\x\\AppData\\Local\\Temp'] }])),
    startupList: rec('startupList', ok([{ source: 'HKCU', key: 'Discord', name: 'Discord' }])),
    recommendations: rec('recommendations', ok([{ key: 'power', ok: false }])),
    installDrivers: rec('installDrivers', ok({ reboot: false, restore: 'created' })),
    downloadGpuInstaller: rec('downloadGpuInstaller', ok('C:\\dl\\amd.exe')),
    downloadBios: rec('downloadBios', ok('C:\\dl\\b.zip')),
    enableDevice: rec('enableDevice'),
    junkClean: rec('junkClean', ok({ freed: 1, skipped: 0 })),
    startupToggle: rec('startupToggle'),
    applyRecommendation: rec('applyRecommendation'),
    diskFree: rec('diskFree', { drive: 'C:', freeBytes: 40e9 }),
    restMeasure: rec('restMeasure', ok([{ metric: 'restCpuLoad', value: 4 }])),
    bootInfo: rec('bootInfo', ok({ fastStartup: true, systemMedia: 'ssd', lastBootType: 'full', timings: 'ok', records: [{ metric: 'bootToDesktopMs', value: 20000 }] })),
  };
  const measured = [];
  const history = [];
  const opened = [];
  const d = {
    sys, offers: createOffers(), warmOr: (_k, fn) => fn(), progressTo: () => () => {},
    history: { add: (a, x) => { history.push([a, x]); return `id-${history.length}`; }, read: () => history },
    measurements: {
      add: (r) => measured.push(...[].concat(r)),
      addDiskPair: (b, a, id) => { measured.push(['pair', b, a, id]); return { state: 'better', delta: 1 }; },
      view: (actions) => ({ records: measured, latest: {}, changes: actions }),
    },
    exportMeasurements: () => ok('C:\\dl\\Tune-measurements.csv'),
    settings: { get: () => ({ saveDir: 'C:\\dl' }), save: () => {}, pickDir: () => {} },
    shell: { openPath: (p) => opened.push(p), showItemInFolder: (p) => opened.push(p), openExternal: (u) => opened.push(u) },
    cache: { read: () => ({}), write: () => {} },
    updater: { check: () => false, download: () => null, install: () => {} },
    appVersion: () => '1.2.4', serviceDir: () => '', exportHardware: (hw, f) => ok(`${hw.boardModel}.${f}`),
  };
  const channels = createChannels(d);
  const ev = { sender: webContents, senderFrame: mainFrame };
  const trusted = (e) => isTrustedSender(e, { webContents, pageUrl: PAGE });
  const call = (name, ...args) => dispatch(channels[name], ev, args, trusted);
  const scanned = async () => { for (const c of ['hw:scan', 'drv:updates', 'drv:gpu', 'bios:check', 'junk:scan', 'startup:list', 'rec:list']) await call(c); calls.length = 0; };
  return { calls, history, opened, channels, call, scanned, trusted, measured, sys };
}

test('shape rules', () => {
  assert.equal(V.str(5)('abc'), true);
  assert.equal(V.str(5)('abcdef'), false);
  assert.equal(V.str(5)(''), false);
  assert.equal(V.str(5)(5), false);
  assert.equal(V.arrayOf(V.str(3), 2)(['a', 'b']), true);
  assert.equal(V.arrayOf(V.str(3), 2)(['a', 'b', 'c']), false);
  assert.equal(V.arrayOf(V.str(3), 2)([]), false);
  assert.equal(V.oneOf(['csv', 'txt'])('exe'), false);
  assert.equal(V.json(10)({ a: 'long value here' }), false);
  assert.equal(V.argsMatch([V.bool()], [true, 'extra']), false);
});

test("only Tune's own page, in its main frame, is trusted", () => {
  const t = (e) => isTrustedSender(e, { webContents, pageUrl: PAGE });
  assert.equal(t({ sender: webContents, senderFrame: mainFrame }), true);
  assert.equal(t({ sender: webContents, senderFrame: { url: `${PAGE}#/x` } }), false, 'a sub-frame');
  assert.equal(t({ sender: { mainFrame: { url: PAGE } }, senderFrame: mainFrame }), false, 'another window');
  const elsewhere = { mainFrame: { url: 'https://evil.example/' } };
  assert.equal(isTrustedSender({ sender: elsewhere, senderFrame: elsewhere.mainFrame }, { webContents: elsewhere, pageUrl: PAGE }), false, 'navigated away');
  assert.equal(t({ sender: webContents }), false, 'no frame');
  assert.equal(t(null), false);
});

test('a request from a foreign sender runs nothing', async () => {
  const w = world();
  await w.scanned();
  const spoof = { sender: { mainFrame: { url: PAGE } }, senderFrame: { url: PAGE } };
  for (const [name, args] of [['drv:install', [[GUID1], 'all']], ['junk:clean', [['userTemp']]], ['restore:create', []], ['service:uninstall', []], ['settings:setLang', ['he']]]) {
    assert.deepEqual(await dispatch(w.channels[name], spoof, args, w.trusted), REFUSED, name);
  }
  assert.equal(w.calls.length, 0);
});

test('malformed requests run nothing', async () => {
  const w = world();
  await w.scanned();
  const bad = [
    ['drv:install', [['not-a-guid'], 'all']], ['drv:install', [GUID1, 'all']], ['drv:install', [[GUID1], 'all', 'extra']],
    ['drv:install', [Array(101).fill(GUID1), 'all']], ['startup:toggle', ['HKCU', 'Discord', 'yes']],
    ['rec:apply', ['powershell -c evil']], ['hw:export', ['exe']], ['settings:setLang', ['fr']],
    ['cache:set', ['secrets', 1]], ['cache:set', ['hw', 'x'.repeat(5_000_001)]],
    ['link:open', ['http://example.com']], ['link:open', ['javascript:alert(1)']], ['link:open', ['https://user:pw@evil.example/']],
    ['bios:download', [{ url: 'https://evil.example/b.zip' }]], ['drv:gpuInstaller', [42]],
    ['measure:take', ['benchmark']], ['measure:take', [{ metric: 'restCpuTempC', value: 20 }]], ['measure:take', []],
    ['measure:list', ['x']], ['measure:export', ['C:\\Windows\\evil.csv']],
  ];
  for (const [name, args] of bad) assert.deepEqual(await w.call(name, ...args), INVALID, `${name} ${JSON.stringify(args).slice(0, 60)}`);
  assert.equal(w.calls.length, 0);
});

test("pointing at something the main process didn't offer runs nothing", async () => {
  const w = world();
  await w.scanned();
  assert.equal((await w.call('drv:install', [GUID2], 'all')).ok, false);
  assert.equal((await w.call('drv:install', [GUID1, GUID2], 'all')).ok, false, 'one unknown in the list refuses all');
  assert.equal((await w.call('drv:gpuInstaller', 'NVIDIA RTX 9090')).ok, false);
  assert.equal((await w.call('dev:enable', 'PCI\\SOMETHING_ELSE')).ok, false);
  assert.equal((await w.call('junk:clean', ['system32'])).ok, false);
  assert.equal((await w.call('startup:toggle', 'HKLM', 'Discord', false)).ok, false);
  assert.equal((await w.call('rec:apply', 'hags')).ok, false, 'not in the last list');
  assert.equal((await w.call('folder:open', 'C:\\Windows')), null);
  assert.equal(w.calls.length, 0);
});

test('the actions use what the main process found, never details from the window', async () => {
  const w = world();
  await w.scanned();
  await w.call('drv:install', [GUID1.toUpperCase()], 'all');
  assert.deepEqual(w.calls.at(-1).slice(0, 2), ['installDrivers', [GUID1]]);
  assert.deepEqual(w.history.at(-1), ['drivers', { items: ['Realtek audio'], reboot: false, restore: 'created' }]);
  await w.call('drv:gpuInstaller', 'AMD Radeon RX 7900 XTX');
  assert.equal(w.calls.at(-1)[1], 'https://drivers.amd.com/x.exe');
  await w.call('bios:download', 'bios');
  assert.deepEqual(w.calls.at(-1)[1], { version: '1901', url: 'https://dlcdnets.asus.com/b.zip', sha256: 'ab' });
  await w.call('startup:toggle', 'HKCU', 'Discord', false);
  assert.deepEqual(w.calls.at(-1), ['startupToggle', 'HKCU', 'Discord', false]);
  await w.call('dev:enable', 'USB\\VID_1234\\5');
  assert.deepEqual(w.calls.at(-1), ['enableDevice', 'USB\\VID_1234\\5']);
  assert.equal((await w.call('hw:export', 'csv')).data, 'PRIME Z790-P WIFI.csv');
});

test('the GPU and BIOS checks use the hardware the main process scanned itself', async () => {
  const w = world();
  assert.equal((await w.call('bios:check')).ok, false, 'before any hardware scan');
  await w.call('hw:scan');
  await w.call('drv:gpu');
  await w.call('bios:check');
  assert.deepEqual(w.calls.find((c) => c[0] === 'gpuVendorCheck').slice(1), [[{ name: 'AMD Radeon RX 7900 XTX' }], '25.1']);
  assert.equal(w.calls.find((c) => c[0] === 'biosCheck')[1].model, 'PRIME Z790-P WIFI');
});

test('every bridge call has a guarded channel, and main registers channels only through the guard', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
  const bridged = [...preload.matchAll(/call\('([^']+)'\)/g)].map((m) => m[1]).sort();
  const w = world();
  assert.deepEqual(bridged, Object.keys(w.channels).sort());
  for (const [name, ch] of Object.entries(w.channels)) assert.ok(Array.isArray(ch.args) && typeof ch.run === 'function', name);
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.equal((main.match(/ipcMain\.(handle|on|once)\(/g) || []).length, 1, 'one registration loop');
  assert.match(main, /ipcMain\.handle\(name, \(event, \.\.\.args\) => dispatch\(channel, event, args, trusted\)\)/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /will-navigate/);
});

test('measurements are taken by the main process; the window only names the kind', async () => {
  const w = world();
  const r = await w.call('measure:take', 'rest');
  assert.equal(r.ok, true);
  assert.deepEqual(w.measured, [{ metric: 'restCpuLoad', value: 4 }], 'what the main process measured is stored');
  const b = await w.call('measure:take', 'boot');
  assert.deepEqual(b.data, { fastStartup: true, systemMedia: 'ssd', lastBootType: 'full', timings: 'ok' }, 'the facts go back, the records go to the store');
  assert.equal(w.measured.length, 2);
  assert.equal((await w.call('measure:list')).data.records.length, 2);
  assert.equal((await w.call('measure:export')).data, 'C:\\dl\\Tune-measurements.csv');
});

test('one measurement at a time', async () => {
  const w = world();
  let release;
  w.sys.restMeasure = () => new Promise((r) => { release = () => r(ok([])); });
  const first = w.call('measure:take', 'rest');
  assert.deepEqual(await w.call('measure:take', 'boot'), { ok: false, error: 'busy' }, 'refused while the first runs');
  release();
  assert.equal((await first).ok, true);
  assert.equal((await w.call('measure:take', 'boot')).ok, true, 'accepted again once it finished');
});

test('a cleanup measures the drive right before and after, linked to its history entry', async () => {
  const w = world();
  await w.scanned();
  const r = await w.call('junk:clean', ['userTemp']);
  assert.deepEqual(w.calls.map((c) => c[0]), ['diskFree', 'junkClean', 'diskFree'], 'before, the cleanup, after');
  assert.deepEqual(r.data.onDisk, { state: 'better', delta: 1 });
  const pair = w.measured.find((m) => m[0] === 'pair');
  assert.equal(pair[3], `id-${w.history.length}`, 'the pair points at the history entry of this cleanup');
});
