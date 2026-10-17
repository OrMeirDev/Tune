// This PC's identity for licensing:
// - the machine id: a hash of Windows' MachineGuid and the SMBIOS UUID, read as the user (read only),
//   so a reinstall of Tune on the same PC finds its licence again;
// - this install's device key: an Ed25519 key pair created the first time a licence is activated or
//   recovered, kept only in protected storage (protected-store.cjs), and replaced only by a new
//   install. Its private half never leaves the main process; the server sees the public half.
const crypto = require('node:crypto');
const { createDeviceKey, machineId: hashMachine } = require('./device-keys.cjs');
const { publicKeyString } = require('./certificate.cjs');

const IDENTITY_PS = `
$guid = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
$uuid = $null
try { $uuid = [string](Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop | Select-Object -First 1).UUID } catch {}
$result = @{ machineGuid = [string]$guid; smbiosUuid = $uuid }`;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Placeholder UUIDs some boards report for every unit: not an identity, so left out of the hash.
const PLACEHOLDER_UUIDS = /^(0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12}|03000200-0400-0500-0006-000700080009)$/i;

// -> { ok: true, machineId } | { ok: false }. `runPS` is the read-only PowerShell runner.
async function readMachineId(runPS) {
  const r = await runPS(IDENTITY_PS, { timeoutMs: 30000 });
  const guid = r && r.ok && r.data ? String(r.data.machineGuid || '').trim() : '';
  if (!GUID.test(guid)) return { ok: false };
  const uuid = String((r.data && r.data.smbiosUuid) || '').trim();
  return { ok: true, machineId: hashMachine({ machineGuid: guid, smbiosUuid: GUID.test(uuid) && !PLACEHOLDER_UUIDS.test(uuid) ? uuid : '' }) };
}

// A stored device key -> { publicKey (base64 SPKI), privateKey (KeyObject) }, or null when the stored
// value isn't a matching Ed25519 pair.
function deviceKeyFrom(stored) {
  if (!stored || typeof stored.privateKey !== 'string' || typeof stored.publicKey !== 'string') return null;
  try {
    const privateKey = crypto.createPrivateKey(stored.privateKey);
    if (privateKey.asymmetricKeyType !== 'ed25519') return null;
    const publicKey = publicKeyString(crypto.createPublicKey(privateKey));
    return publicKey === stored.publicKey ? { publicKey, privateKey } : null;
  } catch {
    return null;
  }
}

// A new device key, in the form it is stored (PKCS#8 PEM; only ever inside protected storage).
function newDeviceKey(now) {
  const { publicKey, privateKey } = createDeviceKey();
  return { publicKey, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), createdAt: now };
}

module.exports = { IDENTITY_PS, readMachineId, deviceKeyFrom, newDeviceKey };
