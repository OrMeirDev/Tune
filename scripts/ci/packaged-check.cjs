// Checks a packaged build (release/win-unpacked, made by `npm run dist`) on a disposable Windows CI
// runner. Exits non-zero on any failure.
// 1) What is packed: the app's own code and page, never the licensing server PoC, tests or docs.
// 2) The packaged app ignores every development licensing override: started with TUNE_LICENSING_URL,
//    a public key, an enforcing policy and the test-only storage and machine id set, its window still
//    sees licensing as not open, storage as DPAPI, and gated actions as allowed (the shipped open
//    policy). Read from the real window through the DevTools protocol; the app is then ended.
// Nothing here changes the PC: the probe asks only for the licence status and sends one request
// the IPC layer refuses as malformed.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..', '..');
const unpacked = path.join(root, 'release', 'win-unpacked');
const failures = [];
const check = (name, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got).slice(0, 400)})` : ''}`);
  if (!cond) failures.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function packedFiles() {
  const archive = path.join(unpacked, 'resources', 'app.asar');
  const files = asar.listPackage(archive).map((f) => f.replace(/\\/g, '/'));
  for (const must of ['/electron/main.cjs', '/electron/preload.cjs', '/electron/licensing/config.cjs', '/electron/licensing/client.cjs', '/dist/index.html', '/package.json']) {
    check(`packed: ${must}`, files.includes(must));
  }
  const banned = files.filter((f) => /^\/(licensing|tests|e2e|docs|scripts|service)(\/|$)/.test(f));
  check('not packed: the licensing server PoC, tests, e2e, docs, scripts, service sources', banned.length === 0, banned.slice(0, 10));
  const service = path.join(unpacked, 'resources', 'service');
  for (const f of ['TuneService.exe', 'ops.ps1', 'LibreHardwareMonitorLib.dll']) check(`service bundle: ${f}`, fs.existsSync(path.join(service, f)));
  // the hashes the elevated installer checks the service files against travel inside the app
  check('packed: the service manifest', files.includes('/electron/privilege/service-manifest.json'));
  const manifest = JSON.parse(asar.extractFile(archive, 'electron/privilege/service-manifest.json').toString('utf8'));
  const shipped = fs.readdirSync(service).filter((n) => /\.(exe|dll|ps1|txt)$/i.test(n)).sort();
  const wrong = shipped.filter((n) => manifest.files[n] !== crypto.createHash('sha256').update(fs.readFileSync(path.join(service, n))).digest('hex').toUpperCase());
  check('the manifest names every shipped service file with its SHA-256', JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify(shipped) && wrong.length === 0, { shipped: shipped.length, wrong });
}

// One DevTools session to the app's page: evaluate an expression (awaiting a promise) by value.
async function devtools(port) {
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch { /* not up yet */ }
    if (!page) await wait(500);
  }
  if (!page) throw new Error('the app window did not appear');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('devtools connection failed')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const evaluate = (expression) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, (msg) => resolve(msg.result && msg.result.result ? msg.result.result.value : { error: JSON.stringify(msg.error || msg.result) }));
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

async function packagedIgnoresOverrides() {
  const exe = path.join(unpacked, 'Tune.exe');
  const port = await freePort();
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const env = {
    ...process.env,
    TUNE_LICENSING_URL: 'http://127.0.0.1:9',
    TUNE_LICENSING_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    TUNE_LICENSING_POLICY: 'enforce',
    TUNE_TEST_PROTECTED_STORAGE: 'insecure-test-only',
    TUNE_TEST_MACHINE_ID: crypto.createHash('sha256').update('ci').digest('hex'),
  };
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  try {
    const dt = await devtools(port);
    let status = null;
    for (let i = 0; i < 60; i++) {
      status = await dt.evaluate('window.tune && window.tune.licenseStatus ? window.tune.licenseStatus() : null');
      if (status && status.ok) break;
      await wait(500);
    }
    const d = status && status.data;
    check('packaged: licensing is not open although TUNE_LICENSING_URL is set', d && d.available === false && !d.development, d);
    check('packaged: storage is DPAPI, never the test-only storage', d && d.storage === 'dpapi', d && d.storage);
    check('packaged: no licence; licensing reported as not configured (not misconfigured)', d && d.license && d.license.state === 'none' && d.problem === 'notConfigured', d && { problem: d.problem, state: d.license && d.license.state });
    const gate = await dt.evaluate("window.tune.junkClean(['not-a-category'])");
    check('packaged: the shipped open policy gates nothing (an enforcing override is ignored)', gate && gate.error !== 'not entitled', gate);
    dt.close();
  } finally {
    // the app and everything it started (it keeps no state worth a clean exit on a throwaway runner)
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await wait(1500);
  }
}

(async () => {
  if (process.platform !== 'win32') throw new Error('this check runs on Windows');
  packedFiles();
  await packagedIgnoresOverrides();
  console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`FAIL unexpected error: ${e.stack || e}`); console.log('1 FAILED (stopped before the end)'); process.exit(1); });
