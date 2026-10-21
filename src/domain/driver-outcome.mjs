// Windows Update OperationResultCode: 3 means partial success, never a full installation.
export const driverOutcome = code => ({ 2: 'installed', 3: 'partial', 4: 'failed', 5: 'aborted' }[code] || 'unknown');
export function summarizeDrivers(results, total) {
  const list = Array.isArray(results) ? results : [];
  const out = { installed: 0, partial: 0, failed: 0, aborted: 0, unknown: Math.max(0, total - list.length) };
  for (const r of list) out[driverOutcome(r?.code)]++;
  return out;
}
