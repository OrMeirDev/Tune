'use strict';
// The license certificate: what the server signs after activation and what Tune's main process
// checks offline with the server's PUBLIC key. Self-contained (node:crypto only) because this file
// is meant to ship in the app as is.
const crypto = require('node:crypto');

const FORMAT = 'tune-license/1';
const DEFAULT_SKEW_MS = 5 * 60_000;

// One byte sequence per value, whatever order the keys arrived in, so a certificate stored as JSON
// and read back still verifies. Keys sort by UTF-16 code unit; undefined and non-finite numbers
// are refused rather than silently dropped.
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON: ${typeof value}`);
}

// A device public key as the certificate carries it: base64 of the Ed25519 SPKI DER. Accepts that
// string or a KeyObject; returns null for anything that isn't an Ed25519 public key.
function publicKeyString(key) {
  try {
    let k = key;
    if (typeof key === 'string') k = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
    else if (!(key instanceof crypto.KeyObject && key.type === 'public')) k = crypto.createPublicKey(key);
    if (k.asymmetricKeyType !== 'ed25519') return null;
    return k.export({ type: 'spki', format: 'der' }).toString('base64');
  } catch {
    return null;
  }
}

function serverKey(key) {
  const k = key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key);
  if (k.asymmetricKeyType !== 'ed25519') throw new TypeError('server key must be Ed25519');
  return k;
}

// fields: licenseId, deviceId, machineId, devicePublicKey, planId, features, issuedAt, expiresAt,
// policyVersion. The format tag sits inside the signed payload so it can't be swapped.
function sign(fields, privateKey) {
  const payload = { format: FORMAT, ...fields };
  const signature = crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url');
  return { payload, signature };
}

const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
function wellFormed(p) {
  return p.format === FORMAT && isStr(p.licenseId) && isStr(p.deviceId) && isStr(p.machineId)
    && isStr(p.devicePublicKey) && isStr(p.planId)
    && Array.isArray(p.features) && p.features.every(isStr)
    && isTime(p.issuedAt) && isTime(p.expiresAt) && p.expiresAt > p.issuedAt
    && Number.isSafeInteger(p.policyVersion);
}

const refuse = (reason) => ({ ok: false, reason });

// -> { ok: true, reason: null, payload } or { ok: false, reason } with reason one of
// 'malformed', 'signature', 'clock' (this PC's clock is before the issue time: rolled back),
// 'expired', 'machine', 'device'. machineId and devicePublicKey are required: a check that
// forgot them would accept a certificate copied from another PC.
function verify(certificate, serverPublicKey, { now = Date.now(), machineId, devicePublicKey, skewMs = DEFAULT_SKEW_MS } = {}) {
  if (typeof machineId !== 'string' || devicePublicKey === undefined) {
    throw new TypeError('verify needs this PC\'s machineId and devicePublicKey');
  }
  const payload = certificate && certificate.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof certificate.signature !== 'string') {
    return refuse('malformed');
  }
  let message;
  try { message = Buffer.from(canonical(payload)); } catch { return refuse('malformed'); }
  const signature = Buffer.from(certificate.signature, 'base64url');
  let good = false;
  try { good = signature.length === 64 && crypto.verify(null, message, serverKey(serverPublicKey), signature); } catch { good = false; }
  if (!good) return refuse('signature');
  // Only now are the fields trusted enough to read.
  if (!wellFormed(payload)) return refuse('malformed');
  if (now < payload.issuedAt - skewMs) return refuse('clock');
  if (now >= payload.expiresAt) return refuse('expired');
  if (payload.machineId !== machineId) return refuse('machine');
  if (payload.devicePublicKey !== publicKeyString(devicePublicKey)) return refuse('device');
  return { ok: true, reason: null, payload };
}

module.exports = { FORMAT, canonical, publicKeyString, sign, verify };
