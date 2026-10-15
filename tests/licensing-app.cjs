// Shared set-up for the licensing client tests (not a test file itself): the licensing server PoC on
// a loopback port, Tune's own client on a throwaway profile, a stand-in for DPAPI, and timers driven
// by the same hand-moved clock as both sides, so time-based behaviour is deterministic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setup, clock, pc } = require('../licensing/tests/helpers.cjs');
const { start } = require('../licensing/server.cjs');
const { createApi } = require('../electron/licensing/api.cjs');
const { createLicensingClient } = require('../electron/licensing/client.cjs');
const { createProtectedStore } = require('../electron/licensing/protected-store.cjs');

// A stand-in for DPAPI: reversible, switchable off, and able to fail a write like a full disk.
function fakeCrypt() {
  const c = { kind: 'dpapi', on: true, failWrites: false };
  c.available = () => c.on;
  c.encrypt = (s) => { if (c.failWrites) throw new Error('disk full'); return Buffer.from(Buffer.from(s, 'utf8').map((x) => x ^ 0x33)); };
  c.decrypt = (b) => Buffer.from(b.map((x) => x ^ 0x33)).toString('utf8');
  return c;
}

// Timers on the test's clock. advance(ms) moves the clock to each due timer in turn, runs it, and
// waits for what it started (a renewal is an HTTP request to the local server).
function fakeTimers(now) {
  const queue = [];
  let seq = 0;
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const timers = {
    set(fn, ms) {
      const h = { id: ++seq, at: now() + Math.max(0, ms), fn, unref() { return h; } };
      queue.push(h);
      return h;
    },
    clear(h) { const i = queue.indexOf(h); if (i >= 0) queue.splice(i, 1); },
    pending: () => queue.length,
    nextIn: () => (queue.length ? Math.min(...queue.map((h) => h.at)) - now() : null),
    async advance(ms) {
      const end = now() + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (!next || next.at > end) break;
        queue.shift();
        if (next.at > now()) now.advance(next.at - now());
        await next.fn();
        await settle();
      }
      if (end > now()) now.advance(end - now());
      await settle();
    },
  };
  return timers;
}

// The licensing server on a loopback port, and what a test needs to drive it.
async function server(t, opts = {}) {
  const now = opts.now || clock();
  const env = setup(t, { now });
  const http0 = await start({ service: env.service, adminToken: env.keys.adminToken, log: () => {} });
  t.after(() => http0.close());
  // the customer reads the 6-digit code from their mail (the PoC's outbox)
  const mailCode = (email) => /\b(\d{6})\b/.exec(env.store.readOutbox(email).at(-1).body)[1];
  return { ...env, url: http0.url, now, mailCode, publicKey: crypto.createPublicKey(env.service.publicKey) };
}

// Tune on one PC: a profile folder, its machine id, its protected storage (and, when given, timers
// and a change listener).
function tune(t, srv, { machine = pc('pc-a'), dir, crypt = fakeCrypt(), fetch = globalThis.fetch, timeoutMs = 3000, now = srv.now, timers, onChange } = {}) {
  const profile = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'tune-profile-'));
  if (!dir) t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const config = { url: srv.url, publicKey: srv.publicKey, problem: null, development: true };
  const store = createProtectedStore({ file: path.join(profile, 'license.bin'), crypt });
  const client = createLicensingClient({ config, api: createApi({ baseUrl: srv.url, fetch, timeoutMs }), store, machineId: async () => ({ ok: true, machineId: machine.machineId }), now, timers, onChange });
  t.after(() => client.dispose && client.dispose());
  return { client, profile, crypt, machine, file: path.join(profile, 'license.bin') };
}

// Owner verification the way a customer does it: email, then the code from the mail.
async function verifiedOwner(srv, app, email = 'owner@example.com') {
  assert.equal((await app.client.startOwner(email)).data.outcome.result, 'codeSent');
  const r = await app.client.confirmOwner(srv.mailCode(email));
  assert.equal(r.data.outcome.result, 'ownerVerified');
  return r;
}

const code = (srv, opts) => srv.order(opts).units[0].code;
const outcome = (r) => r.data.outcome.result;

// Counts the requests to one route (and how many were in flight at once, and when each was sent);
// `down` makes them fail like a network outage.
function watch(route, inner = fetch) {
  const w = { count: 0, inFlight: 0, maxInFlight: 0, down: false, times: [] };
  w.fetch = async (url, init) => {
    if (!url.endsWith(route)) return inner(url, init);
    w.count++;
    w.inFlight++;
    w.maxInFlight = Math.max(w.maxInFlight, w.inFlight);
    w.times.push(w.now ? w.now() : 0);
    try {
      if (w.down) throw new TypeError('fetch failed');
      return await inner(url, init);
    } finally { w.inFlight--; }
  };
  return w;
}

// Tune activated with a fresh Serial by a verified owner.
async function activated(t, srv, opts = {}) {
  const app = tune(t, srv, opts);
  await verifiedOwner(srv, app, opts.email);
  assert.equal(outcome(await app.client.activate(code(srv, opts.order))), 'activated');
  return app;
}

module.exports = { fakeCrypt, fakeTimers, server, tune, verifiedOwner, code, outcome, watch, activated };
