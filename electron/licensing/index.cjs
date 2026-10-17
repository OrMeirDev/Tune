// Licensing in the main process, put together: the configuration (shipped defaults: no server, the
// open policy), DPAPI-protected storage, this PC's identity, the API client and the flows, and the
// entitlement check the request layer asks before an action. main.cjs hands in what only it has
// (Electron's safeStorage and net.fetch, the profile folder, whether the app is packaged).
const path = require('node:path');
const { runPS } = require('../infra/powershell.cjs');
const { createApi } = require('./api.cjs');
const { createLicensingClient } = require('./client.cjs');
const { licensingConfig } = require('./config.cjs');
const { createEntitlements, FEATURE_OF } = require('./entitlements.cjs');
const { readMachineId } = require('./identity.cjs');
const { createProtectedStore, electronCrypt, insecureTestCrypt } = require('./protected-store.cjs');

// onChange: told when the licence changed without the window asking (a background renewal).
function createLicensing({ packaged, userData, safeStorage, fetch, env = process.env, now = Date.now, onChange }) {
  const config = licensingConfig({ packaged, env });
  const crypt = config.testStorage ? insecureTestCrypt() : electronCrypt(safeStorage);
  const store = createProtectedStore({ file: path.join(userData, 'license.bin'), crypt });
  // read once per run (it doesn't change while Tune runs); a failed read is tried again next time
  let identity = null;
  const machineId = async () => {
    if (config.testMachineId) return { ok: true, machineId: config.testMachineId };
    if (!identity || !identity.ok) identity = await readMachineId(runPS);
    return identity;
  };
  const api = config.url ? createApi({ baseUrl: config.url, fetch }) : null;
  const client = createLicensingClient({ config, api, store, machineId, now, onChange });
  const entitlements = createEntitlements({ policy: config.policy, license: client.current });
  return {
    client,
    entitlements: { policy: entitlements.policy, check: entitlements.check, featureOf: (channel) => FEATURE_OF[channel] || null },
  };
}

module.exports = { createLicensing };
