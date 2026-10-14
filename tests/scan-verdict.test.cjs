// What the updates page may say after a scan (audit TUN-03): a failed check is never "all up to date".
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/domain/scan-verdict.mjs');
const OK = { ok: true, data: [] };
const allOk = { hw: 'ok', wu: 'ok', gpu: 'ok', bios: 'ok' };

test('everything answered and nothing to install: all up to date', async () => {
  const { scanVerdict } = await load();
  assert.equal(scanVerdict({ running: false, sources: allOk, total: 0 }).state, 'allGood');
  assert.equal(scanVerdict({ running: false, sources: { ...allOk, bios: 'unsupported' }, total: 0 }).state, 'allGood');
});

test('Windows Update failed: incomplete, not all up to date', async () => {
  const { scanVerdict } = await load();
  const v = scanVerdict({ running: false, sources: { ...allOk, wu: 'error' }, total: 0 });
  assert.equal(v.state, 'incomplete');
  assert.deepEqual(v.failed, ['wu']);
});

test('a vendor check failed: incomplete', async () => {
  const { scanVerdict } = await load();
  assert.equal(scanVerdict({ running: false, sources: { ...allOk, gpu: 'error' }, total: 0 }).state, 'incomplete');
  assert.equal(scanVerdict({ running: false, sources: { ...allOk, bios: 'error' }, total: 0 }).state, 'incomplete');
});

test('partial success with updates found: the updates show, and the failed check is named', async () => {
  const { scanVerdict } = await load();
  const v = scanVerdict({ running: false, sources: { ...allOk, gpu: 'error' }, total: 2 });
  assert.equal(v.state, 'updates');
  assert.deepEqual(v.failed, ['gpu']);
});

test('while scanning, or before any scan finished: no verdict', async () => {
  const { scanVerdict } = await load();
  assert.equal(scanVerdict({ running: true, sources: allOk, total: 0 }).state, 'scanning');
  assert.equal(scanVerdict({ running: false, sources: {}, total: 0 }).state, 'pending');
});

test('raw results map to check states', async () => {
  const { sourcesFrom } = await load();
  assert.deepEqual(sourcesFrom({ hw: OK, wu: OK, gpu: OK, bios: { ok: true, data: { supported: true } } }), allOk);
  assert.deepEqual(sourcesFrom({ hw: OK, wu: { ok: false, error: 'x' }, gpu: OK, bios: { ok: true, data: { supported: false } } }),
    { hw: 'ok', wu: 'error', gpu: 'ok', bios: 'unsupported' });
  // a maker catalog that failed comes back as ok with an error field
  assert.equal(sourcesFrom({ hw: OK, wu: OK, gpu: OK, bios: { ok: true, data: { supported: false, error: 'timeout' } } }).bios, 'error');
  // no hardware scan: neither the GPU nor the BIOS could be checked
  const s = sourcesFrom({ hw: { ok: false }, wu: OK, gpu: { ok: false }, bios: { ok: false } });
  assert.deepEqual([s.hw, s.gpu, s.bios], ['error', 'error', 'error']);
});
