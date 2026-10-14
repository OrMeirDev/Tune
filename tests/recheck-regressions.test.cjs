// Gaps found by the 1.3.0 audit recheck (R1–R5), each reproduced with the real failure shape:
// a failed maker check, a failed optimization scan or a failed refresh is never shown or acted on
// as fine. Adapters run with a fake fetch; the renderer hook and selector are bundled with esbuild
// and run with React and the bridge replaced by small stand-ins. No network, Windows or service.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const verdict = () => import('../src/domain/scan-verdict.mjs');
const withFetch = async (f, run) => { const real = global.fetch; global.fetch = f; try { return await run(); } finally { global.fetch = real; } };
const reply = (body, { status = 200, json = false } = {}) => ({ ok: status < 400, status, text: async () => (json ? JSON.stringify(body) : body), json: async () => body, headers: new Map() });
const OK = { ok: true, data: [] };
const HW = { ok: true, data: {} };

// a renderer module bundled for Node, with some imports swapped for stand-ins
async function load(entry, stubs) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)], bundle: true, write: false, format: 'cjs', platform: 'node',
    loader: { '.js': 'jsx', '.jsx': 'jsx' }, jsx: 'automatic', logLevel: 'silent', external: ['lucide-react', 'react/jsx-runtime'],
    plugins: [{
      name: 'stubs',
      setup(b) {
        for (const [filter, code] of Object.entries(stubs)) {
          b.onResolve({ filter: new RegExp(filter) }, (a) => ({ path: a.path, namespace: 'stub', pluginData: code }));
        }
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: a.pluginData, loader: 'js' }));
      },
    }],
  });
  const m = new Module(entry);
  m.paths = Module._nodeModulePaths(ROOT);
  m._compile(out.outputFiles[0].text, path.join(ROOT, entry));
  return m.exports;
}

test('R1: a failed NVIDIA or AMD check is not "all up to date"', async () => {
  const { sourcesFrom, scanVerdict } = await verdict();
  const { gpuVendorCheck } = require('../electron/features/gpu-drivers.cjs');
  const check = async (gpus, f) => withFetch(f, () => gpuVendorCheck(gpus));
  const state = (g) => scanVerdict({ running: false, total: 0, sources: { ...sourcesFrom({ hw: HW, wu: OK, gpu: g, bios: { ok: true, data: { supported: false } } }) } });

  const nvidiaDown = await check([{ name: 'NVIDIA GeForce RTX 4080', driverVersion: '32.0.15.6636' }], async () => { throw new Error('catalog unavailable'); });
  assert.equal(nvidiaDown.ok, true, 'the adapter still answers');
  assert.equal(nvidiaDown.data[0].status, 'error');
  assert.equal(state(nvidiaDown).state, 'incomplete');

  const amd500 = await check([{ name: 'AMD Radeon RX 7900 XTX' }], async () => reply('oops', { status: 500 }));
  assert.equal(amd500.data[0].status, 'error');
  assert.equal(state(amd500).state, 'incomplete');

  const amdNoLink = await check([{ name: 'AMD Radeon RX 7900 XTX' }], async () => reply('<html>maintenance</html>'));
  assert.equal(amdNoLink.data[0].status, 'error', 'a page without a driver link is unknown, not "no update"');
  assert.equal(state(amdNoLink).state, 'incomplete');

  // two GPUs, one checked and one failed: still incomplete; a card Tune can't check is not a failure
  const mixed = await check([{ name: 'Intel(R) Arc(TM) A770' }, { name: 'AMD Radeon RX 7900 XTX' }], async () => { throw new Error('down'); });
  assert.deepEqual(mixed.data.map((g) => g.status), ['unsupported', 'error']);
  assert.equal(state(mixed).state, 'incomplete');
  const intelOnly = await check([{ name: 'Intel(R) Arc(TM) A770' }], async () => { throw new Error('never called'); });
  assert.equal(state(intelOnly).state, 'allGood');
});

test('R2: a failed ASUS catalog is a failure, not "unsupported"', async () => {
  const { sourcesFrom, scanVerdict } = await verdict();
  const { biosCheck } = require('../electron/features/bios.cjs');
  const board = { maker: 'ASUSTeK COMPUTER INC.', model: 'PRIME Z790-P WIFI', version: '1836', date: '2025' };
  const bios = (f) => withFetch(f, () => biosCheck(board));
  const state = (b) => scanVerdict({ running: false, total: 0, sources: sourcesFrom({ hw: HW, wu: OK, gpu: OK, bios: b }) }).state;

  const down = await bios(async () => { throw new Error('network'); });
  assert.equal(down.ok, false);
  assert.equal(state(down), 'incomplete');

  const fail = await bios(async () => reply({ Status: 'FAIL', Message: 'nope' }, { json: true }));
  assert.equal(fail.ok, false, '"FAIL" from both addresses');

  const http = await bios(async () => reply('', { status: 503 }));
  assert.equal(http.ok, false);

  // ASUS answered properly, just without BIOS files for this board: genuinely unsupported
  const none = await bios(async () => reply({ Status: 'SUCCESS', Result: { Obj: [] } }, { json: true }));
  assert.equal(none.ok, true);
  assert.equal(none.data.supported, false);
  assert.equal(state(none), 'allGood');
});

