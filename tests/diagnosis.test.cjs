// Diagnosis by problem (plan PF01): the three problems lead to different findings when the PC's data
// calls for it; a cause is shown as suspected, a measurement as measured; a check that couldn't run is
// "not checked", never fine; and nothing is "solved" while a check is missing.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/domain/diagnosis.mjs');
const samples = (n, s) => Array.from({ length: n }, () => ({ cpuNote: null, ramTotalBytes: 16e9, ...s }));
const boot = (desk, after, extra = {}) => ({
  facts: { fastStartup: true, systemMedia: 'ssd', lastBootType: 'full', timings: 'ok', ...extra },
  latest: {
    bootToDesktopMs: desk == null ? undefined : { value: desk, at: '2026-10-14T07:00:00Z', conditions: { bootType: 'full' } },
    bootAfterLogonMs: after == null ? undefined : { value: after, at: '2026-10-14T07:00:00Z', conditions: { bootType: 'full' }, extra: { startupApps: 19 } },
  },
});
const recs = (over = {}) => [
  { key: 'power', plan: 'balanced', ok: true, action: null },
  { key: 'powerLimit', guide: 'powerLimit', ok: null },
  { key: 'gamemode', on: true, ok: true },
  { key: 'hags', on: true, ok: true },
  { key: 'disk', freeGB: 300, sizeGB: 1000, ok: true },
  { key: 'memChannels', channels: 2, sticks: 2, ok: true },
  { key: 'memSpeed', configured: 6000, rated: 6000, ok: true },
].map((r) => ({ ...r, ...(over[r.key] || {}) }));
const healthy = () => ({
  recs: recs(), gpu: [{ vendor: 'NVIDIA', latest: '581.42', newer: false }], startup: Array.from({ length: 6 }, () => ({ enabled: true })),
  perf: { gpuTemps: [{ name: 'RTX 4070', tempC: 41 }] }, samples: samples(15, { cpuLoad: 6, cpuTempC: 42, ramUsedBytes: 7e9 }),
  sources: { recs: 'ok', startup: 'ok', gpu: 'ok' }, boot: boot(18000, 25000), service: { running: true, current: true }, scanning: false,
});
const keys = (d, ok) => d.findings.filter((f) => f.ok === ok).map((f) => f.key);

test('a healthy PC: nothing found, and every check answered', async () => {
  const { diagnose, PROBLEMS } = await load();
  for (const p of PROBLEMS) {
    const d = diagnose(p, healthy());
    assert.equal(d.state, 'nothingFound', p);
    assert.equal(d.problems, 0, p);
    assert.ok(d.findings.length >= 4, `${p} ran its checks`);
  }
});

test('the three problems lead to different findings on the same PC', async () => {
  const { diagnose } = await load();
  const pc = {
    ...healthy(),
    startup: Array.from({ length: 20 }, () => ({ enabled: true })),
    boot: boot(30000, 95000),
    recs: recs({ gamemode: { ok: false, on: false, action: 'gamemode' }, power: { plan: 'ultimate', ok: false, action: 'power' } }),
    samples: samples(15, { cpuLoad: 8, cpuTempC: 74, ramUsedBytes: 7e9 }),
  };
  const slow = diagnose('slowBoot', pc);
  const games = diagnose('gameStutter', pc);
  const heat = diagnose('overheating', pc);
  assert.deepEqual(keys(slow, false), ['startupApps', 'bootAfterLogon'], 'the likely cause (high impact) before the medium symptom');
  assert.deepEqual(keys(games, false), ['gameMode']);
  assert.deepEqual(keys(heat, false), ['cpuRestTemp', 'powerPlan']);
  // slow after the desktop appears, measured: the startup apps become the high-impact suspect
  const apps = slow.findings.find((f) => f.key === 'startupApps');
  assert.deepEqual([apps.impact, apps.certainty, apps.action], ['high', 'suspected', { kind: 'go', page: 'startup' }]);
  assert.equal(slow.findings[1].vars.s, 95);
  const slower = diagnose('slowBoot', { ...pc, boot: boot(30000, 130000) });
  assert.deepEqual(slower.findings.slice(0, 2).map((f) => [f.key, f.impact, f.certainty]), [['bootAfterLogon', 'high', 'measured'], ['startupApps', 'high', 'suspected']],
    'same impact: measured before suspected');
  // Ultimate Performance is no problem for games but is one for heat
  assert.equal(games.findings.find((f) => f.key === 'powerPlan').ok, true);
  assert.deepEqual(heat.findings.find((f) => f.key === 'powerPlan').action, { kind: 'apply', rec: 'power' });
});

test('a cause is shown as suspected; a reading as measured; each finding has at most one action', async () => {
  const { diagnose } = await load();
  const d = diagnose('gameStutter', {
    ...healthy(),
    gpu: [{ vendor: 'AMD', latest: '25.9.1', newer: true, url: 'https://drivers.amd.com/x.exe' }],
    recs: recs({ power: { plan: 'saver', ok: false, action: 'power' }, memChannels: { channels: 1, sticks: 2, ok: false, guide: 'channels' } }),
    samples: samples(15, { cpuLoad: 40, cpuTempC: 60, ramUsedBytes: 15e9 }),
  });
  const by = Object.fromEntries(d.findings.map((f) => [f.key, f]));
  assert.equal(by.powerPlan.impact, 'high');
  assert.equal(by.powerPlan.certainty, 'suspected');
  assert.equal(by.gpuDriver.certainty, 'suspected');
  assert.equal(by.backgroundCpu.certainty, 'measured');
  assert.equal(by.backgroundCpu.vars.load, 40);
  assert.equal(by.ramPressure.vars.pct, 94);
  assert.deepEqual(by.memChannels.action, { kind: 'guide', rec: 'memChannels' });
  assert.deepEqual(d.findings.map((f) => f.key).slice(0, 1), ['powerPlan'], 'high impact first');
  for (const f of d.findings) assert.ok(f.action === null || typeof f.action.kind === 'string', f.key);
});

