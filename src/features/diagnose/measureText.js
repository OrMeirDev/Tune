// The words and numbers for measurements and before/after results.
import { fmtGB, ltr } from '../../presentation/format.jsx';

const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0);

// A measured value in its own unit, kept in reading order inside Hebrew text.
export function fmtMeasure(value, unit, t) {
  if (value == null) return '—';
  if (unit === 'bytes') return fmtGB(value);
  // only the number is kept left-to-right; the unit is a word ("שנ׳") that follows it in Hebrew order
  if (unit === 'ms') return `${ltr(secs(value))} ${t ? t('unit.s') : 's'}`;
  if (unit === '°C') return ltr(`${Math.round(value)}°C`);
  if (unit === '%') return ltr(`${Math.round(value)}%`);
  return ltr(String(value));
}

// The size of a difference, with its sign ("+1.20 GB", "−4 s").
export function fmtDelta(delta, unit, t) {
  if (delta == null) return '';
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  if (unit === 'ms') return `${ltr(sign + secs(Math.abs(delta)))} ${t ? t('unit.s') : 's'}`;
  return ltr(sign + fmtMeasure(Math.abs(delta), unit, t).replace(/[\u2066\u2069]/g, ''));
}

// What a measurement is about, and what kind of start a start-up time comes from.
export const metricName = (metric, t) => t(`m.${metric}`);
export const bootKind = (kind, t) => t(`m.boot.${kind || 'unknown'}`);
