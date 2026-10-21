const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observeChild, nextLine } = require('../licensing/tests/process-output.cjs');
function child() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
}
test('race output delivered after exit but before close is retained', async () => {
  const c = child(), ready = observeChild(c, line => line === 'ready');
  c.stdout.emit('data', 'ready\n'); await ready;
  const result = nextLine(c);
  c.emit('exit', 0); c.stdout.emit('data', '[{"result":"ok"}]\n'); c.emit('close', 0, null);
  assert.equal(await result, '[{"result":"ok"}]');
  await c.exited;
});
test('queued child output remains readable even after close', async () => {
  const c = child(), ready = observeChild(c, line => line === 'ready');
  c.stdout.emit('data', 'ready\nanswer\n'); await ready; c.emit('close', 0, null);
  assert.equal(await nextLine(c), 'answer');
});
test('a real child failure reports its exit and diagnostic instead of losing them', async () => {
  const c = child(), ready = observeChild(c, line => line === 'ready');
  c.stdout.emit('data', 'ready\n'); await ready;
  const result = nextLine(c); c.stderr.emit('data', 'database failed'); c.emit('close', 1, null);
  await assert.rejects(result, /code.*1.*database failed/);
});

test('nextLine used as a map callback never interprets the child index as a deadline', async () => {
  const list = [child(), child()];
  for (const c of list) { const r = observeChild(c, line => line === 'ready'); c.stdout.emit('data', 'ready\n'); await r; }
  const replies = Promise.all(list.map(nextLine));
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const c of list) { c.stdout.emit('data', 'answer\n'); c.emit('close', 0, null); }
  assert.deepEqual(await replies, ['answer', 'answer']);
});
