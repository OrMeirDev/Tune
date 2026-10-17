'use strict';
// One racer in race.test.cjs, in its own process: opens the shared database, says "ready", waits
// for its attempts on stdin (that line is the start signal, sent to every racer at once), runs
// them and prints the results as one JSON line. The codes come over stdin, never argv or env.
const { openStore } = require('../store.cjs');
const { createService } = require('../service.cjs');
const { loadKeys } = require('../keys.cjs');

const store = openStore(process.env.RACE_DB);
const service = createService({ store, keys: loadKeys(process.env.RACE_KEYS) });

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const end = input.indexOf('\n');
  if (end < 0) return;
  process.stdin.destroy();
  const { attempts } = JSON.parse(input.slice(0, end));
  const results = attempts.map(({ unitId, request, address }) => {
    const r = service.redeem(request, { address });
    return { unitId, result: r.result, licenseId: r.licenseId || null };
  });
  store.close();
  process.stdout.write(`${JSON.stringify(results)}\n`);
});
process.stdout.write('ready\n');
