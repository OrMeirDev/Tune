// What Tune measures, and when a "before" and an "after" may be compared (plan PF02). A change is
// credited with an effect only when both measurements were taken the same way, under the same
// conditions; otherwise both are shown side by side and nothing is claimed. No improvement and a
// change for the worse are reported as plainly as an improvement.
// Pure: no Node, Electron or Windows calls (tested in tests/measurement-policy.test.cjs).

// unit: what the value is in; better: which direction is an improvement; noise: a difference this
// small (or smaller) is normal variation between two measurements, not an effect of a change.
const METRICS = {
  // free space on the system drive, from the file system (before and after a cleanup)
  diskFreeBytes: { unit: 'bytes', better: 'higher', noise: () => 1e6, kind: 'disk' },
  // the PC at rest with Tune open: median of readings 2 seconds apart
  restCpuLoad: { unit: '%', better: 'lower', noise: () => 3, kind: 'rest' },
  restCpuTempC: { unit: '°C', better: 'lower', noise: () => 2, kind: 'rest' },
  restRamUsedBytes: { unit: 'bytes', better: 'lower', noise: () => 300e6, kind: 'rest' },
  // Windows' own start-up timing: from power-on to the desktop, and from the desktop until the PC
  // settles (where the apps that start with Windows load). Starts vary by a few seconds each time.
  bootToDesktopMs: { unit: 'ms', better: 'lower', noise: (v) => Math.max(2000, v * 0.1), kind: 'boot' },
  bootAfterLogonMs: { unit: 'ms', better: 'lower', noise: (v) => Math.max(2000, v * 0.1), kind: 'boot' },
};

// How each start of Windows began (Kernel-Boot event 27). A Fast Startup start resumes a saved
// kernel and is much quicker than a full one, so starts of different kinds are never compared.
const BOOT_TYPES = { 0: 'full', 1: 'fastStartup', 2: 'hibernate' };

