// Synthetic catalog fixtures, explicitly not evidence of a run on these physical machines.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareFirmware, dellId, supportsDell, lenovoInstallerMatches, asusFileMatches, nvidiaPackageMatches } = require('../electron/domain/catalog-policy.cjs');
test('firmware versions compare dotted numbers and Dell A-revisions without inventing an order', () => {
  assert.equal(compareFirmware('A12', 'A9'), 1);
  assert.equal(compareFirmware('02.10.0', '2.9'), 1);
  assert.equal(compareFirmware('1.10', '1.10.0'), 0);
  assert.equal(compareFirmware('N32ET86W', '1.62'), null);
  assert.equal(compareFirmware('A12', '12'), null);
  assert.equal(compareFirmware('unknown', '0'), null);
});
test('Dell BIOS applicability requires an exact supported system ID, not any model in the catalog', () => {
  const c = '<SoftwareComponent><SupportedSystems><Brand><Model systemID="07E8"/></Brand></SupportedSystems></SoftwareComponent>';
  assert.equal(supportsDell(c, '07e8'), true);
  for (const sku of ['07E', '107E8', '07E8!', '', null]) assert.equal(supportsDell(c, sku), false);
  assert.equal(supportsDell('<Description systemID="07E8"/>', '07E8'), false);
  assert.equal(dellId('07E8<script>'), null);
});
test('Lenovo BIOS installer must match the installed firmware family', () => {
  assert.equal(lenovoInstallerMatches('N32ET86W (1.62 )', 'n32uj31w.exe'), true);
  assert.equal(lenovoInstallerMatches('N32ET86W (1.62 )', 'n3auj31w.exe'), false);
  assert.equal(lenovoInstallerMatches('H1CN47WW', 'h1cn48ww.exe'), true);
  assert.equal(lenovoInstallerMatches('H1CN47WW', 'h2cn48ww.exe'), false);
  assert.equal(lenovoInstallerMatches('unknown', 'n32uj31w.exe'), false);
});
test('ASUS filenames bind the exact board variant and catalog version', () => {
  const url = 'https://dlcdnets.asus.com/pub/ASUS/mb/BIOS/PRIME-Z790-P-WIFI-ASUS-1836.zip';
  assert.equal(asusFileMatches('PRIME Z790-P WIFI', '1836', url), true);
  assert.equal(asusFileMatches('PRIME Z790-P', '1836', url), false);
  assert.equal(asusFileMatches('PRIME Z790-P WIFI', '1840', url), false);
  assert.equal(asusFileMatches('PRIME Z790-P WIFI', '1836', url.replace('dlcdnets.asus.com', 'evil.test')), false);
});
test('NVIDIA package evidence must agree on version, Windows, architecture and laptop/desktop', () => {
  const d = { Version: '581.08', DownloadURL: 'https://us.download.nvidia.com/Windows/581.08/581.08-desktop-win10-win11-64bit-international-dch-whql.exe' };
  const env = { gpu: 'NVIDIA GeForce RTX 4080', windows11: true };
  assert.equal(nvidiaPackageMatches(d, env), true);
  assert.equal(nvidiaPackageMatches({ ...d, Version: '580.88' }, env), false);
  assert.equal(nvidiaPackageMatches(d, { ...env, gpu: 'NVIDIA GeForce RTX 4080 Laptop GPU' }), false);
  assert.equal(nvidiaPackageMatches(d, { ...env, arch: 'arm64' }), false);
  assert.equal(nvidiaPackageMatches({ ...d, DownloadURL: d.DownloadURL.replace('win10-win11', 'win10') }, env), false);
  assert.equal(nvidiaPackageMatches({ ...d, DownloadURL: d.DownloadURL.replace('us.download.nvidia.com', 'us.download.nvidia.com.evil.test') }, env), false);
});
test('the ASUS adapter refuses another board even when it has a newer BIOS and valid hash', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ Status: 'SUCCESS', Result: { Obj: [{ Name: 'BIOS', Files: [{
    Version: '1840', IsRelease: 1, sha256: 'a'.repeat(64), DownloadUrl: { Global: '/pub/ASUS/mb/BIOS/PRIME-Z790-P-WIFI-ASUS-1840.zip' },
  }] }] } }));
  try {
    const { biosCheck } = require('../electron/features/bios.cjs');
    const good = await biosCheck({ maker: 'ASUS', model: 'PRIME Z790-P WIFI', version: '1836' });
    assert.equal(good.ok, true); assert.equal(good.data.supported, true); assert.equal(good.data.newer, true);
    const wrong = await biosCheck({ maker: 'ASUS', model: 'PRIME Z790-P', version: '1836' });
    assert.equal(wrong.ok, false); assert.match(wrong.error, /exact board/);
  } finally { global.fetch = original; }
});
test('AMD autodetect does not claim a card-specific update or an all-good scan', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response('<a href="https://drivers.amd.com/drivers/installer/adrenalin-edition-26.1.1-minimalsetup-251203.exe">AMD</a>');
  try {
    const { gpuVendorCheck } = require('../electron/features/gpu-drivers.cjs');
    const { sourcesFrom, scanVerdict } = await import('../src/domain/scan-verdict.mjs');
    const gpu = await gpuVendorCheck([{ name: 'AMD Radeon RX 7900 XTX' }]);
    assert.equal(gpu.data[0].installerKind, 'autodetect');
    assert.equal(gpu.data[0].newer, false);
    const sources = sourcesFrom({ hw: { ok: true }, wu: { ok: true }, gpu, bios: { ok: true, data: { supported: false } } });
    assert.equal(scanVerdict({ sources }).state, 'incomplete');
  } finally { global.fetch = original; }
});

test('AMD autodetect remains actionable through the real IPC offer gate, never from stale data', async () => {
  const { createOffers, STALE } = require('../electron/ipc/offers.cjs');
  const { createChannels } = require('../electron/ipc/channels.cjs');
  const offers = createOffers(), calls = [], opened = [];
  const gpu = { gpu: 'AMD Radeon RX 7900 XTX', vendor: 'AMD', status: 'ok', newer: false, installerKind: 'autodetect', url: 'https://drivers.amd.com/drivers/installer/test-minimalsetup.exe' };
  offers.remember('gpu', { ok: true, data: [gpu] });
  const channels = createChannels({
    offers, entitlements: { featureOf: () => null },
    sys: { downloadGpuInstaller: async (url, dir) => { calls.push({ url, dir }); return { ok: true, data: 'C:\\test\\amd.exe' }; } },
    settings: { get: () => ({ saveDir: 'C:\\test' }) }, progressTo: () => () => {},
    shell: { openPath: file => opened.push(file) }, history: { add() {} },
  });
  assert.equal((await channels['drv:gpuInstaller'].run(gpu.gpu)).ok, true);
  assert.deepEqual(calls, [{ url: gpu.url, dir: 'C:\\test' }]);
  assert.deepEqual(opened, ['C:\\test\\amd.exe']);
  offers.remember('gpu', { ok: false, error: 'refresh failed' });
  assert.equal((await channels['drv:gpuInstaller'].run(gpu.gpu)).error, STALE);
  assert.equal(calls.length, 1);
  offers.remember('gpu', { ok: true, data: [{ ...gpu, status: 'error' }] });
  assert.equal((await channels['drv:gpuInstaller'].run(gpu.gpu)).ok, false);
  assert.equal(calls.length, 1);
});
