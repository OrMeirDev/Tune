const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCapture } = require('../e2e/capture.cjs');
const { createRun } = require('../e2e/harness.cjs');

function fixture(t, outcomes, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-capture-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0, throttled = true, exitCode;
  const run = createRun({ exit: c => { exitCode = c; }, log() {} });
  const image = { isEmpty: () => false, getSize: () => ({ width: 100, height: 50 }), toPNG: () => Buffer.from('test image') };
  const wc = {
    isDestroyed: () => false, isLoading: () => false,
    getBackgroundThrottling: () => throttled, setBackgroundThrottling: v => { throttled = v; },
    capturePage: async (_rect, opts) => {
      assert.equal(opts.stayAwake, true);
      const v = outcomes[calls++];
      if (v instanceof Error) throw v;
      return v || image;
    },
  };
  const win = { webContents: wc, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getContentSize: () => [100, 50] };
  const capture = createCapture({ win, outDir: dir, run, prepareWindow: async () => {}, ...extra });
  return { capture, run, wc, dir, calls: () => calls, throttled: () => throttled, exitCode: () => exitCode,
    diagnostics: () => JSON.parse(fs.readFileSync(path.join(dir, 'one.png.json'), 'utf8')) };
}
test('recognized compositor failure: bounded recovery preserves the first failure', async t => {
  const f = fixture(t, [new Error('UnknownVizError'), null]);
  assert.equal(await f.capture('one.png'), true);
  assert.equal(f.calls(), 2);
  assert.equal(f.throttled(), true);
  assert.match(f.diagnostics()[0].error, /UnknownVizError/);
  assert.equal(f.diagnostics()[1].ok, true);
});
test('capture exhaustion fails the run, but later independent assertions still run', async t => {
  const f = fixture(t, Array.from({ length: 3 }, () => new Error('UnknownVizError')));
  fs.writeFileSync(path.join(f.dir, 'one.png'), 'older run');
  let later = false;
  await f.run.guard(async () => {
    assert.equal(await f.capture('one.png'), false);
    later = true;
    f.run.check('independent behavior', true);
  });
  assert.equal(later, true);
  assert.equal(f.exitCode(), 1);
  assert.equal(f.calls(), 3);
  assert.equal(f.diagnostics().length, 3);
  assert.equal(fs.existsSync(path.join(f.dir, 'one.png')), false);
});
test('unexpected errors are not retried or hidden', async t => {
  const f = fixture(t, [new Error('disk or API failure')]);
  assert.equal(await f.capture('one.png'), false);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.run.failures, ['required screenshot one.png']);
});
test('empty images fail the evidence requirement', async t => {
  const f = fixture(t, [{ isEmpty: () => true }]);
  assert.equal(await f.capture('one.png'), false);
  assert.match(f.diagnostics()[0].error, /empty image/);
});
test('a hung paint barrier is bounded and does not call capture', async t => {
  const f = fixture(t, [], { timeoutMs: 15, prepareWindow: () => new Promise(() => {}) });
  assert.equal(await f.capture('one.png'), false);
  assert.equal(f.calls(), 0);
  assert.match(f.diagnostics()[0].error, /timed out/);
});
test('capture cannot write outside the evidence directory', async t => {
  const f = fixture(t, []);
  await assert.rejects(f.capture('../one.png'), /invalid capture/);
  assert.equal(f.calls(), 0);
});
