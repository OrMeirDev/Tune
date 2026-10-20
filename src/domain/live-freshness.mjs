export function freshLive(live, now = Date.now()) {
  if (!live) return null;
  const age = now - live.receivedAt, sampleAge = now - Date.parse(live.sampledAt || '');
  const hardwareStale = live.freshness === 'fresh' && (!Number.isFinite(sampleAge) || sampleAge > 10000 || sampleAge < -1000);
  const receiptStale = !Number.isFinite(age) || age > 10000 || age < -1000;
  if (!receiptStale && !hardwareStale) return live;
  return { ...live, cpuTempC: null, cpuPowerW: null, cpuVoltageV: null, cpuClockMHz: null,
    powerLimits: null, cpuNote: 'stale', freshness: 'stale',
    ...(receiptStale ? { cpuLoad: null, ramUsedBytes: null, ramTotalBytes: null } : {}) };
}
