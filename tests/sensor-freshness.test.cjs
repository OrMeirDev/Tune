const test = require('node:test');
const assert = require('node:assert/strict');
const { sensorSnapshot, mergeGpuReadings } = require('../electron/domain/sensor-policy.cjs');
const now = Date.parse('2026-10-21T12:00:00Z');
const sample = { sampledAt: new Date(now).toISOString(), cpuTempC: 60, cpuPowerW: 80, cpuClockMHz: 4200, cpuVoltageV: 1.2, cpuVoltageSource: 'core', gpus: [{ name: 'GPU', tempC: 55 }] };
test('CPU voltage keeps measured core / requested VID provenance', () => {
  assert.equal(sensorSnapshot(sample, now).cpuVoltageSource, 'core');
  assert.equal(sensorSnapshot({ ...sample, cpuVoltageSource: 'vid' }, now).cpuVoltageSource, 'vid');
  assert.equal(sensorSnapshot({ ...sample, cpuVoltageSource: undefined }, now).cpuVoltageV, null);
});
test('stale, future and unverified sensor answers cannot become current readings', () => {
  for (const stamp of [undefined, 'broken', new Date(now - 10001).toISOString(), new Date(now + 1001).toISOString()]) {
    const r = sensorSnapshot({ ...sample, sampledAt: stamp }, now);
    assert.notEqual(r.freshness, 'fresh');
    for (const field of ['cpuTempC', 'cpuPowerW', 'cpuVoltageV', 'cpuClockMHz']) assert.equal(r[field], null, field);
    assert.deepEqual(r.gpus, []);
  }
  assert.equal(sensorSnapshot(sample, now + 10000).cpuTempC, 60);
});
test('invalid sensor values stay missing', () => {
  const r = sensorSnapshot({ ...sample, cpuTempC: NaN, cpuPowerW: -1, cpuVoltageV: 12, cpuClockMHz: '4200' }, now);
  for (const field of ['cpuTempC', 'cpuPowerW', 'cpuVoltageV', 'cpuClockMHz']) assert.equal(r[field], null);
});
test('a stalled IPC read cannot leave old values on the live tiles', async () => {
  const { freshLive } = await import('../src/domain/live-freshness.mjs');
  const live = { ...sensorSnapshot(sample, now), receivedAt: now, cpuLoad: 10, ramUsedBytes: 100, ramTotalBytes: 200 };
  assert.equal(freshLive(live, now), live);
  const stale = freshLive(live, now + 10001);
  assert.equal(stale.cpuTempC, null);
  assert.equal(stale.cpuVoltageV, null);
  assert.equal(stale.cpuLoad, null);
  assert.equal(stale.cpuNote, 'stale');
  assert.equal(freshLive({ ...live, receivedAt: now + 9000 }, now + 10001).cpuTempC, null);
});
test('GPU fan readings are matched by device name, never enumeration order', () => {
  const r = mergeGpuReadings([{ name: 'NVIDIA GPU', tempC: 60 }, { name: 'AMD GPU', tempC: 70 }], [{ name: 'AMD GPU', fanRpm: 2000 }, { name: 'NVIDIA GPU', fanRpm: 1000 }]);
  assert.deepEqual(r.map(g => g.fanRpm), [1000, 2000]);
  assert.equal(mergeGpuReadings([{ name: 'unknown' }], [{ name: 'other', fanRpm: 1000 }])[0].fanRpm, null);
});

test('identical GPU names never borrow an ambiguous fan reading', () => {
  const same = [{ name: 'same' }, { name: 'same' }];
  assert.deepEqual(mergeGpuReadings(same, [{ name: 'same', fanRpm: 1000 }]).map(g => g.fanRpm), [null, null]);
  assert.equal(mergeGpuReadings([{ name: 'same' }], [{ name: 'same', fanRpm: 1000 }, { name: 'same', fanRpm: 2000 }])[0].fanRpm, null);
  assert.equal(mergeGpuReadings([{ name: 'one' }], [{ name: 'one', fanRpm: -1 }])[0].fanRpm, null);
  assert.equal(mergeGpuReadings([{ name: 'one' }], [{ name: 'one', fanRpm: 0 }])[0].fanRpm, 0);
});
