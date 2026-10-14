// The local measurement history (plan PF02.3): kept between launches, a start of Windows read again
// is not stored twice, a damaged file doesn't break it, and the export is a safe spreadsheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMeasureStore } = require('../electron/measure-store.cjs');
const M = require('../electron/domain/measurement-policy.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tune-measure-'));
const bootRec = (startedAt, value) => M.record({ metric: 'bootToDesktopMs', value, at: startedAt, method: 'windowsBootLog', conditions: { bootType: 'full', startedAt }, key: `boot:${startedAt}:bootToDesktopMs` });

test('kept between launches, newest first, a start of Windows only once', () => {
  const dir = tmp();
  const file = path.join(dir, 'measurements.json');
  const s1 = createMeasureStore({ file });
  assert.equal(s1.add([bootRec('2026-10-01T08:00:00.000Z', 30000), bootRec('2026-10-02T08:00:00.000Z', 25000)]).length, 2);
  assert.equal(s1.add([bootRec('2026-10-02T08:00:00.000Z', 25000)]).length, 0, 'read again from the log: not added');
  const s2 = createMeasureStore({ file });
  assert.deepEqual(s2.list().map((r) => r.value), [25000, 30000]);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'written through a temp file and renamed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a damaged or edited file: unreadable entries are skipped, the rest still works', () => {
  const dir = tmp();
  const file = path.join(dir, 'measurements.json');
  fs.writeFileSync(file, JSON.stringify([bootRec('2026-10-01T08:00:00.000Z', 30000), { metric: 'x' }, null, 'text']));
  assert.equal(createMeasureStore({ file }).list().length, 1);
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(createMeasureStore({ file }).list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cleanup pair is stored with its change and the view compares it', () => {
  const dir = tmp();
  const store = createMeasureStore({ file: path.join(dir, 'm.json') });
  const r = store.addDiskPair({ drive: 'C:', freeBytes: 40e9 }, { drive: 'C:', freeBytes: 41.5e9 }, 'change-1');
  assert.deepEqual([r.state, r.delta], ['better', 1.5e9]);
  const v = store.view([{ id: 'change-1', action: 'clean', detail: { freed: 1.6e9 }, at: new Date().toISOString() }]);
  assert.equal(v.changes[0].results[0].delta, 1.5e9);
  assert.equal(v.latest.diskFreeBytes.value, 41.5e9);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the export is a spreadsheet whose cells never run as formulas', () => {
  const dir = tmp();
  const store = createMeasureStore({ file: path.join(dir, 'm.json') });
  store.add([M.record({ metric: 'restCpuLoad', value: 4, at: '2026-10-01T08:00:00.000Z', method: 'restSampling', conditions: { loadBand: 'rest', samples: 10 } })]);
  // a hand-edited file: the method is any string, so it could start like a formula
  store.add([{ ...M.record({ metric: 'restCpuLoad', value: 5, at: '2026-10-02T08:00:00.000Z', method: 'x' }), method: '=HYPERLINK("http://evil")' }]);
  const csv = store.csv().split('\r\n');
  assert.equal(csv.length, 3);
  assert.match(csv[0], /^"Time \(UTC\)","Measurement"/);
  assert.match(csv[2], /"restCpuLoad","4","%","","restSampling","loadBand=rest; samples=10"/, 'conditions in one cell');
  assert.match(csv[1], /"'=HYPERLINK\(""http:\/\/evil""\)"/, 'a formula stays literal text');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a write that fails doesn't fail the change it measured", () => {
  const dir = tmp();
  // the temp file's name is taken by a folder, so the write fails the way a full or locked disk would
  const file = path.join(dir, 'm.json');
  fs.mkdirSync(`${file}.tmp`);
  const store = createMeasureStore({ file });
  assert.doesNotThrow(() => store.addDiskPair({ drive: 'C:', freeBytes: 1e9 }, { drive: 'C:', freeBytes: 2e9 }, 'x'));
  assert.equal(store.list().length, 2, 'kept for this session');
  fs.rmSync(dir, { recursive: true, force: true });
});