test('R3: failed cleanup and startup scans are "not checked", never healthy', async () => {
  // the real loaders, with React state replaced by a recorder and the bridge answering ok: false
  const calls = [];
  global.window = { tune: { junkScan: async () => ({ ok: false, error: 'x' }), startupList: async () => ({ ok: false, error: 'x' }), recommendations: async () => ({ ok: false, error: 'x' }), cacheSet: () => {} } };
  const { useScanResults } = await load('src/app/useScanResults.js', {
    '^react$': `let i = 0; exports.useState = (v) => { const k = i++; return [v, (x) => globalThis.__calls.push([k, x])]; }; exports.useCallback = (f) => f;`,
  });
  globalThis.__calls = calls;
  const r = useScanResults({ setMsg: () => {} });
  await r.loadJunk(); await r.loadStartup(); await r.loadRecs();
  const set = calls.map(([, x]) => x);
  assert.ok(!set.some((x) => Array.isArray(x) && x.length === 0), 'no failed scan became an empty list');
  const sources = set.filter((x) => typeof x === 'function').reduce((s, f) => f(s), {});
  assert.deepEqual(sources, { junk: 'error', startup: 'error', recs: 'error' });

  // the performance center reads those states
  const { centerItems } = await load('src/features/diagnostics/findingSelectors.js', {});
  const items = centerItems({ recs: [], junk: null, startup: null, sources });
  assert.deepEqual(items.map((i) => [i.key, i.ok, !!i.unchecked]), [['junk', null, true], ['startup', null, true]]);
  // a later refresh that fails keeps the last list visible but still "not checked"
  const stale = centerItems({ recs: [], junk: [{ key: 'userTemp', bytes: 10 }], startup: [{ enabled: true }], sources });
  assert.deepEqual(stale.map((i) => i.ok), [null, null]);
  const fine = centerItems({ recs: [], junk: [{ key: 'userTemp', bytes: 10 }], startup: [{ enabled: true }], sources: { junk: 'ok', startup: 'ok' } });
  assert.deepEqual(fine.map((i) => i.ok), [true, true]);
  delete global.window;
});

test('R5: after a failed refresh, the old offers can be seen but not acted on', () => {
  const { createOffers, STALE } = require('../electron/ipc/offers.cjs');
  const o = createOffers();
  const ID = '11111111-2222-3333-4444-555555555555';
  o.remember('wu', { ok: true, data: [{ id: ID, title: 'Realtek audio' }] });
  assert.equal(o.drivers([ID]).ok, true);
  o.remember('wu', { ok: false, error: 'Windows Update did not answer' });
  assert.deepEqual(o.drivers([ID]), { ok: false, error: STALE });
  o.remember('wu', { ok: true, data: [{ id: ID, title: 'Realtek audio' }] });
  assert.equal(o.drivers([ID]).ok, true, 'a successful scan makes it actionable again');
  // the same rule for every kind of action
  for (const [kind, ask] of [['gpu', () => o.gpuDriver('x')], ['bios', () => o.bios()], ['hw', () => o.problemDevice('x')], ['junk', () => o.junkCategories(['userTemp'])], ['startup', () => o.startupEntry('HKCU', 'x')], ['recs', () => o.recommendation('power')]]) {
    o.remember(kind, { ok: false });
    assert.deepEqual(ask(), { ok: false, error: STALE }, kind);
  }
});

test('R2 follow-up: an ASUS answer with the wrong shape is a failure, not "unsupported"', async () => {
  const { sourcesFrom, scanVerdict } = await verdict();
  const { biosCheck } = require('../electron/features/bios.cjs');
  const board = { maker: 'ASUSTeK COMPUTER INC.', model: 'PRIME Z790-P WIFI', version: '1836' };
  for (const [name, body] of [
    ['Obj is an object', { Status: 'SUCCESS', Result: { Obj: {} } }],
    ['Obj is a string', { Status: 'SUCCESS', Result: { Obj: 'x' } }],
    ['BIOS files not a list', { Status: 'SUCCESS', Result: { Obj: [{ Name: 'BIOS', Files: {} }] } }],
  ]) {
    const r = await withFetch(async () => reply(body, { json: true }), () => biosCheck(board));
    assert.equal(r.ok, false, name);
    assert.equal(scanVerdict({ running: false, total: 0, sources: sourcesFrom({ hw: HW, wu: OK, gpu: OK, bios: r }) }).state, 'incomplete', name);
  }
});

test('R5 follow-up: a failed hardware scan also stops the GPU driver and BIOS offers', () => {
  const { createOffers, STALE } = require('../electron/ipc/offers.cjs');
  const o = createOffers();
  o.remember('hw', { ok: true, data: { gpus: [{ name: 'AMD Radeon RX 7900 XTX' }] } });
  o.remember('gpu', { ok: true, data: [{ status: 'ok', gpu: 'AMD Radeon RX 7900 XTX', newer: true, url: 'https://drivers.amd.com/x.exe' }] });
  o.remember('bios', { ok: true, data: { supported: true, newer: true, latest: { url: 'https://dlcdnets.asus.com/b.zip' } } });
  assert.equal(o.gpuDriver('AMD Radeon RX 7900 XTX').ok, true);
  assert.equal(o.bios().ok, true);
  o.remember('hw', { ok: false, error: 'hardware scan failed' });
  assert.deepEqual(o.gpuDriver('AMD Radeon RX 7900 XTX'), { ok: false, error: STALE });
  assert.deepEqual(o.bios(), { ok: false, error: STALE });
  // a successful hardware scan alone doesn't revive them; their own checks must succeed again
  o.remember('hw', { ok: true, data: { gpus: [] } });
  assert.deepEqual(o.bios(), { ok: false, error: STALE });
  o.remember('bios', { ok: true, data: { supported: true, newer: true, latest: { url: 'https://dlcdnets.asus.com/b.zip' } } });
  assert.equal(o.bios().ok, true);
});
