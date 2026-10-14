// The words for the licence: its state, its dates, and what the last licensing action came to.
import { fmtDate } from '../../presentation/format.jsx';

// "Active · tune-pro · certificate until … · licence until … · last checked …"
export function licenseLines(lic, t) {
  if (!lic) return [];
  const lines = [t(`lic.s.${lic.state}`)];
  if (lic.planId) lines.push(t('lic.plan', { plan: lic.planId }));
  if (lic.certificateExpiresAt && ['active', 'expired'].includes(lic.state)) lines.push(t(lic.state === 'expired' ? 'lic.certEnded' : 'lic.certUntil', { date: fmtDate(new Date(lic.certificateExpiresAt).toISOString(), t) }));
  if (lic.licenseExpiresAt) lines.push(t('lic.licenseUntil', { date: fmtDate(new Date(lic.licenseExpiresAt).toISOString(), t) }));
  if (lic.lastCheckAt) lines.push(t('lic.lastCheck', { date: fmtDate(new Date(lic.lastCheckAt).toISOString(), t) }));
  if (lic.lastCheckFailedAt) lines.push(t('lic.lastCheckFailed', { date: fmtDate(new Date(lic.lastCheckFailedAt).toISOString(), t) }));
  return lines;
}

// Results that end well (the rest are shown as something to act on).
export const GOOD = ['codeSent', 'ownerVerified', 'activated', 'recovered', 'refreshed'];

export function outcomeText(o, t) {
  if (!o) return '';
  const key = `lic.o.${o.result}`;
  const s = t(key, { n: o.attemptsLeft ?? o.deviceLimit ?? '', s: o.retryAfterSeconds ?? '' });
  return s === key ? t('lic.o.failed') : s;
}
