const MAX_AGE_MS = 10000;
const numberIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
function sensorSnapshot(data, now = Date.now()) {
  const d = data || {}, stamp = typeof d.sampledAt === 'string' ? Date.parse(d.sampledAt) : NaN, age = now - stamp;
  const freshness = !Number.isFinite(stamp) ? 'unverified' : age < -1000 || age > MAX_AGE_MS ? 'stale' : 'fresh';
  const fresh = freshness === 'fresh', source = ['core', 'vid'].includes(d.cpuVoltageSource) ? d.cpuVoltageSource : null;
  return {
    sampledAt: Number.isFinite(stamp) ? d.sampledAt : null, freshness,
    cpuTempC: fresh ? numberIn(d.cpuTempC, 1, 149) : null,
    cpuPowerW: fresh ? numberIn(d.cpuPowerW, 0, 1000) : null,
    cpuVoltageV: fresh && source ? numberIn(d.cpuVoltageV, 0.3, 2) : null,
    cpuVoltageSource: source, cpuClockMHz: fresh ? numberIn(d.cpuClockMHz, 0, 10000) : null,
    powerLimits: fresh ? d.powerLimits ?? null : null,
    cpuNote: fresh ? d.cpuNote ?? null : freshness,
    gpus: fresh ? [].concat(d.gpus || []).filter(g => g && numberIn(g.tempC, 1, 149) != null) : [],
  };
}
function mergeGpuReadings(service, windows = []) {
  const key = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return service.map(g => ({ ...g, fanRpm: windows.find(w => key(w.name) === key(g.name))?.fanRpm ?? null }));
}
module.exports = { sensorSnapshot, mergeGpuReadings, MAX_AGE_MS };
