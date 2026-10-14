// The licensing PoC's boundaries, checked like tests/architecture.test.cjs checks the app's:
// - certificate.cjs and device.cjs are what Tune's main process would ship: node:crypto only
//   (device.cjs may also use certificate.cjs), so they can be copied in without the server;
// - the database stays behind store.cjs: no other module opens SQLite or writes SQL, so a
//   Postgres adapter replaces one file;
// - no require cycles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..');
const modules = fs.readdirSync(DIR).filter((f) => f.endsWith('.cjs'));
const source = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const requires = (f) => [...source(f).matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1].replace(/^\.\//, ''));

test('the client-side modules need nothing but node:crypto (and each other)', () => {
  assert.deepEqual(requires('certificate.cjs'), ['node:crypto']);
  assert.deepEqual(requires('device.cjs').sort(), ['certificate.cjs', 'node:crypto']);
});

test('only store.cjs touches the database', () => {
  const sql = /\b(SELECT\s.+\sFROM|INSERT INTO|UPDATE \w+ SET|DELETE FROM|BEGIN IMMEDIATE')/;
  for (const f of modules) {
    if (f === 'store.cjs') continue;
    assert.ok(!requires(f).includes('node:sqlite'), `${f} requires node:sqlite`);
    assert.ok(!sql.test(source(f)), `${f} contains SQL`);
  }
});

test('no require cycles', () => {
  const state = new Map();
  const visit = (f, trail) => {
    if (state.get(f) === 'done') return;
    assert.notEqual(state.get(f), 'open', `cycle: ${[...trail, f].join(' -> ')}`);
    state.set(f, 'open');
    for (const d of requires(f)) if (modules.includes(d)) visit(d, [...trail, f]);
    state.set(f, 'done');
  };
  for (const f of modules) visit(f, []);
});
