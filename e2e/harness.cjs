// How an end-to-end check ends. It passes only when every step ran to the end and no check failed:
// an unexpected error, a timeout or a cleanup that throws makes it fail (exit code 1), cleanup runs
// whatever happened, and a cleanup error is reported after (never instead of) the error before it.
// No Electron here, so tests/e2e-harness.test.cjs can run it as a real process.
function createRun({ exit, log = (line) => console.log(line) }) {
  const failures = [];
  const cleanups = [];
  let ended = false;
  let timer = null;

  const check = (name, cond, got) => {
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got).slice(0, 300)})` : ''}`);
    if (!cond) failures.push(name);
    return !!cond;
  };
  const fail = (name, err) => {
    log(`FAIL ${name}${err ? `: ${(err && err.stack) || err}` : ''}`);
    failures.push(name);
  };
  // A check the steps after it depend on: when it fails, the run stops there (cleanup still runs and
  // it exits non-zero) and says which steps were not run, instead of acting on a page that isn't ready.
  const need = (name, cond, got) => {
    if (check(name, cond, got)) return true;
    throw Object.assign(new Error(`"${name}" failed, so the steps that depend on it were not run`), { unmet: true });
  };
  // cleanups run last-registered first
  const onCleanup = (fn) => { cleanups.push(fn); };

  async function end(completed) {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch (e) { fail('cleanup', e); }
    }
    const ok = completed === true && failures.length === 0;
    log(ok ? 'ALL PASSED' : `${Math.max(failures.length, 1)} FAILED${completed === true ? '' : ' (stopped before the end)'}`);
    exit(ok ? 0 : 1);
  }

  // Runs the steps: the run passes only if they all complete and nothing failed.
  const guard = (steps) => Promise.resolve()
    .then(steps)
    .then(() => end(true), (e) => {
      if (e && e.unmet) log(`STOPPED ${e.message}`);
      else fail('unexpected error', e);
      return end(false);
    });

  // A deadline for the whole run (it keeps the process alive until then; end() clears it).
  const timeout = (ms) => {
    timer = setTimeout(() => { fail(`timeout after ${Math.round(ms / 1000)} s`); end(false); }, ms);
    return timer;
  };

  return { check, need, fail, onCleanup, guard, timeout, end, failures };
}

module.exports = { createRun };
