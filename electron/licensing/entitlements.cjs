// Which features a request may use (plan LC10), decided in the main process for every request that
// uses one: ipc/channels.cjs asks here before it runs the action, so a window that skips its own
// buttons (or calls the bridge directly) gets the same answer. Hiding a button is not enforcement.
//
// The policy is injected. The shipped one is 'open': everything stays available exactly as before
// licensing, until the owner decides the commercial policy. 'enforce' is the mechanism for later (and
// for the tests): a feature is allowed when the policy lists it as free, or the licence is active and
// its signed certificate lists the feature.
//
// Never gated, whatever the policy: scans and what they show, recovery and activation, history,
// exports, restore points, settings and the service. A licence is never a Windows administrator
// right: admin approval stays with Windows and the service. A check happens only before an action
// starts; a licence that changes while an action runs never interrupts it.

// The features an action can need, and the request channels that use each.
const GATED = {
  drivers: ['drv:install', 'drv:gpuInstaller', 'dev:enable'],
  bios: ['bios:download'],
  cleanup: ['junk:clean'],
  startup: ['startup:toggle'],
  settings: ['rec:apply'],
};
const FEATURE_OF = Object.fromEntries(Object.entries(GATED).flatMap(([feature, channels]) => channels.map((c) => [c, feature])));

const POLICIES = {
  open: () => ({ ok: true }),
  enforce: ({ feature, license, free = [] }) => {
    if (free.includes(feature)) return { ok: true };
    if (!license || license.state !== 'active') return { ok: false, reason: 'noLicense', state: license ? license.state : 'none' };
    return license.features.includes(feature) ? { ok: true } : { ok: false, reason: 'notInPlan' };
  },
};

// policy: a name in POLICIES or a function ({ feature, license }) -> { ok, reason }.
// license: () -> { state, features } (the licence as judged right now).
function createEntitlements({ policy = 'open', license = () => null, free = [] } = {}) {
  const decide = typeof policy === 'function' ? policy : POLICIES[policy];
  if (!decide) throw new Error(`unknown entitlement policy ${policy}`);
  return {
    policy: typeof policy === 'function' ? 'custom' : policy,
    check(feature) {
      try {
        const r = decide({ feature, license: license(), free });
        return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.reason) || 'denied', feature };
      } catch {
        // a policy that fails denies (only under a policy that gates at all; 'open' can't fail)
        return { ok: false, reason: 'policyError', feature };
      }
    },
  };
}

module.exports = { createEntitlements, GATED, FEATURE_OF, POLICIES };
