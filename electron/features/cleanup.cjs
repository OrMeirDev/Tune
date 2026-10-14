// Leftover files, by fixed category: what can be freed, and cleaning it.
const { runPS } = require('../infra/powershell.cjs');
const { CLEAN_OP, JUNK } = require('../privilege/operations.cjs');
const { privileged } = require('../privilege/service.cjs');

const junkScan = () => runPS(`${JUNK}
$result = @(foreach ($c in $cats) { $f = @(Files $c)
  @{ key = $c.key; admin = $c.admin; bytes = [int64](($f | Measure-Object Length -Sum).Sum); files = $f.Count; minAgeHours = $c.minAgeHours; dirs = @($c.paths | Where-Object { Test-Path -LiteralPath $_ }) } })`);

// The user's own folders are cleaned as the user; Windows' folders through the service or the
// admin session (which may run as SYSTEM, where "my temp folder" would be the wrong one).
const ADMIN_JUNK = ['winTemp', 'wuCache', 'dumps'];

async function junkClean(keys) {
  const all = keys.map((k) => String(k).replace(/[^a-zA-Z]/g, ''));
  const mine = all.filter((k) => !ADMIN_JUNK.includes(k));
  const sys = all.filter((k) => ADMIN_JUNK.includes(k));
  const total = { freed: 0, skipped: 0 };
  if (mine.length) {
    const r = await runPS(`$req = @{ keys = @(${mine.map((k) => `'${k}'`).join(',')}) }${JUNK}${CLEAN_OP}`);
    if (!r.ok) return r;
    total.freed += r.data.freed; total.skipped += r.data.skipped;
  }
  if (sys.length) {
    const r = await privileged({ op: 'clean', keys: sys }, { timeoutMs: 10 * 60 * 1000 });
    if (!r.ok && !mine.length) return r;
    if (r.ok) { total.freed += r.data.freed; total.skipped += r.data.skipped; } else total.adminError = r.error;
    return { ok: true, data: total, adminUntil: r.adminUntil };
  }
  return { ok: true, data: total };
}

module.exports = { junkScan, junkClean };
