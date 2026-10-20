// Downloads and process starts fail cleanly (audit TUN-13): every failure is an { ok: false } result,
// nothing half-written is left behind, and a missing PowerShell doesn't crash the app. Also the OEM
// catalogs' hash fields (audit TUN-14). Downloads use a fake fetch, so no network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadFile } = require('../electron/infra/download.cjs');
const { sha256Or } = require('../electron/oem-bios.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-dl-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const leftovers = () => fs.readdirSync(dir);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// a fake fetch answer: body chunks, optional content-length, final URL; `hang` never sends data
function fakeFetch({ chunks = [], length, url = 'https://drivers.amd.com/f.bin', status = 200, hang = false }) {
  return async (_u, opts) => ({
    ok: status < 400, status, url,
    headers: new Map(length != null ? [['content-length', String(length)]] : []),
    body: {
      async *[Symbol.asyncIterator]() {
        if (hang) {
          await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        for (const c of chunks) yield Buffer.from(c);
      },
    },
  });
}
const withFetch = async (f, run) => { const real = global.fetch; global.fetch = f; try { return await run(); } finally { global.fetch = real; } };
const file = (n) => path.join(dir, n);

test('a good download lands under its real name, verified, with nothing else left', async () => {
  const data = 'hello driver';
  const r = await withFetch(fakeFetch({ chunks: ['hello ', 'driver'], length: data.length }), () => downloadFile('https://drivers.amd.com/f.bin', file('ok.bin'), { sha256: sha(data) }));
  assert.deepEqual(r, { ok: true, data: file('ok.bin') });
  assert.equal(fs.readFileSync(file('ok.bin'), 'utf8'), data);
  assert.deepEqual(leftovers(), ['ok.bin']);
  fs.rmSync(file('ok.bin'));
});

test('failures return an error and leave no file', async () => {
  const cases = [
    ['checksum mismatch', fakeFetch({ chunks: ['abc'], length: 3 }), { sha256: sha('xyz') }, /checksum mismatch/],
    ['redirect to http', fakeFetch({ chunks: ['abc'], url: 'http://evil.example/f.bin' }), {}, /insecure/],
    ['too large (announced)', fakeFetch({ chunks: ['abc'], length: 10_000 }), { limits: { maxBytes: 100 } }, /too large/],
    ['too large (streamed)', fakeFetch({ chunks: ['x'.repeat(60), 'x'.repeat(60)] }), { limits: { maxBytes: 100 } }, /too large/],
    ['stalled', fakeFetch({ hang: true }), { limits: { stallMs: 80 } }, /stalled/],
    ['deadline', fakeFetch({ hang: true }), { limits: { deadlineMs: 80 } }, /too long/],
    ['cut short', fakeFetch({ chunks: ['abc'], length: 10 }), {}, /cut short/],
    ['HTTP error', fakeFetch({ status: 404 }), {}, /HTTP 404/],
  ];
  for (const [name, f, opts, err] of cases) {
    const r = await withFetch(f, () => downloadFile('https://drivers.amd.com/f.bin', file('x.bin'), opts));
    assert.equal(r.ok, false, name);
    assert.match(r.error, err, name);
    assert.deepEqual(leftovers(), [], `${name}: nothing left behind`);
  }
});

test('a folder that cannot be written to is an error, not a crash', async () => {
  const r = await withFetch(fakeFetch({ chunks: ['abc'], length: 3 }), () => downloadFile('https://drivers.amd.com/f.bin', path.join(dir, 'missing', 'f.bin')));
  assert.equal(r.ok, false);
  assert.match(r.error, /could not save|ENOENT/);
});

test('a missing PowerShell gives an error result instead of crashing', async () => {
  const key = require.resolve('../electron/infra/powershell.cjs');
  const saved = { root: process.env.SystemRoot, mod: require.cache[key] };
  delete require.cache[key];
  process.env.SystemRoot = path.join(dir, 'no-windows-here');
  try {
    const { runPS } = require('../electron/infra/powershell.cjs');
    const r = await runPS('$result = 1');
    assert.equal(r.ok, false);
    assert.match(r.error, /could not start PowerShell/);
  } finally {
    process.env.SystemRoot = saved.root;
    delete require.cache[key];
    if (saved.mod) require.cache[key] = saved.mod;
  }
});

test("an OEM catalog's hash is used only if it is a SHA-256", () => {
  const h = 'A'.repeat(64);
  assert.equal(sha256Or(h), 'a'.repeat(64));
  assert.equal(sha256Or(` ${h} `), 'a'.repeat(64));
  assert.equal(sha256Or('1A2B3C4D'), null, 'a CRC32 (Lenovo field named CRC)');
  assert.equal(sha256Or('z'.repeat(64)), null);
  assert.equal(sha256Or(null), null);
});
