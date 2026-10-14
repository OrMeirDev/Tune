// Hardware advice that follows a vendor's published guidance. Each rule keeps its source and the
// date that source was last checked, so moving a baseline is one reviewed change here.
// Pure: no Electron and no Windows calls (tested in tests/advice-rules.test.cjs).

// 13th–14th gen Intel desktop chips (65 W and up), affected by the Vmin shift instability.
// Laptop chips (H/HX/U/P) are not affected.
const INTEL_1314_DESKTOP = /i[579]-1[34]\d{3}(KS|KF|K|F|T)?(?![A-Z0-9])/i;

// Intel's baseline for those chips: a BIOS with microcode 0x12F or later (0x12B was an earlier
// step of the fix and is no longer enough).
const MICROCODE_RULE = {
  minRevision: 0x12F,
  source: 'https://www.intel.com/content/www/us/en/support/articles/000102331/processors.html',
  reviewed: '2026-10-14',
};

const hex = (n) => `0x${Number(n).toString(16).toUpperCase()}`;

// The microcode finding for one PC, or null when it doesn't apply (not an affected chip, a laptop)
// or the revision couldn't be read; an unknown revision is never reported as fine.
function microcodeAdvice({ cpu, rev, laptop }) {
  if (laptop || !INTEL_1314_DESKTOP.test(cpu || '')) return null;
  const n = Number(rev);
  if (rev == null || rev === '' || !Number.isInteger(n) || n <= 0) return null;
  return { key: 'microcode', group: 'cpu', rev: n, hex: hex(n), min: hex(MICROCODE_RULE.minRevision), ok: n >= MICROCODE_RULE.minRevision, action: null };
}

module.exports = { INTEL_1314_DESKTOP, MICROCODE_RULE, microcodeAdvice };
