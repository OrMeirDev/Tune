// The licensing flows in the main process (plan L02): owner verification by email, activation with a
// Serial, recovery of this owner's licence on this PC (after a reinstall), renewal, and the status the
// window shows. Everything the window must never see stays here: the owner token, the pending
// request, this install's private key and the certificates. The window gets summaries only.
//
// Every method resolves (never rejects) with { ok: true, data: summary }, and nothing stays busy
// after it: no answer from the server, a refusal or a storage failure is an outcome the window
// shows, with a retry where one makes sense.
//
// Guarantees:
// - A retry after no answer resends the same logical request: the same Serial, owner and device key
//   with the same idempotency key, so a request the server did carry out returns the licence it
//   already created instead of failing as "already redeemed".
// - A server answer is stored only after its certificate verifies against the trusted key, for this
//   PC and this install's key; an answer that doesn't verify never replaces what is stored.
// - Recovery never releases another PC, never redeems a Serial and never buys anything: it asks for
//   this owner's licence on this PC, and a full licence is reported as full.
// - This install's device key is stored (protected) before any request carries its public half, and
//   is never stored unprotected: without protected storage nothing is activated.
// - While Tune runs, the licence renews itself before its signed certificate ends (and after an
//   outage, once the server answers again), one request at a time, with growing gaps between failed
//   tries. A release or revocation the server confirmed is kept (protected) and stops renewal; only a
//   recovery the server approves, with a certificate that verifies, makes this PC active again.
const crypto = require('node:crypto');
const { normalize } = require('./serial.cjs');
const { signRequest } = require('./device-keys.cjs');
const { deviceKeyFrom, newDeviceKey } = require('./identity.cjs');
const { evaluate, checkAnswer } = require('./license-state.cjs');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// how often the last-seen time is written while Tune runs (it is also written with every licence)
const LAST_SEEN_EVERY_MS = 10 * MINUTE;
// renew in the background when the last check is older than this, or the certificate ends sooner
const REFRESH_AFTER_MS = 12 * HOUR;
const REFRESH_BEFORE_END_MS = 48 * HOUR;
// after a renewal that got no answer: try again after 1, 2, 4 ... minutes, at most an hour apart
const RETRY_FIRST_MS = MINUTE;
const RETRY_MAX_MS = HOUR;
// the longest any timer waits: a missed timer (the PC slept) or a clock change is seen within this
const LOOK_EVERY_MS = 15 * MINUTE;
// what the server confirmed about this PC's licence: nothing to renew any more
const TERMINAL = new Set(['released', 'revoked', 'licenseExpired']);
// states in which a renewal can't help or can't be judged (the clock, another PC, a broken file)
const NO_RENEWAL = new Set(['none', 'clock', 'otherMachine', 'invalid', 'unsupported', ...TERMINAL]);

// Timers that never keep the process alive (Tune quits when its window closes).
const realTimers = {
  set: (fn, ms) => { const h = setTimeout(fn, ms); if (h && typeof h.unref === 'function') h.unref(); return h; },
  clear: (h) => clearTimeout(h),
};

const ID = /^[a-z]{3,4}_[0-9a-f]{24}$/;
const num = (v) => (Number.isFinite(v) ? v : null);

