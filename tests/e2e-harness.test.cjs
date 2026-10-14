// R04: an end-to-end check passes only when every step ran and no check failed (e2e/harness.cjs).
// Each case runs the runner as a real process and reads its exit code and output: an error before
// the first check, an error after some passing checks, a failing check, a timeout and a cleanup that
// throws all exit non-zero without "ALL PASSED"; cleanup always runs; a cleanup error never hides the
// error before it. Also checks that e2e/licensing.cjs ends only through the runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HARNESS = path.join(__dirname, '..', 'e2e', 'harness.cjs');

// A tiny e2e script: two passing checks around the point where MODE makes something go wrong.
const SCRIPT = `
const { createRun } = require(${JSON.stringify(HARNESS)});
const MODE = process.env.MODE;
const run = createRun({ exit: (code) => process.exit(code) });
run.onCleanup(() => { console.log('cleanup ran'); if (process.env.CLEANUP_THROWS) throw new Error('cleanup broke'); });
run.guard(async () => {
  run.timeout(MODE === 'hang' ? 200 : 10000);
  if (MODE === 'throw-first') throw new Error('boom before any check');
  run.check('one', true);
  run.check('two', true);
  if (MODE === 'throw-after') throw new Error('boom after two checks');
  if (MODE === 'fail') run.check('three', false);
  if (MODE === 'hang') await new Promise(() => {});
});
`;

function runCase(mode, env = {}) {
  const r = spawnSync(process.execPath, ['-e', SCRIPT], { env: { ...process.env, MODE: mode, ...env }, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('every step ran and nothing failed: ALL PASSED, exit 0, cleanup ran', () => {
  const r = runCase('pass');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ALL PASSED/);
  assert.match(r.out, /cleanup ran/);
});

test('an error before the first check fails the run', () => {
  const r = runCase('throw-first');
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /ALL PASSED/);
  assert.match(r.out, /FAIL unexpected error: Error: boom before any check/);
  assert.match(r.out, /cleanup ran/);
});

test('an error after some passing checks fails the run', () => {
  const r = runCase('throw-after');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PASS one[\s\S]*PASS two/);
  assert.doesNotMatch(r.out, /ALL PASSED/);
  assert.match(r.out, /FAIL unexpected error: Error: boom after two checks/);
  assert.match(r.out, /stopped before the end/);
});

test('a failing check fails the run', () => {
  const r = runCase('fail');
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /ALL PASSED/);
});

test('a run that never finishes fails at its deadline', () => {
  const r = runCase('hang');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL timeout/);
  assert.doesNotMatch(r.out, /ALL PASSED/);
});

test("a cleanup that throws fails the run, and doesn't hide the error before it", () => {
  const after = runCase('throw-first', { CLEANUP_THROWS: '1' });
  assert.equal(after.code, 1, after.out);
  assert.ok(after.out.indexOf('boom before any check') < after.out.indexOf('FAIL cleanup'), 'the first error is reported first');
  assert.match(after.out, /FAIL cleanup: Error: cleanup broke/);
  const alone = runCase('pass', { CLEANUP_THROWS: '1' });
  assert.equal(alone.code, 1, alone.out);
  assert.doesNotMatch(alone.out, /ALL PASSED/);
});

test('the licensing e2e check ends only through the runner', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'licensing.cjs'), 'utf8');
  assert.match(src, /require\('\.\/harness\.cjs'\)/);
  assert.match(src, /run\.guard\(async \(\) => \{/);
  assert.match(src, /run\.timeout\(/);
  assert.doesNotMatch(src, /ALL PASSED|finish\(/, 'no success line of its own');
  // the one way out is the exit the runner is given
  assert.deepEqual(src.match(/^.*app\.exit\(.*$/gm), ['const run = createRun({ exit: (code) => app.exit(code) });']);
});
