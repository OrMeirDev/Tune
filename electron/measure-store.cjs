// Tune's local measurement history (plan PF02.3): every measurement it took, in the profile folder,
// never sent anywhere. Written atomically (temp file, then rename) so a crash can't leave half a
// file, capped in size, and a start of Windows read again from its log isn't stored twice (same key).
// Node's `fs` and `path` only; tested with a throwaway folder in tests/measure-store.test.cjs.
const fs = require('fs');
const path = require('path');
const { actionComparisons, compare, diskPair, latestByMetric, validRecord } = require('./domain/measurement-policy.cjs');
const { csvCell } = require('./report.cjs');

function createMeasureStore({ file, max = 3000 }) {
  let cache = null;
  const read = () => {
    if (!cache) {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        // one malformed entry is skipped, not allowed to break the rest
        cache = Array.isArray(v) ? v.filter(validRecord) : [];
      } catch { cache = []; }
    }
    return cache;
  };
  const write = (list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(list));
    fs.renameSync(`${file}.tmp`, file);
  };
  const byTimeDesc = (a, b) => Date.parse(b.at) - Date.parse(a.at);

  // Adds what is new and returns it; records with a key already stored are left out.
  function add(records) {
    const list = read();
    const keys = new Set(list.map((r) => r.key).filter(Boolean));
    const fresh = [].concat(records || []).filter((r) => validRecord(r) && !(r.key && keys.has(r.key)));
    if (!fresh.length) return [];
    cache = [...fresh, ...list].sort(byTimeDesc).slice(0, max);
    // A failed write (a full disk) must never fail the change it measured: the measurement stays
    // for this session, and the next successful write saves it.
    try { write(cache); } catch { /* kept in memory */ }
    return fresh;
  }

  return {
    list: () => read(),
    add,
    // Free space right before and right after a change (`before`/`after` from diskFree), stored as a
    // pair linked to that change; returns what the pair shows (see compare).
    addDiskPair(before, after, actionId) {
      const [b, a] = diskPair(before, after, { actionId, at: new Date().toISOString() });
      add([b, a]);
      return compare(b, a);
    },
    // What the pages show: the newest measurements, the latest of each kind, and what each change in
    // `actions` (the history, newest first) did to them.
    view(actions) {
      const list = read();
      return { records: list.slice(0, 200), latest: latestByMetric(list), changes: actionComparisons([].concat(actions || []), list) };
    },
    // The history as a spreadsheet (CSV, opens in Excel), newest first, in English like the
    // hardware report so it can be attached to a support request as is.
    csv() {
      const head = ['Time (UTC)', 'Measurement', 'Value', 'Unit', 'Not measured because', 'Method', 'Conditions', 'Change ID', 'Before/after'];
      const rows = read().map((r) => [
        r.at, r.metric, r.value ?? '', r.unit, r.missing || '', r.method,
        Object.entries(r.conditions || {}).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join('; '),
        r.actionId || '', r.phase || '',
      ]);
      return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    },
  };
}

module.exports = { createMeasureStore };
