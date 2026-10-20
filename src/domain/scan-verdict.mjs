// What the updates page may say after a scan. Pure (no React, no Electron); tested in
// tests/scan-verdict.test.cjs.
//
// Each check reports one state:
//   'ok'          it ran and answered (zero updates is an answer)
//   'error'       it couldn't run or failed, so its answer is unknown
//   'unsupported' it doesn't apply here (e.g. a board maker without a BIOS catalog)
// "All up to date" needs every check to have answered or not to apply, and nothing to install.
// A failed check is never shown as up to date, even when the others found nothing.

export const SOURCES = ['hw', 'wu', 'gpu', 'bios'];

// The state of each check from the raw results of one scan.
export function sourcesFrom({ hw, wu, gpu, bios }) {
  return {
    hw: hw?.ok ? 'ok' : 'error',
    wu: wu?.ok ? 'ok' : 'error',
    // without the hardware scan there is nothing to check the graphics driver against; and the
    // check answered only if no card in it failed (each card carries its own status)
    gpu: !hw?.ok || !gpu?.ok || [].concat(gpu.data || []).some((g) => g?.status === 'error' || g?.error || g?.installerKind === 'autodetect') ? 'error' : 'ok',
    // a maker's catalog that failed comes back as ok with an error field
    bios: !bios?.ok || bios.data?.error ? 'error' : bios.data?.supported === false ? 'unsupported' : 'ok',
  };
}

// 'scanning' | 'pending' (no finished scan yet) | 'updates' | 'incomplete' | 'allGood',
// plus the checks that failed.
export function scanVerdict({ running, sources = {}, total = 0 }) {
  const failed = SOURCES.filter((k) => sources[k] === 'error');
  if (running) return { state: 'scanning', failed };
  if (total > 0) return { state: 'updates', failed };
  if (failed.length) return { state: 'incomplete', failed };
  if (SOURCES.some((k) => sources[k] == null)) return { state: 'pending', failed };
  return { state: 'allGood', failed };
}
