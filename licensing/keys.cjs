'use strict';
// The server's secrets: the code HMAC secret, the delivery-box key, the certificate signing key and
// the admin token. The PoC keeps them in a JSON file (mode 0600); production keeps them in a
// secrets manager or HSM, which is out of scope here.
const crypto = require('node:crypto');
const fs = require('node:fs');

function generateKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    codeSecret: crypto.randomBytes(32).toString('hex'),
    deliveryKey: crypto.randomBytes(32).toString('hex'),
    signingKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    adminToken: crypto.randomBytes(32).toString('base64url'),
  };
}

function parseKeys(raw) {
  const codeSecret = Buffer.from(raw.codeSecret, 'hex');
  const deliveryKey = Buffer.from(raw.deliveryKey, 'hex');
  const signingKey = crypto.createPrivateKey(raw.signingKey);
  if (codeSecret.length < 32) throw new Error('codeSecret must be at least 32 bytes');
  if (deliveryKey.length !== 32) throw new Error('deliveryKey must be 32 bytes (AES-256)');
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('signingKey must be Ed25519');
  if (typeof raw.adminToken !== 'string' || raw.adminToken.length < 32) throw new Error('adminToken must be at least 32 characters');
  return { codeSecret, deliveryKey, signingKey, adminToken: raw.adminToken };
}

// Reads the key file, or (create: true) writes a fresh one first. Written aside and then linked
// into place, so two processes starting together can't each use different keys or read a
// half-written file: the loser of the link reads the winner's file.
function loadKeys(file, { create = false } = {}) {
  if (create && !fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(generateKeys(), null, 2), { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(tmp, file); } catch (err) { if (err.code !== 'EEXIST') throw err; } finally { fs.unlinkSync(tmp); }
  }
  return parseKeys(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { generateKeys, parseKeys, loadKeys };