test("what couldn't be checked is 'not checked', never fine, and the diagnosis is never 'nothing found'", async () => {
  const { diagnose } = await load();
  const d = diagnose('slowBoot', { ...healthy(), boot: { facts: { timings: 'needsAdmin', systemMedia: 'unknown', fastStartup: null }, latest: {} }, sources: { recs: 'ok', startup: 'error' }, startup: null });
  assert.equal(d.state, 'incomplete');
  const by = Object.fromEntries(d.findings.map((f) => [f.key, f]));
  assert.deepEqual([by.bootToDesktop.ok, by.bootToDesktop.certainty, by.bootToDesktop.say], [null, 'unknown', 'needsAdmin']);
  assert.deepEqual([by.startupApps.ok, by.startupApps.say], [null, 'scanFailed']);
  assert.deepEqual([by.systemDrive.ok, by.systemDrive.say], [null, 'unreadable']);
  assert.equal(by.fastStartup, undefined, 'an unreadable setting gets no row');

  // a failed performance-center scan: its checks are not checked, even if an older list is on screen
  const g = diagnose('gameStutter', { ...healthy(), sources: { recs: 'error', gpu: 'ok' } });
  assert.equal(g.state, 'incomplete');
  assert.ok(g.findings.filter((f) => ['powerPlan', 'gameMode', 'hags', 'memChannels', 'memSpeed', 'diskSpace'].includes(f.key)).every((f) => f.ok === null && f.say === 'scanFailed'));
});

test('without the service there is no CPU temperature: one "not checked" row that offers the service', async () => {
  const { diagnose } = await load();
  const d = diagnose('overheating', { ...healthy(), samples: samples(15, { cpuLoad: 5, cpuTempC: null, cpuNote: 'no service', ramUsedBytes: 7e9 }), service: { running: false } });
  const svc = d.findings.filter((f) => f.action?.kind === 'installService');
  assert.equal(svc.length, 1);
  assert.equal(svc[0].certainty, 'unknown');
  assert.equal(d.state, 'incomplete');
  assert.ok(!d.findings.some((f) => f.key === 'cpuHot'), 'the second temperature check does not repeat it');
});

test('still loading: checking, not a verdict; Tune scanning: the background load is not judged', async () => {
  const { diagnose } = await load();
  const d = diagnose('overheating', { ...healthy(), samples: samples(2, { cpuLoad: 5, cpuTempC: 40 }), perf: null, scanning: true });
  assert.equal(d.state, 'checking');
  assert.ok(d.waiting >= 2);
  const bg = d.findings.find((f) => f.key === 'backgroundCpu');
  assert.deepEqual([bg.ok, bg.say], [null, 'scanning']);
  // a problem already found is shown while other checks still run
  const s = diagnose('slowBoot', { ...healthy(), boot: null, recs: recs({ disk: { ok: false, freeGB: 40, sizeGB: 500 } }) });
  assert.equal(s.state, 'found');
  assert.ok(s.waiting > 0);
});

test('heat: thresholds at rest and at any load; the hot-CPU fix points at the power-limit guide', async () => {
  const { diagnose } = await load();
  const at = (t, l = 8) => diagnose('overheating', { ...healthy(), samples: samples(15, { cpuLoad: l, cpuTempC: t, ramUsedBytes: 7e9 }) });
  assert.equal(at(54).findings.find((f) => f.key === 'cpuRestTemp').ok, true);
  assert.equal(at(55).findings.find((f) => f.key === 'cpuRestTemp').impact, 'medium');
  assert.equal(at(70).findings.find((f) => f.key === 'cpuRestTemp').impact, 'high');
  const hot = at(93, 90);
  assert.equal(hot.findings.find((f) => f.key === 'cpuRestTemp').say, 'notAtRest', 'never at rest: rest temperature not judged');
  assert.deepEqual(hot.findings.find((f) => f.key === 'cpuHot').action, { kind: 'guide', rec: 'powerLimit' });
  const gpuHot = diagnose('overheating', { ...healthy(), perf: { gpuTemps: [{ name: 'RX 7900', tempC: 88 }] } });
  assert.equal(gpuHot.findings.find((f) => f.key === 'gpuTemp').impact, 'high');
});

test('slow start: an HDD and slow measured starts; Fast Startup off is only a low-impact suspect', async () => {
  const { diagnose } = await load();
  const d = diagnose('slowBoot', { ...healthy(), boot: boot(100000, 40000, { systemMedia: 'hdd', fastStartup: false }) });
  const by = Object.fromEntries(d.findings.map((f) => [f.key, f]));
  assert.deepEqual([by.bootToDesktop.ok, by.bootToDesktop.impact, by.bootToDesktop.vars.s], [false, 'high', 100]);
  assert.deepEqual([by.systemDrive.ok, by.systemDrive.say], [false, 'hdd']);
  assert.deepEqual([by.fastStartup.impact, by.fastStartup.certainty], ['low', 'suspected']);
  assert.equal(by.bootAfterLogon.ok, true);
  assert.deepEqual(d.limits, ['perAppImpact']);
});

test('an unknown problem is refused', async () => {
  const { diagnose } = await load();
  assert.throws(() => diagnose('internet', healthy()));
});
