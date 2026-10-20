const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED, assess, waitForCI } = require('../scripts/ci/release-gate.cjs');
const sha = 'a'.repeat(40), old = 'b'.repeat(40);
const good = { id: 12, head_sha: sha, status: 'completed', conclusion: 'success' };
const jobs = REQUIRED.map(name => ({ name, run_id: 12, status: 'completed', conclusion: 'success' }));
test('a green run from another commit never authorizes publishing', () => {
  assert.equal(assess([{ ...good, head_sha: old }], jobs, sha).state, 'waiting');
});
test('release readiness needs all four successful jobs on this exact run', () => {
  assert.equal(assess([good], jobs, sha).state, 'ready');
  for (const name of REQUIRED) {
    assert.equal(assess([good], jobs.filter(j => j.name !== name), sha).state, 'failed', name);
    assert.equal(assess([good], jobs.map(j => j.name === name ? { ...j, conclusion: 'skipped' } : j), sha).state, 'failed', name);
  }
  assert.equal(assess([good], jobs.map(j => ({ ...j, run_id: 11 })), sha).state, 'failed');
});
test('a later failed or running rerun takes precedence over older green evidence', () => {
  assert.equal(assess([good, { ...good, id: 13, conclusion: 'failure' }], jobs, sha).state, 'failed');
  assert.equal(assess([good, { ...good, id: 13, status: 'in_progress' }], jobs, sha).state, 'waiting');
});
test('readiness API errors fail closed and never print the token', async () => {
  await assert.rejects(waitForCI({ repo: 'o/r', sha, token: 'secret', request: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});
test('a missing CI run is bounded by a deadline', async () => {
  let now = 0;
  await assert.rejects(waitForCI({ repo: 'o/r', sha, token: 'secret', now: () => now, timeoutMs: 100, delay: async () => { now += 100; }, request: async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) }) }), /deadline/);
});
