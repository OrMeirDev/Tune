// The licensing PoC's boundaries, checked like tests/architecture.test.cjs checks the app's:
// - certificate.cjs and device.cjs are what Tune's main process ships: they live in
//   electron/licensing/ (the app's packaged folder), need node:crypto only, and the server's
//   copies here are one-line re-exports of them, so the two sides can't drift apart;
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
  const CLIENT = path.join(DIR, '..', 'electron', 'licensing');
  const clientRequires = (f) => [...fs.readFileSync(path.join(CLIENT, f), 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1].replace(/^\.\//, ''));
  assert.deepEqual(clientRequires('certificate.cjs'), ['node:crypto']);
  assert.deepEqual(clientRequires('device-keys.cjs').sort(), ['certificate.cjs', 'node:crypto']);
  assert.deepEqual(clientRequires('serial.cjs'), []);
  assert.deepEqual(requires('codes.cjs').sort(), ['../electron/licensing/serial.cjs', 'node:crypto']);
  // the server's names are re-exports of the shipped files, nothing more
  assert.deepEqual(requires('certificate.cjs'), ['../electron/licensing/certificate.cjs']);
  assert.deepEqual(requires('device.cjs'), ['../electron/licensing/device-keys.cjs']);
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
