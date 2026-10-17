// The licence as this PC holds it, judged every time it is read: the certificate is checked again
// with the trusted public key (signature, format, plan fields, this PC, this install's key, expiry),
// never trusted because it was stored. Pure apart from node:crypto; tested in
// tests/licensing-client.test.cjs.
//
// States:
//   none        no licence on this PC
//   active      a valid certificate (it follows its own signed expiry, also without a connection)
//   expired     the certificate's time ran out; a check with the server renews it if the licence is
//               still valid
//   revoked / licenseExpired   the server said so on the last check (the certificate is kept, not
//               deleted, but no longer counts); still so after the certificate itself ran out
//   released    the server confirmed that this PC's seat was released (the owner moved the licence);
//               kept until a recovery the server approves. An offline PC that never got this answer
//               keeps following its signed certificate.
//   clock       this PC's clock is earlier than the last time Tune saw it, or than the certificate's
//               issue time: the clock was set back, so no time-based answer can be trusted until it
//               is correct again
//   otherMachine  the certificate belongs to another PC (a copied profile)
//   invalid     the certificate doesn't verify (damaged or altered)
//   unsupported the certificate uses rules newer than this version of Tune
const { verify } = require('./certificate.cjs');

// The newest certificate rules this version understands. A newer certificate asks for an update
// instead of being read with the wrong rules.
const POLICY_VERSIONS = [1];
// How far the clock may go back (time zone and sync corrections) before it counts as set back.
const CLOCK_SKEW_MS = 10 * 60_000;

function evaluate({ license, lastSeenAt, publicKey, machineId, devicePublicKey, now }) {
  if (!license || !license.certificate) return { state: 'none' };
  // a confirmed release only takes rights away, so it holds whatever the certificate says
  if (license.serverStatus === 'released') return { state: 'released', payload: license.certificate.payload };
  if (!publicKey || !machineId || !devicePublicKey) return { state: 'invalid', reason: 'unverifiable' };
  if (Number.isFinite(lastSeenAt) && now < lastSeenAt - CLOCK_SKEW_MS) return { state: 'clock', reason: 'behindLastSeen' };
  let v;
  try {
    v = verify(license.certificate, publicKey, { now, machineId, devicePublicKey, skewMs: CLOCK_SKEW_MS });
    // A licence the server confirmed as ended (revoked, or past its own end) stays ended after its
    // certificate runs out too, so it is never renewed again. The certificate is then checked as at
    // its last moment: its signature, this PC and this install's key are still verified before the
    // end is read from it. A certificate that ran out while the licence is fine stays 'expired'.
    const ended = license.serverStatus === 'revoked' || license.serverStatus === 'expired';
    if (!v.ok && v.reason === 'expired' && ended) {
      v = verify(license.certificate, publicKey, { now: license.certificate.payload.expiresAt - 1, machineId, devicePublicKey, skewMs: CLOCK_SKEW_MS });
    }
  } catch {
    return { state: 'invalid', reason: 'unverifiable' };
  }
  if (!v.ok) {
    const state = { clock: 'clock', expired: 'expired', machine: 'otherMachine' }[v.reason] || 'invalid';
    // an expired certificate is still the licence's own: say which plan it was for
    const payload = v.reason === 'expired' ? license.certificate.payload : null;
    return { state, reason: v.reason, payload };
  }
  const p = v.payload;
  if (!POLICY_VERSIONS.includes(p.policyVersion)) return { state: 'unsupported', reason: 'policyVersion', payload: p };
  // the answer that carried the certificate must be about the same licence and device
  if (p.licenseId !== license.licenseId || p.deviceId !== license.deviceId) return { state: 'invalid', reason: 'mismatch' };
  if (license.serverStatus === 'revoked') return { state: 'revoked', payload: p };
  if (license.serverStatus === 'expired') return { state: 'licenseExpired', payload: p };
  return { state: 'active', payload: p };
}

// The certificate in a server's answer, checked before anything is stored: an answer that doesn't
// verify (or is about another licence or device) never replaces what this PC already holds.
function checkAnswer(answer, { publicKey, machineId, devicePublicKey, now }) {
  if (!answer || typeof answer !== 'object' || !answer.certificate) return { ok: false, reason: 'malformed' };
  let v;
  try { v = verify(answer.certificate, publicKey, { now, machineId, devicePublicKey, skewMs: CLOCK_SKEW_MS }); } catch { return { ok: false, reason: 'malformed' }; }
  if (!v.ok) return { ok: false, reason: v.reason };
  if (!POLICY_VERSIONS.includes(v.payload.policyVersion)) return { ok: false, reason: 'unsupported' };
  if (v.payload.licenseId !== answer.licenseId || v.payload.deviceId !== answer.deviceId) return { ok: false, reason: 'mismatch' };
  return { ok: true, payload: v.payload };
}

module.exports = { evaluate, checkAnswer, POLICY_VERSIONS, CLOCK_SKEW_MS };
