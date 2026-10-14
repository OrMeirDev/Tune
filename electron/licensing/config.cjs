// Where Tune's licensing client talks to, which signing key it trusts, and the entitlement policy.
//
// Shipped defaults: no licensing server and the 'open' policy, so every feature stays available
// exactly as before licensing, until the owner decides the commercial policy (docs/roadmap: price,
// paid features, licence length, transfers, offline time, existing users). The licensing server in
// licensing/ is a proof of concept, not a service, so no build points customers at it.
//
// A development build (not packaged) can point at a local licensing server PoC with environment
// variables, and tests can turn on the enforcing policy, a fixed machine id and test-only storage.
// A packaged build ignores all of them. Pure (no Electron); tested in tests/licensing-client.test.cjs.
const crypto = require('node:crypto');

const SHIPPED = Object.freeze({ url: null, publicKey: null, policy: 'open' });

// A loopback address: the only place plain http is allowed, and only in development.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The server address, or null when it isn't one Tune will talk to: https anywhere; http only to
// this PC itself, only in development; no credentials, query or fragment in it.
function serverUrl(raw, { development }) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  const ok = u.protocol === 'https:' || (development && u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  return ok ? u.href.replace(/\/$/, '') : null;
}

// The server's public signing key (PEM, or base64 of the SPKI DER), or null unless it is Ed25519.
function trustedKey(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const k = raw.includes('BEGIN PUBLIC KEY')
      ? crypto.createPublicKey(raw)
      : crypto.createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'ed25519' ? k : null;
  } catch {
    return null;
  }
}

// -> { url, publicKey (KeyObject), policy, development, testStorage, testMachineId, problem }
// `problem` says why licensing is off: 'notConfigured' (the shipped state) or 'misconfigured' (a
// development setting that Tune refuses, such as http to another host or a key that isn't Ed25519).
function licensingConfig({ packaged, env = process.env }) {
  if (packaged) return { url: null, publicKey: null, policy: SHIPPED.policy, development: false, testStorage: false, testMachineId: null, problem: 'notConfigured' };
  const rawUrl = env.TUNE_LICENSING_URL || SHIPPED.url;
  const url = serverUrl(rawUrl, { development: true });
  const publicKey = trustedKey(env.TUNE_LICENSING_PUBLIC_KEY || SHIPPED.publicKey);
  const problem = !rawUrl ? 'notConfigured' : !url || !publicKey ? 'misconfigured' : null;
  return {
    url: problem ? null : url,
    publicKey: problem ? null : publicKey,
    policy: env.TUNE_LICENSING_POLICY === 'enforce' ? 'enforce' : SHIPPED.policy,
    development: true,
    // test-only storage and machine id, for running the app off Windows (e2e/licensing.cjs)
    testStorage: env.TUNE_TEST_PROTECTED_STORAGE === 'insecure-test-only',
    testMachineId: /^[0-9a-f]{64}$/.test(env.TUNE_TEST_MACHINE_ID || '') ? env.TUNE_TEST_MACHINE_ID : null,
    problem,
  };
}

module.exports = { SHIPPED, licensingConfig, serverUrl, trustedKey };
