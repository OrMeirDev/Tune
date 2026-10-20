const test = require('node:test');
const assert = require('node:assert/strict');
const { vendorFetch, boundedBody } = require('../electron/infra/vendor-fetch.cjs');
async function withFetch(f, run) {
  const original = global.fetch, calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, headers: new Headers(opts.headers) });
    assert.equal(opts.redirect, 'manual');
    return f(url, calls.length);
  };
  try { return await run(calls); } finally { global.fetch = original; }
}
test('untrusted initial destinations cause zero requests', () => withFetch(() => { throw new Error('must not contact'); }, async calls => {
  for (const u of ['http://drivers.amd.com/x', 'https://drivers.amd.com.evil.test/x', 'https://127.0.0.1/x', 'https://drivers.amd.com:444/x', 'https://u:p@drivers.amd.com/x', 'file:///tmp/x']) {
    await assert.rejects(vendorFetch(u), /unauthorized/);
  }
  assert.equal(calls.length, 0);
}));
test('untrusted redirect targets are rejected before contacting them', async () => {
  for (const location of ['http://drivers.amd.com/x', 'https://evil.test/x', 'https://127.0.0.1/x', 'https://download.lenovo.com/x']) {
    await withFetch(() => new Response(null, { status: 302, headers: { location } }), async calls => {
      await assert.rejects(vendorFetch('https://drivers.amd.com/x'), /unauthorized/);
      assert.equal(calls.length, 1, location);
    });
  }
});
test('every hop stays in the original vendor; cross-origin credentials are removed', () => withFetch((_url, n) => n === 1
  ? new Response(null, { status: 302, headers: { location: 'https://international.download.nvidia.com/new.exe' } })
  : n === 2 ? new Response(null, { status: 307, headers: { location: '/final.exe' } }) : new Response('driver'), async calls => {
  const r = await vendorFetch('https://us.download.nvidia.com/old.exe', { headers: { Cookie: 'private', Authorization: 'secret', Referer: 'https://www.nvidia.com/' } });
  assert.equal(await r.text(), 'driver');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.get('cookie'), 'private');
  assert.equal(calls[1].headers.get('cookie'), null);
  assert.equal(calls[2].headers.get('authorization'), null);
  assert.equal(calls[2].headers.get('referer'), 'https://www.nvidia.com/');
}));
test('redirect loops are bounded', () => withFetch(() => new Response(null, { status: 302, headers: { location: '/loop' } }), async calls => {
  await assert.rejects(vendorFetch('https://drivers.amd.com/x'), /too many/);
  assert.equal(calls.length, 6);
}));
test('catalog limits cover absent and misleading Content-Length', async () => {
  for (const headers of [{ 'content-length': '100' }, {}, { 'content-length': '1' }]) {
    await assert.rejects(boundedBody(new Response('123456789', { headers }), 8), /too large/);
  }
  assert.equal((await boundedBody(new Response('catalog'), 8)).toString(), 'catalog');
});
