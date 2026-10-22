const test = require('node:test');
const assert = require('node:assert/strict');
const { amdProductPage, amdDriverFromPage, amdReleaseVersion } = require('../electron/domain/amd-catalog.cjs');
const name = 'AMD Radeon RX 7900 XTX';
const url = 'https://drivers.amd.com/drivers/whql-amd-software-adrenalin-edition-26.10.1-win11-b.exe';
const article = (version, link = url) => `<article><h4>AMD Software: Adrenalin Edition</h4><p>Adrenalin ${version} WHQL (Recommended)</p><a href="${link}">Download</a><a href="/en/resources/support-articles/release-notes/RN-RAD-WIN-26-10-1.html">Notes</a></article>`;
const html = `<meta property="og:title" content="AMD Radeon™ RX 7900 XTX Drivers and Downloads | Latest Version"><div class="accordion-item">Windows 10 - 64-Bit Edition${article('25.1.1',url.replaceAll('26.10.1','25.1.1'))}<div class="accordion-item">Windows 11 - 64-Bit Edition${article('26.10.1')}`;
test('AMD catalogs bind exact desktop model, suffix, OS and recommended package', () => {
  assert.ok(amdProductPage(name).endsWith('/amd-radeon-rx-7900-xtx.html'));
  assert.ok(amdProductPage('AMD Radeon RX 9070 XT').includes('radeon-rx-9000-series'));
  assert.equal(amdProductPage('AMD Radeon RX 7900M'), null);
  assert.equal(amdProductPage('AMD Radeon Graphics'), null);
  assert.equal(amdDriverFromPage(html, name, true).version, '26.10.1');
  assert.equal(amdDriverFromPage(html, name, false).version, '25.1.1');
  assert.throws(() => amdDriverFromPage(html, 'AMD Radeon RX 7900 XT', true), /match this GPU/);
  assert.equal(amdReleaseVersion('26.20.15.07'), null, 'internal build is not the public release number');
});
test('AMD parser rejects generic tools, missing OS, wrong versions and foreign downloads', () => {
  for (const bad of [url.replace('drivers.amd.com','evil.test'), url.replace('26.10.1','25.1.1'), url.replace('win11-b.exe','minimalsetup.exe'), url.replace('https:','http:')]) {
    assert.throws(() => amdDriverFromPage(html.replaceAll(url,bad),name,true));
  }
  assert.throws(() => amdDriverFromPage(html.replaceAll('Windows 11','Linux'), name, true), /Windows edition/);
  assert.throws(() => amdDriverFromPage(html.replaceAll('(Recommended)','(Optional)'), name, true), /WHQL/);
});
async function check(reply, release) {
  const original = global.fetch, calls = [];
  global.fetch = async address => { calls.push(String(address)); return reply(String(address),calls); };
  try { return { result: await require('../electron/features/gpu-drivers.cjs').gpuVendorCheck([{ name, driverVersion: '32.0.32015.7029' }],release), calls }; }
  finally { global.fetch = original; }
}
// The adapter uses the host's Windows version. Both fixture sections intentionally carry the
// same release for adapter tests; OS section selection itself is tested separately above.
const adapterHtml = html.replaceAll('25.1.1','26.10.1');
test('AMD confirms a newer or current release instead of always offering autodetect', async () => {
  const { sourcesFrom,scanVerdict } = await import('../src/domain/scan-verdict.mjs');
  for (const [installed,newer] of [['26.9.1',true],['26.10.1',false],['26.11.1',false]]) {
    const {result}=await check(() => new Response(adapterHtml),installed);
    const g=result.data[0];
    assert.equal(g.status,'ok'); assert.equal(g.newer,newer); assert.equal(g.installerKind,'package');
    assert.equal(g.url,url);
    const sources=sourcesFrom({hw:{ok:true},wu:{ok:true},gpu:result,bios:{ok:true,data:{supported:false}}});
    assert.equal(scanVerdict({sources,total:newer?1:0}).state,newer?'updates':'allGood');
  }
});
test('AMD retries a transient catalog failure once and recovers', async () => {
  const {result,calls}=await check((_u,calls)=>calls.length===1?new Response('busy',{status:503}):new Response(adapterHtml),'26.9.1');
  assert.equal(calls.length,2); assert.equal(result.data[0].status,'ok');
});
test('missing installed release can be confirmed from the official Driver Store version', async () => {
  const {result}=await check(u=>new Response(u.includes('release-notes')?'AMD Software: Adrenalin Edition 26.10.1 Windows Driver Store Version 32.0.32015.7029':adapterHtml),null);
  assert.equal(result.data[0].status,'ok'); assert.equal(result.data[0].newer,false);
});
test('ambiguous installed branches stay unknown, with the existing autodetect tool available', async () => {
  const {result}=await check(u=>new Response(u.includes('release-notes')?'AMD Software: Adrenalin Edition 26.10.1 Windows Driver Store Version 32.0.111.1; Windows Driver Store Version 32.0.222.2':u.endsWith('/download/drivers.html')?'<a href="https://drivers.amd.com/drivers/installer/26.20/adrenalin-edition-26.10.1-minimalsetup-261018.exe">tool</a>':adapterHtml),null);
  const g=result.data[0]; assert.equal(g.installerKind,'autodetect'); assert.equal(g.newer,false); assert.equal(g.latest,null); assert.ok(g.error);
});
