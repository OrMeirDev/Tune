// Formatting helpers shared by the pages (sizes, dates, temperatures, rich text).
// Keeps "8.67 GB" in reading order inside Hebrew text (harmless in English).
export const ltr = (s) => '⁦' + s + '⁩';

export const fmtGB = (b) => ltr(b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);

export const fmtDate = (iso, t) => (iso ? new Date(iso).toLocaleString(t.locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// Intel stamps some chipset drivers 1968-07-18 on purpose; it is not an old driver.
export const shownDate = (d) => (!d || d.startsWith('1968') ? '—' : d);

export const errText = (e, t) => ({
  cancelled: t('err.cancelled'),
  'admin session ended': t('err.adminEnded'),
  'checksum mismatch': t('err.checksum'),
  'signature check failed': t('err.signature'),
  'results are out of date: scan again': t('err.stale'),
  busy: t('err.busy'),
  'not entitled': t('err.notEntitled'),
  // the request reached the service or the helper, but no answer came: it may have run
  'no answer in time': t('err.noAnswer'),
  'the connection closed without an answer': t('err.noAnswer'),
}[e] || t('err.generic', { e }));

export const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export const tempClass = (c) => (c == null ? '' : c >= 85 ? 'temp-hot' : c >= 70 ? 'temp-warm' : 'temp-ok');

// "**bold**" inside a translated string.
export const rich = (s) => String(s).split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));

// A translated label when the key is known; otherwise the stored text (older history entries).
export const tOr = (t, key, fallback) => { const s = t(key); return s === key ? fallback : s; };

// Pull the version out of a Windows Update driver title such as "Intel ... Update (24.70.0.4)".
export const titleVersion = (s = '') => (s.match(/(\d+\.\d+(?:\.\d+){1,2})(?!.*\d+\.\d+)/) || [])[1] || null;

// Why a sensor has no reading yet, in the user's terms.
export const cpuNoteKey = (n) => ({ 'no service': 'cpuNote.noService', 'pawnio not installed': 'cpuNote.pawnio', 'cpu not supported yet': 'cpuNote.unsupported' }[n] || 'cpuNote.unavailable');

export const rpm = (n, t) => ltr(`${Number(n).toLocaleString(t.locale)} RPM`);

// "Why is my PC hot?": a plain-language finding from the CPU readings.
// At rest a CPU usually sits around 30–50°C; warmer than that at idle is worth explaining. Modern
// CPUs jump 20°C for a fraction of a second on every small task, so one reading says little: the
// finding uses the median of the last 30 seconds, and only the moments the CPU was at rest.
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
