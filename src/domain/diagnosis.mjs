// Diagnosis by the problem the user picks (plan PF01): which checks fit that problem, what each one
// found, how sure Tune is, and the one thing to do about it. Uses the scans and sensors Tune already
// has; nothing here measures or changes anything. Pure (no React, no Electron); tested in
// tests/diagnosis.test.cjs.
//
// Each finding:
//   key        which check (its words live in the dictionary under dx.<key>.*)
//   ok         false: a problem found · true: checked and fine · null: not checked / still checking
//   certainty  'measured'   Tune measured it on this PC (a temperature, a load, a start-up time)
//              'suspected'  a known cause is present on this PC; that it causes this problem is not measured
//              'unknown'    it couldn't be checked (`say` tells why); never shown as fine
//              'pending'    still checking
//   impact     'high' | 'medium' | 'low' (for problems: how much it is likely to matter)
//   say        which wording to use (dx.<key>.<say>), vars: the numbers in it
//   action     one next step: { kind: 'go', page } · { kind: 'apply', rec } · { kind: 'guide', rec }
//              · { kind: 'installService' } · { kind: 'recheck' } · null (nothing to click; the text says what to do)

export const PROBLEMS = ['slowBoot', 'gameStutter', 'overheating'];

// Thresholds. The start-up and load numbers are Tune's own judgement for a PC with an SSD (no vendor
// publishes one); the temperature ones match the cooling findings on the CPU page and the performance
// center, so the pages never disagree.
export const LIMITS = {
  bootToDesktopMs: 45000, // power-on to the desktop
  bootAfterLogonMs: 60000, // the desktop until the PC settles (startup apps load here)
  startupApps: 12, // as in the performance center
  backgroundLoad: 25, // % CPU with Tune open and nothing else asked of the PC
  ramUsed: 0.85, // share of memory in use
  restLoad: 20, // below this the CPU counts as at rest
  cpuRestWarm: 55, cpuRestHot: 70, // °C at rest (a CPU usually rests at 30–50°C)
  cpuHot: 90, // °C over the last half minute, at any load
  gpuWarm: 70, gpuHot: 85, // °C
  minSamples: 5, // live readings (2 s apart) before a reading counts
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const median = (a) => {
  const s = a.filter(isNum).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const secs = (ms) => Math.round(ms / 1000);
const pending = (key) => ({ key, ok: null, certainty: 'pending', impact: 'low', say: 'pending', vars: {}, action: null });
const unknown = (key, say, action = null, vars = {}) => ({ key, ok: null, certainty: 'unknown', impact: 'low', say, vars, action });
const fine = (key, say = 'ok', vars = {}) => ({ key, ok: true, certainty: 'measured', impact: 'low', say, vars, action: null });
const problem = (key, { impact, certainty, say, vars = {}, action = null }) => ({ key, ok: false, impact, certainty, say, vars, action });

// The live readings of the last half minute, summarized; null where there are too few to count.
export function liveStats(samples = []) {
  const s = samples.filter(Boolean);
  const enough = (a) => (a.length >= LIMITS.minSamples ? median(a) : null);
  const loads = s.map((x) => x.cpuLoad).filter(isNum);
  const temps = s.map((x) => x.cpuTempC).filter(isNum);
  const restTemps = s.filter((x) => isNum(x.cpuTempC) && isNum(x.cpuLoad) && x.cpuLoad < LIMITS.restLoad).map((x) => x.cpuTempC);
  const ram = s.filter((x) => isNum(x.ramUsedBytes) && x.ramTotalBytes > 0).map((x) => x.ramUsedBytes / x.ramTotalBytes);
  return {
    n: s.length, load: enough(loads), temp: enough(temps), restTemp: enough(restTemps), ram: enough(ram),
    noService: s.some((x) => x.cpuNote === 'no service'),
  };
}

// A check that reads the performance center's list: still loading, failed, or not on this PC.
function fromRec(input, key, fn) {
  if (input.sources?.recs === 'error') return unknown(key, 'scanFailed', { kind: 'recheck' });
  if (!input.recs) return pending(key);
  const r = input.recs.find((x) => x.key === key);
  return r ? fn(r) : null;
}
const applyOrGo = (r) => (r.action ? { kind: 'apply', rec: r.key } : { kind: 'go', page: 'recs' });

// ---- the checks ----

function bootTimes({ boot }) {
  if (!boot) return [pending('bootToDesktop')];
  const { facts = {}, latest = {} } = boot;
  const desk = latest.bootToDesktopMs;
  const after = latest.bootAfterLogonMs;
  if (!desk && !after) {
    // needsAdmin: Windows keeps its start-up timing to administrators · none: no start recorded yet
    // · busy: Tune was measuring something else · unavailable: the log couldn't be read
    const why = ['needsAdmin', 'none', 'busy'].includes(facts.timings) ? facts.timings : 'unavailable';
    return [unknown('bootToDesktop', why, ['busy', 'unavailable'].includes(why) ? { kind: 'recheck' } : null)];
  }
  const out = [];
  const kind = (r) => r.conditions?.bootType || 'unknown';
  const when = (r) => r.conditions?.startedAt || r.at;
  if (desk && desk.value != null) {
    out.push(desk.value <= LIMITS.bootToDesktopMs
      ? fine('bootToDesktop', 'ok', { s: secs(desk.value), kind: kind(desk), at: when(desk) })
      : problem('bootToDesktop', { impact: desk.value > 2 * LIMITS.bootToDesktopMs ? 'high' : 'medium', certainty: 'measured', say: 'slow', vars: { s: secs(desk.value), kind: kind(desk), at: when(desk) } }));
  }
  if (after && after.value != null) {
    const vars = { s: secs(after.value), kind: kind(after), at: when(after) };
    out.push(after.value <= LIMITS.bootAfterLogonMs
      ? fine('bootAfterLogon', 'ok', vars)
      : problem('bootAfterLogon', { impact: after.value > 2 * LIMITS.bootAfterLogonMs ? 'high' : 'medium', certainty: 'measured', say: 'slow', vars, action: { kind: 'go', page: 'startup' } }));
  }
  return out;
}

function startupApps({ startup, sources = {}, boot }) {
  if (sources.startup === 'error') return unknown('startupApps', 'scanFailed', { kind: 'recheck' });
  if (!startup) return pending('startupApps');
  const n = startup.filter((s) => s.enabled).length;
  if (n <= LIMITS.startupApps) return fine('startupApps', 'ok', { n });
  // measured slow after the desktop appears: the startup apps are the likely reason, not a maybe
  const afterSlow = boot?.latest?.bootAfterLogonMs?.value > LIMITS.bootAfterLogonMs;
  return problem('startupApps', { impact: afterSlow ? 'high' : 'medium', certainty: 'suspected', say: 'many', vars: { n }, action: { kind: 'go', page: 'startup' } });
}

function systemDrive({ boot }) {
  if (!boot) return pending('systemDrive');
  const m = boot.facts?.systemMedia;
  if (m === 'ssd') return fine('systemDrive', 'ssd');
  if (m === 'hdd') return problem('systemDrive', { impact: 'high', certainty: 'suspected', say: 'hdd' });
  return unknown('systemDrive', 'unreadable');
}

function fastStartup({ boot }) {
  const on = boot?.facts?.fastStartup;
  if (on == null) return null; // unreadable: not worth a row of its own
  return on ? fine('fastStartup', 'on') : problem('fastStartup', { impact: 'low', certainty: 'suspected', say: 'off' });
}

function diskSpace(input, impact) {
  return fromRec(input, 'disk', (r) => (r.ok === false
    ? problem('diskSpace', { impact, certainty: 'measured', say: 'low', vars: { free: r.freeGB, size: r.sizeGB }, action: { kind: 'go', page: 'clean' } })
    : fine('diskSpace', 'ok', { free: r.freeGB, size: r.sizeGB })));
}

function gpuDriver({ gpu, sources = {} }) {
  if (sources.gpu === 'error') return unknown('gpuDriver', 'scanFailed', { kind: 'go', page: 'updates' });
  if (!gpu) return pending('gpuDriver');
  // the graphics cards Tune checks with their maker (Intel's come through Windows Update)
  const cards = gpu.filter((g) => g.vendor !== 'Intel' && g.latest);
  if (!cards.length) return null;
  const g = cards.find((x) => x.newer && x.url);
  return g
    ? problem('gpuDriver', { impact: 'medium', certainty: 'suspected', say: 'newer', vars: { v: g.latest, vendor: g.vendor }, action: { kind: 'go', page: 'updates' } })
    : fine('gpuDriver', 'latest', { vendor: cards[0].vendor });
}

const powerForGames = (input) => fromRec(input, 'power', (r) => (r.plan === 'saver'
  ? problem('powerPlan', { impact: 'high', certainty: 'suspected', say: 'saver', action: applyOrGo(r) })
  : fine('powerPlan', 'notLimiting')));

const powerForHeat = (input) => fromRec(input, 'power', (r) => (r.ok === false && ['high', 'ultimate'].includes(r.plan)
  ? problem('powerPlan', { impact: 'medium', certainty: 'suspected', say: 'fullSpeed', action: applyOrGo(r) })
  : fine('powerPlan', 'notHeating')));

const windowsSetting = (key, recKey) => (input) => fromRec(input, recKey, (r) => (r.ok === false
  ? problem(key, { impact: 'low', certainty: 'suspected', say: 'off', action: applyOrGo(r) })
  : fine(key, 'on')));

const memChannels = (input) => fromRec(input, 'memChannels', (r) => {
  if (r.ok === true) return fine('memChannels', 'dual');
  if (r.ok === false) return problem('memChannels', { impact: 'medium', certainty: 'suspected', say: 'single', vars: { n: r.sticks }, action: r.guide ? { kind: 'guide', rec: 'memChannels' } : { kind: 'go', page: 'recs' } });
  // a laptop with one stick: nothing to change; unreadable slot names: unknown
  return r.channels == null ? unknown('memChannels', 'unreadable') : null;
});

const memSpeed = (input) => fromRec(input, 'memSpeed', (r) => {
  if (r.ok === true) return fine('memSpeed', 'ok', { now: r.configured });
  if (r.ok === false) return problem('memSpeed', { impact: 'medium', certainty: 'suspected', say: 'slow', vars: { now: r.configured, rated: r.rated, profile: r.profile }, action: { kind: 'guide', rec: 'memSpeed' } });
  return unknown('memSpeed', 'noRating', null, { now: r.configured });
});

function backgroundCpu({ samples, scanning }) {
  // Tune's own scan loads the CPU; a reading taken during it says nothing about the background
  if (scanning) return unknown('backgroundCpu', 'scanning', { kind: 'recheck' });
  const s = liveStats(samples);
  if (s.load == null) return pending('backgroundCpu');
  return s.load > LIMITS.backgroundLoad
    ? problem('backgroundCpu', { impact: 'medium', certainty: 'measured', say: 'busy', vars: { load: Math.round(s.load) }, action: { kind: 'go', page: 'perf' } })
    : fine('backgroundCpu', 'ok', { load: Math.round(s.load) });
}

function ramPressure({ samples = [] }) {
  const s = liveStats(samples);
  if (s.ram == null) return s.n >= LIMITS.minSamples ? unknown('ramPressure', 'unreadable') : pending('ramPressure');
  const pct = Math.round(s.ram * 100);
  return s.ram > LIMITS.ramUsed
    ? problem('ramPressure', { impact: 'medium', certainty: 'measured', say: 'high', vars: { pct }, action: { kind: 'go', page: 'perf' } })
    : fine('ramPressure', 'ok', { pct });
}

// Without the background service there is no CPU temperature in Windows to read.
function noTemp(key, s, service) {
  if (s.noService || (service && !service.running && s.n >= LIMITS.minSamples)) return unknown(key, 'noService', { kind: 'installService' });
  if (s.n < LIMITS.minSamples) return pending(key);
  return unknown(key, 'noSensor');
}

function cpuHot({ samples, service, recs }) {
  const s = liveStats(samples);
  if (s.temp == null) return noTemp('cpuHot', s, service);
  if (s.temp < LIMITS.cpuHot) return fine('cpuHot', 'ok', { t: Math.round(s.temp) });
  // lowering the power limit in the BIOS is the most effective fix where Tune has a guide for it
  const guide = (recs || []).some((r) => r.key === 'powerLimit' && r.guide);
  return problem('cpuHot', { impact: 'high', certainty: 'measured', say: 'hot', vars: { t: Math.round(s.temp) }, action: guide ? { kind: 'guide', rec: 'powerLimit' } : { kind: 'go', page: 'perf' } });
}

function cpuRestTemp({ samples, service, scanning }) {
  const s = liveStats(samples);
  if (s.temp == null) return noTemp('cpuRestTemp', s, service);
  if (s.restTemp == null) return unknown('cpuRestTemp', scanning ? 'scanning' : 'notAtRest', { kind: 'recheck' });
  const t = Math.round(s.restTemp);
  if (t >= LIMITS.cpuRestHot) return problem('cpuRestTemp', { impact: 'high', certainty: 'measured', say: 'hot', vars: { t } });
  if (t >= LIMITS.cpuRestWarm) return problem('cpuRestTemp', { impact: 'medium', certainty: 'measured', say: 'warm', vars: { t } });
  return fine('cpuRestTemp', 'ok', { t });
}

function gpuTemp({ perf, scanning }) {
  if (!perf) return scanning ? pending('gpuTemp') : unknown('gpuTemp', 'unreadable', { kind: 'go', page: 'perf' });
  const g = [].concat(perf.gpuTemps || []).filter((x) => x && isNum(x.tempC)).sort((a, b) => b.tempC - a.tempC)[0];
  if (!g) return null; // Windows reports no GPU temperature on this PC
  const vars = { t: Math.round(g.tempC), name: g.name || '' };
  if (g.tempC >= LIMITS.gpuHot) return problem('gpuTemp', { impact: 'high', certainty: 'measured', say: 'hot', vars, action: { kind: 'go', page: 'perf' } });
  if (g.tempC >= LIMITS.gpuWarm) return problem('gpuTemp', { impact: 'medium', certainty: 'measured', say: 'warm', vars, action: { kind: 'go', page: 'perf' } });
  return fine('gpuTemp', 'ok', vars);
}

// Which checks fit each problem, and what that problem's diagnosis can't measure yet.
const TRACKS = {
  slowBoot: {
    checks: [bootTimes, startupApps, systemDrive, (i) => diskSpace(i, 'medium'), fastStartup],
    limits: ['perAppImpact'],
  },
  gameStutter: {
    checks: [powerForGames, gpuDriver, cpuHot, backgroundCpu, ramPressure, memChannels, memSpeed, windowsSetting('gameMode', 'gamemode'), windowsSetting('hags', 'hags'), (i) => diskSpace(i, 'low')],
    limits: ['frameTimes'],
  },
  overheating: {
    checks: [cpuRestTemp, cpuHot, gpuTemp, backgroundCpu, powerForHeat],
    limits: ['underLoad'],
  },
};

const IMPACT = { high: 0, medium: 1, low: 2 };
const CERTAINTY = { measured: 0, suspected: 1 };
// Problems first (biggest likely effect, then measured before suspected), then what couldn't be
// checked or is still being checked, then what is fine.
const rank = (f) => (f.ok === false ? 0 : f.ok == null ? 1 : 2);
const byPriority = (a, b) => rank(a) - rank(b) || IMPACT[a.impact] - IMPACT[b.impact] || (CERTAINTY[a.certainty] ?? 2) - (CERTAINTY[b.certainty] ?? 2);

// The diagnosis for one problem.
// state: 'found' (at least one problem) · 'checking' (nothing yet, some checks still running)
//        · 'incomplete' (nothing found, but some checks couldn't run: never "solved")
//        · 'nothingFound' (every check answered and found nothing; the problem may lie elsewhere)
export function diagnose(problemKey, input = {}) {
  const track = TRACKS[problemKey];
  if (!track) throw new Error(`unknown problem ${problemKey}`);
  // without the service two temperature checks would each ask for it; one row is enough
  const findings = track.checks.flatMap((check) => [].concat(check(input) || [])).sort(byPriority)
    .filter((f, i, all) => f.action?.kind !== 'installService' || all.findIndex((x) => x.action?.kind === 'installService') === i);
  const count = (fn) => findings.filter(fn).length;
  const problems = count((f) => f.ok === false);
  const waiting = count((f) => f.certainty === 'pending');
  const unchecked = count((f) => f.certainty === 'unknown');
  const state = problems ? 'found' : waiting ? 'checking' : unchecked ? 'incomplete' : 'nothingFound';
  return { problem: problemKey, state, findings, problems, waiting, unchecked, limits: track.limits };
}