// timers: { set(fn, ms), clear(handle) } (injected in tests); onChange: told when the licence changed
// without the window asking (a background renewal, a release seen in the background).
function createLicensingClient({ config, api, store, machineId, now = Date.now, newRequestKey = () => crypto.randomBytes(18).toString('base64url'), timers = realTimers, onChange = () => {} }) {
  let loaded = false;
  let saved = null; // the decrypted file: { v: 1, device, license, lastSeenAt }
  let storage = 'ok'; // 'ok' | 'unavailable' | 'unreadable' | 'failed'
  let machine = null; // { ok, machineId }
  let flow = { email: null, challengeId: null, ownerToken: null, ownerExpiresAt: null, choices: null };
  let pending = null; // the request to send again after no answer
  let outcome = null; // what the last action came to
  let busy = false;
  let lastSeenWritten = 0;
  let lastCheckFailedAt = null;
  // background renewal
  let timer = null;
  let disposed = false;
  let renewing = null; // the renewal in flight (a promise of its outcome)
  let retryDelay = 0;
  let retryAt = null;

  function load() {
    if (loaded) return;
    loaded = true;
    const r = store.read();
    if (r.ok) { saved = r.data; storage = 'ok'; return; }
    saved = null;
    storage = r.reason === 'none' ? (store.kind() === 'unavailable' ? 'unavailable' : 'ok') : r.reason;
  }

  async function ensureMachine() {
    if (!machine || !machine.ok) {
      try { machine = await machineId(); } catch { machine = { ok: false }; }
    }
    return machine;
  }

  const write = (next) => {
    const w = store.write(next);
    if (w.ok) storage = 'ok';
    else storage = w.reason === 'unavailable' ? 'unavailable' : 'failed';
    return w;
  };

  // The licence as judged right now, with the clock as it is now.
  function judge() {
    load();
    return evaluate({
      license: saved && saved.license,
      lastSeenAt: saved && saved.lastSeenAt,
      publicKey: config.publicKey,
      machineId: machine && machine.ok ? machine.machineId : null,
      devicePublicKey: saved && saved.device && saved.device.publicKey,
      now: now(),
    });
  }

  // Remember the latest time this PC's clock showed, so a clock set back is noticed later. Never
  // moved back, and not moved at all while the clock is behind it.
  function touchClock() {
    if (!saved || storage !== 'ok') return;
    const t = now();
    const last = Number.isFinite(saved.lastSeenAt) ? saved.lastSeenAt : 0;
    if (t <= last) return;
    saved = { ...saved, lastSeenAt: t };
    if (t - lastSeenWritten >= LAST_SEEN_EVERY_MS) { lastSeenWritten = t; write(saved); }
  }

  // This install's device key, created and stored (protected) the first time it is needed.
  async function ensureDevice() {
    const m = await ensureMachine();
    if (!m.ok) return { ok: false, result: 'identityUnavailable' };
    if (storage === 'unavailable' || store.kind() === 'unavailable') return { ok: false, result: 'storageUnavailable' };
    const existing = saved && deviceKeyFrom(saved.device);
    if (existing) return { ok: true, key: existing, machineId: m.machineId };
    // a file that can't be read is set aside (kept, never deleted) before a new one is written
    if (storage === 'unreadable' && store.setAside) store.setAside();
    const device = newDeviceKey(now());
    const next = { v: 1, ...(storage === 'ok' && saved ? saved : {}), device, license: storage === 'ok' && saved ? saved.license : undefined };
    const w = write(next);
    if (!w.ok) return { ok: false, result: w.reason === 'unavailable' ? 'storageUnavailable' : 'storageFailed' };
    saved = next;
    return { ok: true, key: deviceKeyFrom(device), machineId: m.machineId };
  }

  const step = () => (flow.ownerToken ? 'ready' : flow.challengeId ? 'code' : 'email');

  // What the window shows. No tokens, keys or certificates.
  function summary() {
    const j = judge();
    const lic = saved && saved.license;
    const p = j.payload;
    return {
      available: !!api,
      problem: config.problem || null,
      development: !!config.development,
      storage: storage === 'ok' ? store.kind() : storage,
      license: {
        state: j.state,
        planId: p ? p.planId : lic ? lic.planId || null : null,
        features: p ? p.features : [],
        certificateExpiresAt: p ? p.expiresAt : null,
        licenseExpiresAt: lic ? num(lic.licenseExpiresAt) : null,
        lastCheckAt: lic ? num(lic.lastCheckAt) : null,
        lastCheckFailedAt,
      },
      flow: { step: step(), email: flow.email, ownerExpiresAt: flow.ownerExpiresAt, choices: flow.choices },
      outcome,
      canRetry: !!pending,
      busy,
    };
  }
  const answer = () => ({ ok: true, data: summary() });

  // One request at a time; whatever happens, the busy flag is cleared and an answer comes back. A
  // background renewal in flight is waited for first: "Check now" takes its answer instead of sending
  // a second request, and any other action starts after it. Afterwards renewal is planned again (an
  // activation starts it, a confirmed release stops it).
  async function run(action, fn) {
    if (busy) { return { ok: true, data: { ...summary(), outcome: { action, result: 'busy' } } }; }
    busy = true;
    try {
      load();
      if (!api) { outcome = { action, result: 'notConfigured' }; return answer(); }
      const joined = renewing ? await renewing.catch(() => null) : null;
      if (action === 'refresh' && joined) outcome = { ...joined, action: 'refresh' };
      else await fn();
    } catch {
      outcome = { action, result: 'failed' };
    } finally {
      busy = false;
      schedule();
    }
    return answer();
  }

  const noAnswer = (action, r) => {
    outcome = { action, result: 'unavailable', reason: r.reason || 'network', retryable: true };
  };

  // A server's refusal, as the window may see it: only this owner's own details pass through.
  function refusal(action, r) {
    const map = {
      invalid_code: 'invalidCode', code_revoked: 'codeRevoked', owner_mismatch: 'ownerMismatch',
      idempotency_conflict: 'conflict', device_limit: 'deviceLimit', not_found: 'noLicenseFound',
      device_released: 'deviceReleased', machine_mismatch: 'otherMachine', bad_signature: 'refreshRefused',
      stale_request: 'refreshRefused', rate_limited: 'rateLimited', invalid_request: 'invalidRequest',
      owner_code_invalid: 'ownerCodeInvalid', owner_code_expired: 'ownerCodeExpired', too_many_attempts: 'ownerCodeExpired',
    };
    const o = { action, result: map[r.result] || 'refused' };
    if (r.result === 'already_redeemed') o.result = r.yours ? 'alreadyYours' : 'alreadyRedeemed';
    if (r.result === 'owner_unverified') { o.result = 'ownerExpired'; flow = { ...flow, ownerToken: null, ownerExpiresAt: null, challengeId: null }; }
    if (r.result === 'license_inactive') o.result = r.status === 'revoked' ? 'licenseRevoked' : 'licenseExpired';
    if (r.result === 'device_limit' && Number.isSafeInteger(r.deviceLimit)) o.deviceLimit = r.deviceLimit;
    if (r.result === 'rate_limited' && Number.isSafeInteger(r.retryAfterSeconds)) o.retryAfterSeconds = r.retryAfterSeconds;
    if (r.result === 'owner_code_invalid' && Number.isSafeInteger(r.attemptsLeft)) o.attemptsLeft = r.attemptsLeft;
    if (['owner_code_expired', 'too_many_attempts'].includes(r.result)) flow = { ...flow, challengeId: null };
    if (r.result === 'license_required') {
      o.result = 'chooseLicense';
      // this owner's own licences only (the server lists nobody else's), each by an id it gave
      flow = {
        ...flow,
        choices: [].concat(r.licenses || []).filter((l) => l && ID.test(l.licenseId)).slice(0, 20).map((l) => ({
          licenseId: l.licenseId, planId: typeof l.planId === 'string' ? l.planId.slice(0, 40) : null,
          codeSuffix: typeof l.codeSuffix === 'string' ? l.codeSuffix.slice(0, 4) : null,
          status: ['active', 'expired', 'revoked'].includes(l.status) ? l.status : null, expiresAt: num(l.expiresAt),
        })),
      };
    }
    // the server says this licence ended: kept on this PC (never deleted), shown as ended
    if (r.result === 'license_inactive' && saved && saved.license && action === 'refresh') {
      saved = { ...saved, license: { ...saved.license, serverStatus: r.status === 'revoked' ? 'revoked' : 'expired', lastCheckAt: now() } };
      write(saved);
    }
    // the server confirms this PC's seat was released (the owner moved the licence): this binding is
    // released (kept, protected, until a recovery the server approves); the licence itself and any
    // other PC are untouched. Without this answer (offline) nothing changes here.
    if (r.result === 'device_released' && saved && saved.license && action === 'refresh') {
      saved = { ...saved, license: { ...saved.license, serverStatus: 'released', releasedAt: now(), lastCheckAt: now() } };
      write(saved);
    }
    outcome = o;
  }

  // A licence the server granted: kept only if its certificate verifies here.
  function accept(action, r, dev) {
    const at = now();
    const c = checkAnswer(r, { publicKey: config.publicKey, machineId: dev.machineId, devicePublicKey: dev.key.publicKey, now: at });
    if (!c.ok) { outcome = { action, result: 'invalidCertificate', reason: c.reason }; return; }
    const license = {
      licenseId: r.licenseId, deviceId: r.deviceId, planId: r.planId, licenseExpiresAt: num(r.licenseExpiresAt),
      certificate: r.certificate, lastCheckAt: at, serverStatus: 'active',
    };
    // the server's issue time confirms the real time, so it replaces a last-seen time that a clock
    // once set ahead had pushed into the future
    saved = { ...saved, v: 1, license, lastSeenAt: Math.max(at, c.payload.issuedAt) };
    lastSeenWritten = at;
    lastCheckFailedAt = null;
    retryDelay = 0;
    retryAt = null;
    flow = { ...flow, choices: null };
    const w = write(saved);
    const done = { activate: 'activated', recover: 'recovered', refresh: 'refreshed' }[action];
    outcome = w.ok ? { action, result: r.replayed ? 'activated' : done } : { action, result: 'storageFailed' };
  }

  // Send, or (retry) send again exactly what was sent before. A background renewal leaves the person's
  // own unanswered request (and its Try again) alone.
  async function send(action, route, body, dev, { background = false } = {}) {
    const r = await api.post(route, body);
    if (r.result === 'unavailable') {
      if (!background) pending = { action, route, body };
      if (action === 'refresh') lastCheckFailedAt = now();
      noAnswer(action, r);
      return;
    }
    if (!background) pending = null;
    if (r.result !== 'ok') { refusal(action, r); return; }
    if (route === 'challenge') {
      flow = { ...flow, challengeId: typeof r.challengeId === 'string' ? r.challengeId : null, ownerToken: null };
      outcome = { action, result: flow.challengeId ? 'codeSent' : 'refused' };
      return;
    }
    if (route === 'verify') {
      const ok = typeof r.ownerToken === 'string' && r.ownerToken.length <= 200;
      flow = { ...flow, challengeId: null, ownerToken: ok ? r.ownerToken : null, ownerExpiresAt: ok ? num(r.expiresAt) : null };
      outcome = { action, result: ok ? 'ownerVerified' : 'refused' };
      return;
    }
    accept(action, r, dev);
  }

  // ---- what the window can ask for (ipc/channels.cjs checks the arguments' shape first) ----

  const startOwner = (email) => run('ownerStart', async () => {
    flow = { email: String(email).trim().toLowerCase(), challengeId: null, ownerToken: null, ownerExpiresAt: null, choices: null };
    pending = null;
    await send('ownerStart', 'challenge', { email: flow.email });
  });

  const confirmOwner = (code) => run('ownerConfirm', async () => {
    if (!flow.challengeId) { outcome = { action: 'ownerConfirm', result: 'noChallenge' }; return; }
    await send('ownerConfirm', 'verify', { challengeId: flow.challengeId, code });
  });

  const activate = (serial) => run('activate', async () => {
    if (!flow.ownerToken) { outcome = { action: 'activate', result: 'ownerUnverified' }; return; }
    const code = normalize(serial);
    if (!code) { outcome = { action: 'activate', result: 'invalidCode' }; return; }
    const dev = await ensureDevice();
    if (!dev.ok) { outcome = { action: 'activate', result: dev.result }; return; }
    // the same Serial, owner and device key as an unanswered request: the same request again
    const same = pending && pending.action === 'activate' && pending.body.code === code
      && pending.body.ownerToken === flow.ownerToken && pending.body.devicePublicKey === dev.key.publicKey;
    const body = same ? pending.body : {
      code, ownerToken: flow.ownerToken, machineId: dev.machineId, devicePublicKey: dev.key.publicKey, idempotencyKey: newRequestKey(),
    };
    await send('activate', 'redeem', body, dev);
  });

  const recover = (licenseId) => run('recover', async () => {
    if (!flow.ownerToken) { outcome = { action: 'recover', result: 'ownerUnverified' }; return; }
    // only a licence the server itself listed for this owner
    if (licenseId !== undefined && !(flow.choices || []).some((c) => c.licenseId === licenseId)) { outcome = { action: 'recover', result: 'invalidRequest' }; return; }
    const dev = await ensureDevice();
    if (!dev.ok) { outcome = { action: 'recover', result: dev.result }; return; }
    await send('recover', 'recover', {
      ownerToken: flow.ownerToken, machineId: dev.machineId, devicePublicKey: dev.key.publicKey, ...(licenseId ? { licenseId } : {}),
    }, dev);
  });

  // A check with the server, signed with this install's key (it renews the certificate).
  async function refreshNow({ background = false } = {}) {
    const lic = saved && saved.license;
    const key = saved && deviceKeyFrom(saved.device);
    if (!lic || !key) { outcome = { action: 'refresh', result: 'noLicense' }; return; }
    const m = await ensureMachine();
    if (!m.ok) { outcome = { action: 'refresh', result: 'identityUnavailable' }; return; }
    const body = { licenseId: lic.licenseId, deviceId: lic.deviceId, machineId: m.machineId };
    const { ts, signature } = signRequest('refresh', body, key.privateKey, now());
    await send('refresh', 'refresh', { ...body, ts, signature }, { key, machineId: m.machineId }, { background });
  }
  const refresh = () => run('refresh', refreshNow);

  const retry = () => run('retry', async () => {
    if (!pending) { outcome = { action: 'retry', result: 'nothingToRetry' }; return; }
    // a renewal is signed with the time it is sent, so it is signed again
    if (pending.action === 'refresh') { await refreshNow(); return; }
    const { action, route, body } = pending;
    const dev = ['redeem', 'recover'].includes(route) ? await ensureDevice() : null;
    if (dev && !dev.ok) { outcome = { action, result: dev.result }; return; }
    // the device key is the one the request was built with (it is stored before any request)
    if (dev && dev.key.publicKey !== body.devicePublicKey) { pending = null; outcome = { action, result: 'failed' }; return; }
    await send(action, route, body, dev);
  });

  // Start over: forget the owner verification and anything unanswered (nothing on disk changes).
  const reset = () => {
    if (busy) return { ok: true, data: { ...summary(), outcome: { action: 'reset', result: 'busy' } } };
    flow = { email: null, challengeId: null, ownerToken: null, ownerExpiresAt: null, choices: null };
    pending = null;
    outcome = null;
    return answer();
  };

  async function status() {
    load();
    // the machine id (a PowerShell query on Windows) is read only when it can matter: licensing is
    // configured, or a licence is stored; with the shipped defaults nothing runs
    if (api || (saved && saved.license)) await ensureMachine();
    touchClock();
    return answer();
  }

  // ---- renewal while Tune runs ----

  // Whether there is a licence to renew at all: licensing on, a licence and this install's key, and
  // nothing the server confirmed as final. An expired certificate is renewed (after an outage).
  function renewable(j) {
    const lic = saved && saved.license;
    return !!api && !!lic && !!deviceKeyFrom(saved.device) && !NO_RENEWAL.has(j.state);
  }

  // When the next renewal is due: after a failure, when its backoff ends; otherwise 12 hours after the
  // last check, or 2 days before the certificate ends, whichever is first.
  function dueAt(j) {
    if (retryAt != null) return retryAt;
    const lic = saved.license;
    const after = Number.isFinite(lic.lastCheckAt) ? lic.lastCheckAt + REFRESH_AFTER_MS : now();
    const before = j.payload && Number.isFinite(j.payload.expiresAt) ? j.payload.expiresAt - REFRESH_BEFORE_END_MS : now();
    return Math.min(after, before);
  }

  // Plan the next look: none without a licence that could ever renew; otherwise at the due time, but
  // never more than LOOK_EVERY_MS away, so a missed timer (sleep) or a clock change is seen soon.
  function schedule() {
    if (timer) { timers.clear(timer); timer = null; }
    if (disposed || !api || !(saved && saved.license)) return;
    const j = judge();
    if (TERMINAL.has(j.state)) return;
    const wait = renewable(j) ? Math.max(0, dueAt(j) - now()) : LOOK_EVERY_MS;
    timer = timers.set(() => tick(), Math.min(wait, LOOK_EVERY_MS));
  }

  // A look at the licence with the clock as it is now: note the time (a clock set back is noticed),
  // renew when due, tell the window when something changed, and plan the next look.
  async function tick() {
    timer = null;
    // a renewal already in flight (a resume and an unlock arrive together) plans the next look itself
    if (disposed || renewing) return;
    try {
      load();
      const before = judge().state;
      touchClock();
      const j = judge();
      if (renewable(j) && now() >= dueAt(j)) await renewInBackground();
      else if (j.state !== before) onChange();
    } catch { /* a look never throws; the next one tries again */ }
    schedule();
  }

  // A renewal nobody asked for: no message for the window (the row shows its result), no effect on
  // the person's own pending request, and not while the person's own request runs.
  async function renewInBackground() {
    if (busy) { retryAt = now() + RETRY_FIRST_MS; return; }
    renewing = (async () => {
      const shown = outcome;
      try {
        await refreshNow({ background: true });
        return outcome;
      } finally {
        outcome = shown;
      }
    })();
    let result = null;
    try { result = await renewing; } catch { result = { action: 'refresh', result: 'failed' }; } finally { renewing = null; }
    if (result && (result.result === 'unavailable' || result.result === 'failed')) {
      retryDelay = retryDelay ? Math.min(retryDelay * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
      retryAt = now() + retryDelay;
    } else {
      retryDelay = 0;
      retryAt = null;
    }
    onChange();
  }

  // The PC woke up (or the clock changed a lot): look again now instead of waiting for a timer.
  async function wake() {
    if (disposed) return;
    if (timer) { timers.clear(timer); timer = null; }
    await tick();
  }

  // Tune is quitting: no more timers.
  function dispose() {
    disposed = true;
    if (timer) { timers.clear(timer); timer = null; }
  }

  // At start: read what is stored, renew when due, and keep renewing while Tune runs. Never throws.
  async function init() {
    try {
      await status();
      await tick();
    } catch { /* licensing never stops Tune from starting */ }
  }

  // For entitlements: the licence right now (sync; the machine id is read by init/status).
  const current = () => {
    const j = judge();
    return { state: j.state, features: j.payload && j.state === 'active' ? j.payload.features : [] };
  };

  return { init, status, startOwner, confirmOwner, activate, recover, refresh, retry, reset, current, wake, dispose };
}

module.exports = { createLicensingClient, realTimers, REFRESH_AFTER_MS, REFRESH_BEFORE_END_MS, RETRY_MAX_MS, LOOK_EVERY_MS };
