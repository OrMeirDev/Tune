const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOperationStore } = require('../electron/infra/operation-store.cjs');
const ID = '11111111-2222-4333-8444-555555555555';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-operations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'operations.json');
  return { file, open: () => createOperationStore({ file, uuid: () => ID }) };
}
test('operation IDs survive a restart without storing an executable request', t => {
  const f = fixture(t), s = f.open();
  assert.equal(s.begin({ op: 'drivers', ids: ['private'], url: 'https://private.test/token' }), ID);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /private|token|https/);
  assert.equal(f.open().read()[0].state, 'running');
});
test('lost result: status-only recovery preserves driver, restore and reboot evidence', async t => {
  const f = fixture(t), s = f.open(); s.begin({ op: 'drivers' }); s.settle(ID, { ok: false, code: 'noAnswer' });
  const calls = [], result = { ok: true, data: { results: [{ id: ID, code: 2 }], reboot: true, restore: 'created' } };
  const rows = await f.open().recover(async id => { calls.push(id); return { ok: true, data: { id, op: 'drivers', state: 'completed', result } }; });
  assert.deepEqual(calls, [ID]); assert.equal(rows[0].state, 'completed'); assert.deepEqual(rows[0].result, result);
});
test('wrong IDs, missing journals and service restarts cannot turn into success', async t => {
  const f = fixture(t), s = f.open(); s.begin({ op: 'clean' }); s.settle(ID, { ok: false, code: 'noAnswer' });
  for (const reply of [{ ok: false, code: 'notFound' }, { ok: true, data: { id: 'other', op: 'clean', state: 'completed', result: { ok: true } } }])
    assert.equal((await s.recover(async () => reply))[0].state, 'unknown');
  assert.equal((await s.recover(async id => ({ ok: true, data: { id, op: 'clean', state: 'interrupted' } })))[0].state, 'interrupted');
});
test('an older status cannot overwrite a completion that arrived during recovery', async t => {
  const f = fixture(t), s = f.open(); s.begin({ op: 'restore' });
  const result = { ok: true, data: 'created' };
  const rows = await s.recover(async id => { s.settle(id, result); return { ok: true, data: { id, op: 'restore', state: 'running' } }; });
  assert.equal(rows[0].state, 'completed'); assert.deepEqual(rows[0].result, result);
});
test('a corrupt operation index refuses a new mutation and preserves the evidence', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{broken');
  assert.throws(() => f.open().begin({ op: 'clean' })); assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
});
test('unconfirmed operations are never evicted to make room', t => {
  const f = fixture(t), rows = Array.from({ length: 500 }, (_, n) => ({
    id: n.toString(16).padStart(8, '0') + '-2222-4333-8444-555555555555', op: 'clean', state: 'unknown', startedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(f.file, JSON.stringify(rows));
  assert.throws(() => f.open().begin({ op: 'clean' }), /without a confirmed/); assert.equal(f.open().read().length, 500);
});
test('the real service client recovers a lost answer without replaying through either helper', async t => {
  const f = fixture(t), pipe = require('../electron/privilege/pipe.cjs'), admin = require('../electron/privilege/admin-session.cjs');
  const oldPipe = pipe.pipeCall, oldAdmin = admin.adminCall, key = require.resolve('../electron/privilege/service.cjs');
  const calls = [], current = require('../electron/privilege/service-version.cjs');
  pipe.pipeCall = async (_name, req) => {
    calls.push(req);
    if (req.op === 'version') return { ok: true, data: { version: current } };
    if (req.op === 'operationStatus') return { ok: true, data: { id: req.operationId, op: 'clean', state: 'completed', result: { ok: true, data: { freed: 3 } } } };
    return { ok: false, code: 'noAnswer', error: 'answer lost' };
  };
  admin.adminCall = () => { throw new Error('must not fall back'); };
  delete require.cache[key]; const svc = require(key);
  t.after(() => { pipe.pipeCall = oldPipe; admin.adminCall = oldAdmin; delete require.cache[key]; });
  svc.setOperationStore(f.open());
  const result = await svc.privileged({ op: 'clean', keys: [] });
  assert.equal(result.operationId, ID); assert.equal(result.code, 'noAnswer');
  assert.equal((await svc.operationHistory())[0].detail.operationState, 'completed');
  assert.equal(calls.filter(r => r.op === 'clean').length, 1);
  assert.deepEqual(calls.filter(r => r.op === 'operationStatus').map(r => r.operationId), [ID]);
  assert.deepEqual(svc.operationHistoryView([{ action: 'clean', detail: { operationId: ID } }]), []);
});
