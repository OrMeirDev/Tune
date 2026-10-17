// Times every read-only PowerShell question the app asks while an e2e check runs, so a slow start can
// be explained from the log: what ran, when it started (ms after this was set up), how long it took,
// and whether it answered. The licensing identity read is named `identity`; anything else by the first
// line of its script (Tune's own code). Nothing recorded identifies the PC: no answers are kept, only
// durations, outcomes and the first part of an error.
// Call before electron/main.cjs is required: the app's modules take runPS when they load.
// `hook(call, real)` may stand in for the real call (a test-only delay or failure); it never ships.
const path = require('node:path');

const ID_LIKE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32,}\b/gi;
const clean = (s, n) => String(s || '').replace(ID_LIKE, '<id>').replace(/\s+/g, ' ').trim().slice(0, n);
const label = (body) => clean(String(body).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')), 48);

function recordPowerShell({ appDir, now = Date.now, hook = null }) {
  const ps = require(path.join(appDir, 'electron', 'infra', 'powershell.cjs'));
  const { IDENTITY_PS } = require(path.join(appDir, 'electron', 'licensing', 'identity.cjs'));
  const t0 = now();
  const calls = [];
  const real = ps.runPS;
  ps.runPS = async (body, opts) => {
    const c = { what: body === IDENTITY_PS ? 'identity' : label(body), at: now() - t0, ms: null, ok: null };
    calls.push(c);
    let r;
    try { r = hook ? await hook(c, () => real(body, opts)) : await real(body, opts); } catch (e) { r = { ok: false, error: e.message }; }
    c.ms = now() - t0 - c.at;
    c.ok = !!(r && r.ok);
    if (!c.ok) c.error = clean(r && r.error, 120);
    return r;
  };
  const since = () => now() - t0;
  // A summary for the log: the identity reads, and how busy PowerShell was while they ran.
  const summary = () => {
    const ids = calls.filter((c) => c.what === 'identity');
    const firstEnd = ids.length && ids[0].ms !== null ? ids[0].at + ids[0].ms : null;
    return {
      identity: ids.map(({ at, ms, ok, error }) => ({ at, ms, ok, ...(error ? { error } : {}) })),
      otherPowerShellStartedBeforeIdentityAnswered: firstEnd === null ? null : calls.filter((c) => c.what !== 'identity' && c.at <= firstEnd).length,
      others: calls.filter((c) => c.what !== 'identity').map(({ what, at, ms, ok }) => ({ what, at, ms, ok })),
    };
  };
  return { calls, since, summary };
}

module.exports = { recordPowerShell };
