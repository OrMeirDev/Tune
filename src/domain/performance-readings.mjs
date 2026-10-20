import { freshLive } from './live-freshness.mjs';

// Process lists are snapshots; top-level gauges must stop looking live once a read is too old.
export function performanceReadings(live, perf, now = Date.now()) {
  const age = now - Date.parse(perf?.refreshedAt || '');
  const fresh = Number.isFinite(age) && age >= -1000 && age <= 10000;
  const current = freshLive(live, now);
  const valid = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const ramTotalGB = current ? (valid(current.ramTotalBytes) ? current.ramTotalBytes / 1024 ** 3 : null) : fresh && valid(perf?.ramTotalGB) ? perf.ramTotalGB : null;
  const ramUsedGB = current ? (valid(current.ramUsedBytes) ? current.ramUsedBytes / 1024 ** 3 : null) : fresh && valid(perf?.ramFreeGB) && ramTotalGB != null ? ramTotalGB - perf.ramFreeGB : null;
  return {
    cpuLoad: current ? current.cpuLoad : fresh ? perf.cpuLoad : null,
    ramUsedGB, ramFreeGB: ramTotalGB != null && ramUsedGB != null ? ramTotalGB - ramUsedGB : null,
    gpu: current?.gpuTemps?.[0] || (fresh ? perf?.gpuTemps?.[0] : null) || null,
    live: current || (fresh ? perf : null),
  };
}
