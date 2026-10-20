const test = require('node:test');
const assert = require('node:assert/strict');
test('performance gauges expire even while a process snapshot stays visible', async () => {
  const { performanceReadings } = await import('../src/domain/performance-readings.mjs');
  const now = Date.now();
  const perf = { refreshedAt: new Date(now).toISOString(), cpuLoad: 12, ramTotalGB: 16, ramFreeGB: 6, gpuTemps: [{ name: 'GPU', tempC: 50 }] };
  assert.equal(performanceReadings(null, perf, now).ramUsedGB, 10);
  const stale = performanceReadings(null, perf, now + 10001);
  assert.equal(stale.cpuLoad, null); assert.equal(stale.ramUsedGB, null); assert.equal(stale.gpu, null); assert.equal(stale.live, null);
});
test('current performance uses live gauges and clears them on an IPC stall', async () => {
  const { performanceReadings } = await import('../src/domain/performance-readings.mjs');
  const now = Date.now(), live = { receivedAt: now, sampledAt: new Date(now).toISOString(), freshness: 'fresh', cpuLoad: 7, ramUsedBytes: 2 * 1024 ** 3, ramTotalBytes: 8 * 1024 ** 3, gpuTemps: [{ name: 'second', tempC: 42 }] };
  const v = performanceReadings(live, { cpuLoad: 99 }, now);
  assert.equal(v.cpuLoad, 7); assert.equal(v.ramUsedGB, 2); assert.equal(v.ramFreeGB, 6); assert.equal(v.gpu.name, 'second');
  const stale = performanceReadings(live, {}, now + 10001);
  assert.equal(stale.cpuLoad, null); assert.equal(stale.gpu, null);
});
test('missing memory is not displayed as NaN or zero', async () => {
  const { performanceReadings } = await import('../src/domain/performance-readings.mjs');
  assert.equal(performanceReadings(null, {}).ramUsedGB, null);
});
test('partial and unconfirmed driver outcomes are never counted as fully installed', async () => {
  const { summarizeDrivers, driverOutcome } = await import('../src/domain/driver-outcome.mjs');
  assert.deepEqual(summarizeDrivers([{ code: 2 }, { code: 3 }, { code: 4 }, { code: 5 }], 6), { installed: 1, partial: 1, failed: 1, aborted: 1, unknown: 2 });
  assert.equal(driverOutcome(1), 'unknown'); assert.equal(driverOutcome(null), 'unknown');
});
