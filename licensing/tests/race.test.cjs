// The real race (LC05/LC06): the same codes redeemed at the same moment from separate processes
// on one database file, directly and over HTTP. Exactly one license per code; every other
// request hears 'already_redeemed'. Child processes run on real time, so these tests do too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, pc, idemKey } = require('./helpers.cjs');

const WORKER = path.join(__dirname, 'race-worker.cjs');
const SERVER = path.join(__dirname, '..', 'server.cjs');

const { startChild, nextLine } = require('./process-output.cjs');

test('8 processes redeem the same 5 codes at once: one license per code, the rest already_redeemed', async (t) => {
  const env = setup(t, { now: Date.now });
  const keysFile = path.join(env.dir, 'keys.json');
  fs.writeFileSync(keysFile, JSON.stringify(env.rawKeys));
  const { units } = env.order({ quantity: 5 });
  const racers = Array.from({ length: 8 }, (_, i) => ({ token: env.owner(`racer${i}@example.com`), machine: pc(`racer-${i}`) }));

  const children = await Promise.all(racers.map(() => startChild(WORKER, { RACE_DB: env.file, RACE_KEYS: keysFile }, (l) => l === 'ready')));
  env.defer(() => Promise.all(children.map((c) => (c.exitCode === null ? (c.kill(), c.exited) : null))));
  // Every racer tries the first code first (the hardest collision), then the rest in its own order.
  const inputs = racers.map(({ token, machine }, i) => {
    const order = [0, ...[1, 2, 3, 4].map((k) => 1 + ((k - 1 + i) % 4))];
    return JSON.stringify({
      attempts: order.map((k) => ({
        unitId: units[k].unitId,
        address: `10.0.0.${i + 1}`,
        request: { code: units[k].code, ownerToken: token, machineId: machine.machineId, devicePublicKey: machine.publicKey, idempotencyKey: idemKey() },
      })),
    });
  });
  // The start signal: everyone's input written in the same tick.
  children.forEach((c, i) => c.stdin.write(`${inputs[i]}\n`));
  const results = (await Promise.all(children.map(nextLine))).flatMap((l) => JSON.parse(l));
  await Promise.all(children.map((c) => c.exited));

  assert.equal(results.length, 40);
  for (const u of units) {
    const mine = results.filter((r) => r.unitId === u.unitId);
    assert.equal(mine.filter((r) => r.result === 'ok').length, 1, `exactly one winner for ${u.suffix}`);
    assert.deepEqual([...new Set(mine.filter((r) => r.result !== 'ok').map((r) => r.result))], ['already_redeemed']);
  }
  const winners = results.filter((r) => r.result === 'ok').map((r) => r.licenseId);
  assert.equal(new Set(winners).size, 5);
  assert.equal(env.count('licenses'), 5);
  assert.equal(env.count('devices'), 5);
  assert.equal(env.count('idempotency_keys'), 5);
  assert.equal(env.count('codes', "state = 'redeemed'"), 5);
  assert.equal(env.count('events', "type = 'code.redeemed'"), 5);
  assert.deepEqual(env.sql().prepare('SELECT id FROM licenses ORDER BY id').all().map((r) => r.id), [...winners].sort());
});

test('HTTP: one code posted at once to three server processes on one database: one license', async (t) => {
  const env = setup(t, { now: Date.now });
  const keysFile = path.join(env.dir, 'keys.json');
  fs.writeFileSync(keysFile, JSON.stringify(env.rawKeys));
  const { units: [unit] } = env.order();
  const people = Array.from({ length: 12 }, (_, i) => ({ token: env.owner(`client${i}@example.com`), machine: pc(`client-${i}`) }));

  const servers = await Promise.all([0, 1, 2].map(() => startChild(SERVER, { TUNE_LICENSING_DB: env.file, TUNE_LICENSING_KEYS: keysFile, PORT: '0' }, (l) => l.includes('"listening"'))));
  env.defer(() => Promise.all(servers.map((s) => (s.exitCode === null ? (s.kill(), s.exited) : null))));
  const urls = servers.map((s) => JSON.parse(s.readyLine).url);

  const answers = await Promise.all(people.map(({ token, machine }, i) => fetch(`${urls[i % 3]}/v1/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: unit.code, ownerToken: token, machineId: machine.machineId, devicePublicKey: machine.publicKey, idempotencyKey: idemKey() }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }))));

  const ok = answers.filter((a) => a.status === 200);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].body.result, 'ok');
  for (const a of answers.filter((x) => x.status !== 200)) assert.deepEqual(a, { status: 409, body: { result: 'already_redeemed' } });
  assert.equal(env.count('licenses'), 1);
  assert.equal(env.sql().prepare('SELECT id FROM licenses').get().id, ok[0].body.licenseId);
});