// A rest measurement needs this many readings; fewer is "not measured", not a number.
const MIN_REST_SAMPLES = 5;
// Below this median CPU load the PC counts as at rest; a busier measurement is kept but compared
// only with other busy ones (never credited to a change).
const REST_LOAD = 20;
// A rest "before" older than this is not compared: the room, the season and the PC's use change.
const REST_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
// Changes to Windows that can move a start-up time or a reading at rest. A change's measurements are
// only those taken after the previous such change and before the next one, so an effect is never
// credited to the wrong change. A cleanup only deletes files (it has its own before/after pair);
// downloads and restore points change nothing that is measured.
const BOUNDARIES = ['startup', 'setting', 'drivers', 'enable', 'service', 'serviceOperation'];
// What a change could have affected, and how the "after" is taken (see actionComparisons).
const EFFECTS = {
  clean: { metrics: ['diskFreeBytes'], paired: true },
  startup: { metrics: ['bootAfterLogonMs', 'bootToDesktopMs'] },
  // only the power plan changes anything at rest; Game Mode and GPU scheduling show in games (PF06)
  setting: { metrics: ['restCpuTempC', 'restCpuLoad'], only: ['power'] },
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const median = (a) => {
  const s = a.filter(isNum).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d = 0) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
// Windows writes 7 decimal places of seconds; Date.parse needs at most 3.
const parseTime = (s) => {
  const t = Date.parse(String(s || '').replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? null : t;
};
const iso = (t) => new Date(t).toISOString();

// One measurement. `value` null means it couldn't be taken, and `missing` says why.
function record({ metric, value, at, method, conditions = {}, key, actionId, phase, missing, extra }) {
  const m = METRICS[metric];
  if (!m) throw new Error(`unknown metric ${metric}`);
  const r = { metric, value: isNum(value) ? value : null, unit: m.unit, at, method, conditions };
  if (r.value == null) r.missing = missing || 'notMeasured';
  if (key) r.key = key;
  if (actionId) r.actionId = actionId;
  if (phase) r.phase = phase;
  if (extra) r.extra = extra;
  return r;
}

// A stored record is used only if it has this shape (the file could be old or edited by hand).
const validRecord = (r) => !!r && typeof r === 'object' && !!METRICS[r.metric] && parseTime(r.at) != null
  && (r.value === null || isNum(r.value)) && typeof r.method === 'string';

// The rest measurement from readings taken a couple of seconds apart. `sensor` says why there was
// no CPU temperature when none came back ('noService', or the service's own note).
function summarizeRest(samples, { at, seconds, sensor }) {
  const loads = samples.map((s) => s.cpuLoad).filter(isNum);
  const temps = samples.map((s) => s.cpuTempC).filter(isNum);
  const ram = samples.map((s) => s.ramUsedBytes).filter(isNum);
  const enough = loads.length >= MIN_REST_SAMPLES;
  const load = enough ? median(loads) : null;
  const conditions = { loadBand: load == null ? null : load < REST_LOAD ? 'rest' : 'busy', seconds, samples: loads.length };
  const base = { at, method: 'restSampling', conditions };
  return [
    record({ ...base, metric: 'restCpuLoad', value: round(load), missing: 'tooFewSamples' }),
    record({ ...base, metric: 'restCpuTempC', value: enough && temps.length >= MIN_REST_SAMPLES ? round(median(temps), 1) : null, missing: !enough || temps.length ? 'tooFewSamples' : sensor || 'noSensor' }),
    record({ ...base, metric: 'restRamUsedBytes', value: enough && ram.length >= MIN_REST_SAMPLES ? median(ram) : null, missing: 'tooFewSamples' }),
  ];
}

// Free space before and after a change on the same drive, as a pair linked to that change.
function diskPair(before, after, { actionId, at }) {
  const rec = (d, phase) => record({
    metric: 'diskFreeBytes', value: d?.freeBytes, at: d?.at || at, method: 'fileSystem', conditions: { drive: d?.drive || null },
    actionId, phase, missing: 'notRead',
  });
  return [rec(before, 'before'), rec(after, 'after')];
}

// Which start a Kernel-Boot event 27 belongs to. It is written a few seconds into a start, so it
// belongs to the recorded start that began most recently before it (a few seconds' leeway for the two
// clocks), and only if it came soon after that start began; one written later belongs to a start
// Windows didn't time.
const KIND_SKEW_MS = 5000;
const KIND_WINDOW_MS = 120000;

// Windows' start-up timings (Diagnostics-Performance event 100), each with the kind of start it was
// (Kernel-Boot event 27). Two starts close together each get their own event; a start with no event of
// its own, or with two that disagree, stays 'unknown' and is never compared.
function bootRecords({ timings = [], types = [] }) {
  const kinds = types.map((t) => ({ at: parseTime(t.at), code: t.code })).filter((t) => t.at != null);
  const starts = timings.map((t) => parseTime(t.startedAt)).filter((s) => s != null).sort((a, b) => a - b);
  const ownerOf = (k) => starts.filter((s) => s <= k.at + KIND_SKEW_MS).at(-1);
  const out = [];
  for (const t of timings) {
    const at = parseTime(t.at);
    if (at == null) continue;
    const started = parseTime(t.startedAt);
    // without the start's own beginning there is no telling which event 27 is its own
    const own = started == null ? [] : kinds.filter((k) => ownerOf(k) === started && k.at - started <= KIND_WINDOW_MS);
    const codes = [...new Set(own.map((k) => k.code))];
    const bootType = codes.length === 1 ? BOOT_TYPES[codes[0]] || 'unknown' : 'unknown';
    const startedAt = iso(started ?? (isNum(t.bootMs) ? at - t.bootMs : at));
    const conditions = { bootType, startedAt };
    const extra = isNum(t.startupApps) ? { startupApps: t.startupApps } : undefined;
    for (const [metric, value] of [['bootToDesktopMs', t.mainPathMs], ['bootAfterLogonMs', t.postBootMs]]) {
      if (!isNum(value)) continue;
      out.push(record({ metric, value, at: iso(at), method: 'windowsBootLog', conditions, key: `boot:${startedAt}:${metric}`, extra }));
    }
  }
  return out;
}

// What the start-up check found besides the timings: whether Fast Startup is on (it needs
// hibernation too), whether Windows sits on an SSD or a hard disk, how the last start began, and
// whether Windows let Tune read its start-up timing ('ok', 'none' recorded yet, 'needsAdmin',
// 'unavailable'). Anything unreadable stays unknown (null / 'unknown'), never a default.
function bootFacts(raw = {}) {
  const fastStartup = raw.hiberboot === 1 ? raw.hibernate !== 0 : raw.hiberboot === 0 ? false : null;
  const media = String(raw.media || '');
  const systemMedia = /^(SSD|SCM)$/i.test(media) || /^NVMe$/i.test(String(raw.bus || '')) ? 'ssd' : /^HDD$/i.test(media) ? 'hdd' : 'unknown';
  const last = [].concat(raw.types || []).map((t) => ({ at: parseTime(t?.at), code: t?.code })).filter((t) => t.at != null).sort((a, b) => a.at - b.at).at(-1);
  const timings = ['ok', 'none', 'needsAdmin', 'unavailable'].includes(raw.timingStatus) ? raw.timingStatus : 'unavailable';
  return { fastStartup, systemMedia, lastBootType: last ? BOOT_TYPES[last.code] || 'unknown' : 'unknown', timings };
}

// Whether two measurements were taken in a way that makes a difference between them meaningful.
function comparable(a, b) {
  if (!a || !b || a.metric !== b.metric) return { ok: false, reason: 'differentMetric' };
  if (a.value == null || b.value == null) return { ok: false, reason: 'missing' };
  if (a.method !== b.method) return { ok: false, reason: 'differentMethod' };
  const ca = a.conditions || {};
  const cb = b.conditions || {};
  const kind = METRICS[a.metric].kind;
  if (kind === 'rest' && (ca.loadBand !== 'rest' || cb.loadBand !== 'rest')) return { ok: false, reason: 'notAtRest' };
  if (kind === 'boot' && (!ca.bootType || ca.bootType === 'unknown' || ca.bootType !== cb.bootType)) return { ok: false, reason: 'differentBootType' };
  if (kind === 'disk' && (!ca.drive || ca.drive !== cb.drive)) return { ok: false, reason: 'differentDrive' };
  return { ok: true };
}

// The difference between a before and an after: 'better', 'worse', 'same' (within normal
// variation), 'notComparable' (both shown, nothing claimed) or 'missing'.
function compare(before, after) {
  const c = comparable(before, after);
  if (!c.ok) return { state: c.reason === 'missing' ? 'missing' : 'notComparable', reason: c.reason, before: before || null, after: after || null };
  const m = METRICS[before.metric];
  const delta = after.value - before.value;
  const state = Math.abs(delta) <= m.noise(before.value) ? 'same' : (delta < 0) === (m.better === 'lower') ? 'better' : 'worse';
  return { state, delta, unit: m.unit, before, after };
}

// Several comparable measurements as one (their median), so a single unusual start or a short
// burst of background work doesn't decide the outcome.
function combined(list) {
  if (list.length === 1) return list[0];
  return { ...list[0], value: median(list.map((r) => r.value)), count: list.length, from: list.map((r) => r.at) };
}

const startOf = (r) => parseTime(r.conditions?.startedAt || r.at);

// The before and after for one measure around a change made at time `t`, from the measurements taken
// on their own (rest measurements, starts of Windows), within the change's own window: after the
// previous change (`prev`) and before the next one (`next`). The after is the first one taken after
// the change (up to 3 comparable ones combined); the before, up to 3 comparable ones just before it.
function aroundChange(metric, t, records, { prev = -Infinity, next = Infinity } = {}) {
  const usable = records.filter((r) => r.metric === metric && r.value != null).sort((a, b) => startOf(a) - startOf(b));
  const beforeAll = usable.filter((r) => startOf(r) > prev && startOf(r) < t);
  const after = usable.filter((r) => startOf(r) > t && startOf(r) < next);
  // measurements from before the previous change, which this change's before must not use
  const earlier = usable.some((r) => startOf(r) <= prev);
  const lastBefore = beforeAll.at(-1) || null;
  if (!after.length) {
    // the next change came before anything was measured: this change can't be measured on its own
    if (next !== Infinity) return { metric, state: 'notComparable', reason: 'anotherChange', before: lastBefore, after: null };
    return { metric, state: 'waiting', before: lastBefore };
  }
  // the first after that has something comparable before it (a busy rest measurement or a start
  // of another kind is skipped when a later one matches)
  const first = after.find((x) => beforeAll.some((r) => comparable(r, x).ok)) || after[0];
  const afters = after.filter((r) => startOf(r) >= startOf(first) && comparable(first, r).ok).slice(0, 3);
  const befores = beforeAll.filter((r) => comparable(r, first).ok).slice(-3);
  if (!befores.length) {
    // nothing comparable before: show what there is, claim nothing
    const reason = beforeAll.length ? comparable(lastBefore, first).reason : earlier ? 'anotherChange' : 'noBefore';
    return { metric, state: beforeAll.length || earlier ? 'notComparable' : 'missing', reason, before: lastBefore, after: first };
  }
  if (METRICS[metric].kind === 'rest' && t - startOf(befores.at(-1)) > REST_MAX_AGE_MS) {
    return { metric, state: 'notComparable', reason: 'beforeTooOld', before: befores.at(-1), after: first };
  }
  return { metric, ...compare(combined(befores), combined(afters)) };
}

// What each change Tune made did to the measurements (plan PF02.3), newest change first. Cleanup is
// measured right before and after (the same change ID); a startup change shows up only at the next
// start of Windows, and a power-plan change at the next rest measurement. Until that "after" exists
// the change is 'waiting' for it, and it is never shown as an improvement in the meantime. `actions`
// is the whole history: every change to Windows in it bounds its neighbours' windows.
function actionComparisons(actions = [], records = [], { limit = 15 } = {}) {
  const valid = actions.filter((a) => a && parseTime(a.at) != null);
  const changes = valid.filter((a) => EFFECTS[a.action]);
  const bounds = valid.filter((a) => BOUNDARIES.includes(a.action)).map((a) => parseTime(a.at));
  return changes.slice(0, limit).map((a) => {
    const eff = EFFECTS[a.action];
    const base = { id: a.id || null, action: a.action, detail: a.detail || {}, at: a.at };
    if (eff.only && !eff.only.includes(a.detail?.key)) return { ...base, results: [], note: 'notMeasurableAtRest' };
    const results = eff.metrics.map((metric) => {
      if (eff.paired) {
        const mine = records.filter((r) => a.id && r.actionId === a.id && r.metric === metric);
        const before = mine.find((r) => r.phase === 'before');
        const after = mine.find((r) => r.phase === 'after');
        if (!before && !after) return { metric, state: 'missing', reason: 'notRecorded' };
        return { metric, ...compare(before, after) };
      }
      const t = parseTime(a.at);
      const prev = Math.max(-Infinity, ...bounds.filter((x) => x < t));
      const next = Math.min(Infinity, ...bounds.filter((x) => x > t));
      return aroundChange(metric, t, records, { prev, next });
    });
    return { ...base, results };
  });
}

// The newest measurement of each kind, for the "latest measurements" list.
function latestByMetric(records = []) {
  const out = {};
  for (const r of records) {
    if (!METRICS[r.metric]) continue;
    const cur = out[r.metric];
    // a before and an after taken in the same instant: the after is the latest
    if (!cur || parseTime(r.at) > parseTime(cur.at) || (parseTime(r.at) === parseTime(cur.at) && r.phase === 'after')) out[r.metric] = r;
  }
  return out;
}

// Windows' filtered query can hide access denial behind NoMatchingEventsFound. A log with no
// event 100 counts as empty only after an independent, read-only access probe succeeded.
function bootTimingStatus({ timingQuery, timingLog } = {}) {
  if (timingQuery === 'denied' || timingLog === 'denied') return 'needsAdmin';
  if (timingQuery === 'ok') return 'ok';
  if (timingQuery === 'noMatch' && ['readable', 'empty'].includes(timingLog)) return 'none';
  return 'unavailable';
}

module.exports = { bootTimingStatus,
  METRICS, BOOT_TYPES, MIN_REST_SAMPLES, REST_LOAD, EFFECTS, BOUNDARIES,
  median, record, validRecord, summarizeRest, diskPair, bootRecords, bootFacts, comparable, compare, aroundChange, actionComparisons, latestByMetric,
};
