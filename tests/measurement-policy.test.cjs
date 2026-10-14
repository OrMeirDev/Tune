// Before and after a change (plan PF02): a change is credited only when both measurements were taken
// the same way; no change and a change for the worse are reported as such; a change waits for its
// "after" instead of being shown as an improvement.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../electron/domain/measurement-policy.cjs');

const T0 = Date.parse('2026-10-01T08:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const rest = (min, metric, value, loadBand = 'rest') => M.record({ metric, value, at: at(min), method: 'restSampling', conditions: { loadBand, seconds: 20, samples: 10 } });
const boot = (min, metric, value, bootType = 'full') => M.record({ metric, value, at: at(min + 2), method: 'windowsBootLog', conditions: { bootType, startedAt: at(min) }, key: `boot:${at(min)}:${metric}` });

test('rest measurement: medians, at rest or busy, and too few readings is not a number', () => {
  const samples = [5, 7, 6, 30, 8, 6].map((cpuLoad, i) => ({ cpuLoad, cpuTempC: 40 + i, ramUsedBytes: 8e9 }));
  const [load, temp, ram] = M.summarizeRest(samples, { at: at(0), seconds: 12, sensor: null });
  assert.equal(load.value, 7);
  assert.equal(load.conditions.loadBand, 'rest');
  assert.equal(temp.value, 42.5);
  assert.equal(ram.value, 8e9);
  const busy = M.summarizeRest(samples.map((s) => ({ ...s, cpuLoad: 60 })), { at: at(0), seconds: 12 });
  assert.equal(busy[0].conditions.loadBand, 'busy');
  const few = M.summarizeRest(samples.slice(0, 3), { at: at(0), seconds: 6 });
  assert.deepEqual(few.map((r) => [r.value, r.missing]), [[null, 'tooFewSamples'], [null, 'tooFewSamples'], [null, 'tooFewSamples']]);
  // no service: the load is measured, the temperature says why it isn't
  const noTemp = M.summarizeRest(samples.map((s) => ({ ...s, cpuTempC: null })), { at: at(0), seconds: 12, sensor: 'noService' });
  assert.equal(noTemp[0].value, 7);
  assert.deepEqual([noTemp[1].value, noTemp[1].missing], [null, 'noService']);
});

test('compare: better, worse and "same" within normal variation, in the right direction per measure', () => {
  assert.equal(M.compare(rest(0, 'restCpuTempC', 60), rest(10, 'restCpuTempC', 50)).state, 'better');
  assert.equal(M.compare(rest(0, 'restCpuTempC', 50), rest(10, 'restCpuTempC', 56)).state, 'worse');
  assert.equal(M.compare(rest(0, 'restCpuTempC', 50), rest(10, 'restCpuTempC', 51.5)).state, 'same');
  const disk = (v, phase) => M.record({ metric: 'diskFreeBytes', value: v, at: at(0), method: 'fileSystem', conditions: { drive: 'C:' }, phase });
  const freed = M.compare(disk(10e9, 'before'), disk(12e9, 'after'));
  assert.deepEqual([freed.state, freed.delta], ['better', 2e9], 'more free space is better');
  assert.equal(M.compare(disk(10e9), disk(9e9)).state, 'worse', 'a drop is reported, not hidden');
  // boot: 10% or 2 s is normal variation
  assert.equal(M.compare(boot(0, 'bootToDesktopMs', 30000), boot(60, 'bootToDesktopMs', 28500)).state, 'same');
  assert.equal(M.compare(boot(0, 'bootToDesktopMs', 30000), boot(60, 'bootToDesktopMs', 20000)).state, 'better');
});

test('measurements taken differently are never credited: both shown, nothing claimed', () => {
  const c1 = M.compare(rest(0, 'restCpuTempC', 70, 'busy'), rest(10, 'restCpuTempC', 45));
  assert.deepEqual([c1.state, c1.reason], ['notComparable', 'notAtRest']);
  assert.ok(c1.before && c1.after, 'both values are kept for showing');
  const c2 = M.compare(boot(0, 'bootToDesktopMs', 40000, 'full'), boot(60, 'bootToDesktopMs', 9000, 'fastStartup'));
  assert.deepEqual([c2.state, c2.reason], ['notComparable', 'differentBootType'], 'a Fast Startup start is not an improvement over a full one');
  assert.equal(M.compare(boot(0, 'bootToDesktopMs', 40000, 'unknown'), boot(60, 'bootToDesktopMs', 30000, 'unknown')).state, 'notComparable');
  const missing = M.compare(rest(0, 'restCpuTempC', null), rest(10, 'restCpuTempC', 45));
  assert.equal(missing.state, 'missing');
  const disk = (drive) => M.record({ metric: 'diskFreeBytes', value: 1e9, at: at(0), method: 'fileSystem', conditions: { drive } });
  assert.equal(M.compare(disk('C:'), disk('D:')).reason, 'differentDrive');
});

test("Windows' start-up records: each start paired with how it began", () => {
  const recs = M.bootRecords({
    types: [{ at: '2026-10-01T07:59:58.0000000Z', code: 0 }, { at: '2026-10-02T08:00:05.1234567Z', code: 1 }, { at: '2026-10-03T08:00:05Z', code: 0 }],
    timings: [
      { at: '2026-10-01T08:03:00Z', startedAt: '2026-10-01T07:59:50.1234567Z', bootMs: 60000, mainPathMs: 30000, postBootMs: 30000, startupApps: 14 },
      { at: '2026-10-02T08:02:00Z', startedAt: '2026-10-02T08:00:00Z', bootMs: 20000, mainPathMs: 12000, postBootMs: 8000 },
      { at: '2026-10-04T09:00:00Z', mainPathMs: 25000, postBootMs: null }, // no start time, no kind recorded near it
    ],
  });
  assert.equal(recs.length, 5, 'a missing value is skipped, not recorded as 0');
  assert.deepEqual(recs.filter((r) => r.metric === 'bootToDesktopMs').map((r) => r.conditions.bootType), ['full', 'fastStartup', 'unknown']);
  assert.equal(recs[0].extra.startupApps, 14);
  assert.equal(recs[0].conditions.startedAt, '2026-10-01T07:59:50.123Z');
  assert.ok(recs.every((r) => r.key && r.method === 'windowsBootLog'));
});

test('start-up facts: unreadable stays unknown, never a default', () => {
  assert.deepEqual(M.bootFacts({ hiberboot: 1, hibernate: 1, media: 'SSD', timingStatus: 'ok', types: [{ at: '2026-10-01T08:00:00Z', code: 1 }] }),
    { fastStartup: true, systemMedia: 'ssd', lastBootType: 'fastStartup', timings: 'ok' });
  assert.equal(M.bootFacts({ hiberboot: 1, hibernate: 0 }).fastStartup, false, 'Fast Startup needs hibernation');
  assert.equal(M.bootFacts({}).fastStartup, null);
  assert.equal(M.bootFacts({ media: 'Unspecified', bus: 'NVMe' }).systemMedia, 'ssd');
  assert.equal(M.bootFacts({ media: 'HDD' }).systemMedia, 'hdd');
  assert.equal(M.bootFacts({ media: 'Unspecified', bus: 'SATA' }).systemMedia, 'unknown');
  assert.equal(M.bootFacts({ timingStatus: 'needsAdmin' }).timings, 'needsAdmin');
  assert.equal(M.bootFacts({ timingStatus: 'something else' }).timings, 'unavailable');
});

test('a cleanup is compared on its own before/after pair', () => {
  const pair = M.diskPair({ drive: 'C:', freeBytes: 50e9, at: at(0) }, { drive: 'C:', freeBytes: 53e9, at: at(1) }, { actionId: 'a1' });
  const [c] = M.actionComparisons([{ id: 'a1', action: 'clean', detail: { freed: 3e9 }, at: at(1) }], pair);
  assert.equal(c.results[0].state, 'better');
  assert.equal(c.results[0].delta, 3e9);
  // the drive couldn't be read afterwards: missing, not "nothing freed"
  const unread = M.diskPair({ drive: 'C:', freeBytes: 50e9 }, null, { actionId: 'a2', at: at(5) });
  const [u] = M.actionComparisons([{ id: 'a2', action: 'clean', detail: {}, at: at(5) }], unread);
  assert.equal(u.results[0].state, 'missing');
  // an old entry without an ID has no pair
  const [old] = M.actionComparisons([{ action: 'clean', detail: {}, at: at(5) }], pair);
  assert.equal(old.results[0].reason, 'notRecorded');
});

test('a startup change waits for the next start of Windows, then compares starts of the same kind', () => {
  const change = { id: 's1', action: 'startup', detail: { name: 'Teams', enabled: false }, at: at(100) };
  const before = [boot(0, 'bootAfterLogonMs', 40000), boot(30, 'bootAfterLogonMs', 42000), boot(60, 'bootAfterLogonMs', 41000)];
  let [c] = M.actionComparisons([change], before);
  const after = c.results.find((r) => r.metric === 'bootAfterLogonMs');
  assert.equal(after.state, 'waiting', 'no start since the change yet');
  assert.equal(after.before.value, 41000);

  // the next start used Fast Startup: shown, not compared with full starts
  const fast = boot(200, 'bootAfterLogonMs', 15000, 'fastStartup');
  [c] = M.actionComparisons([change], [...before, fast]);
  assert.deepEqual([c.results[0].state, c.results[0].reason], ['notComparable', 'differentBootType']);

  // a full start afterwards: compared with the median of the full starts before
  [c] = M.actionComparisons([change], [...before, fast, boot(300, 'bootAfterLogonMs', 30000)]);
  assert.equal(c.results[0].state, 'better');
  assert.equal(c.results[0].before.value, 41000);
  assert.equal(c.results[0].before.count, 3);
  assert.equal(c.results[0].delta, -11000);

  // a start that was no faster is reported as no change
  [c] = M.actionComparisons([change], [...before, boot(300, 'bootAfterLogonMs', 41500)]);
  assert.equal(c.results[0].state, 'same');
});

test('another change before the after measurement is flagged', () => {
  const first = { id: 's1', action: 'startup', detail: { name: 'A', enabled: false }, at: at(100) };
  const second = { id: 's2', action: 'startup', detail: { name: 'B', enabled: false }, at: at(110) };
  const recs = [boot(0, 'bootAfterLogonMs', 40000), boot(300, 'bootAfterLogonMs', 30000)];
  const [newest, older] = M.actionComparisons([second, first], recs);
  assert.equal(older.results[0].confounded, true, 'the first change is measured together with the second');
  assert.equal(newest.results[0].confounded, undefined);
});

test('a power-plan change is measured at rest; Game Mode and GPU scheduling are not measurable at rest', () => {
  const plan = { id: 'p1', action: 'setting', detail: { key: 'power' }, at: at(100) };
  const recs = [rest(90, 'restCpuTempC', 55), rest(95, 'restCpuTempC', 70, 'busy'), rest(120, 'restCpuTempC', 72, 'busy'), rest(130, 'restCpuTempC', 48)];
  const [c] = M.actionComparisons([plan], recs);
  const temp = c.results.find((r) => r.metric === 'restCpuTempC');
  assert.equal(temp.state, 'better', 'the busy measurement after the change is skipped for the one at rest');
  assert.equal(temp.after.value, 48);
  const [g] = M.actionComparisons([{ id: 'g', action: 'setting', detail: { key: 'gamemode' }, at: at(100) }], recs);
  assert.deepEqual([g.results.length, g.note], [0, 'notMeasurableAtRest']);
  // a "before" from more than a week earlier is not compared
  const [stale] = M.actionComparisons([{ ...plan, at: at(60 * 24 * 10) }], [rest(0, 'restCpuTempC', 55), rest(60 * 24 * 11, 'restCpuTempC', 45)]);
  assert.equal(stale.results[0].reason, 'beforeTooOld');
});

test('stored records are checked before use', () => {
  assert.equal(M.validRecord(rest(0, 'restCpuLoad', 5)), true);
  assert.equal(M.validRecord({ metric: 'restCpuLoad', value: '5', at: at(0), method: 'x' }), false);
  assert.equal(M.validRecord({ metric: 'evil', value: 5, at: at(0), method: 'x' }), false);
  assert.equal(M.validRecord({ metric: 'restCpuLoad', value: 5, at: 'yesterday', method: 'x' }), false);
  assert.throws(() => M.record({ metric: 'nope', value: 1 }));
});
