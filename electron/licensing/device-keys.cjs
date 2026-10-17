'use strict';
// The PC's half of licensing: its own Ed25519 key pair, its machine identity, and signing its
// requests. Ships in Tune's main process like certificate.cjs; the licensing server PoC uses
// verifyRequest from here so both sides build the signed message the same way.
const crypto = require('node:crypto');
const { canonical, publicKeyString } = require('./certificate.cjs');

// A fresh key per install. The private key never leaves the PC (Tune would keep it under DPAPI);
// the server only ever sees the public half.
function createDeviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: publicKeyString(publicKey), privateKey };
}

// Machine identity, computed on the PC: a hash of Windows' MachineGuid and the SMBIOS UUID (the
// PoC takes them as inputs). A random per-install id would not do: it changes on every reinstall,
// and a reinstall is exactly when the same PC has to find its license again.
function machineId({ machineGuid, smbiosUuid }) {
  const part = (s) => String(s).trim().toLowerCase();
  return crypto.createHash('sha256').update(`tune-machine/1|${part(machineGuid)}|${part(smbiosUuid)}`).digest('hex');
}

// The action is inside the signed message, so a signed release can't be replayed as a refresh.
const requestMessage = (action, body, ts) => Buffer.from(canonical({ action, body, ts }));

function signRequest(action, body, privateKey, now = Date.now()) {
  const ts = now;
  return { ts, signature: crypto.sign(null, requestMessage(action, body, ts), privateKey).toString('base64url') };
}

function verifyRequest(action, body, ts, signature, publicKey) {
  if (!Number.isSafeInteger(ts) || typeof signature !== 'string') return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    const sig = Buffer.from(signature, 'base64url');
    return sig.length === 64 && crypto.verify(null, requestMessage(action, body, ts), key, sig);
  } catch {
    return false;
  }
}

module.exports = { createDeviceKey, machineId, signRequest, verifyRequest };
