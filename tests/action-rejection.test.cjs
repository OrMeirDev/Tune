// A rejected IPC call must release the UI, and a double click must not start a second change.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), Module = require('node:module'), esbuild = require('esbuild');
async function hook() {
  const out = await esbuild.build({ entryPoints: [path.join(__dirname, '..', 'src', 'app', 'useOperations.js')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'standins', setup(b) {
      b.onResolve({ filter: /^react$|api\.js$|format\.jsx$/ }, a => ({ path: a.path, namespace: 'test' }));
      b.onLoad({ filter: /.*/, namespace: 'test' }, a => ({ contents: a.path === 'react'
        ? "exports.useState = () => [null, v => globalThis.__actionStates.push(v)]; exports.useRef = v => ({current:v}); exports.useEffect = () => {};"
        : a.path.endsWith('api.js') ? "exports.api = {adminStatus: async () => 0};" : "exports.errText = e => e;", loader: 'js' }));
    } }] });
  const m = new Module('action-hook'); m._compile(out.outputFiles[0].text, __filename); return m.exports.useOperations;
}
test('a rejected action clears busy/progress and reports an unconfirmed outcome', async () => {
  globalThis.__actionStates = []; const msgs = [], useOperations = await hook();
  const { act } = useOperations({ t: k => k, setMsg: v => msgs.push(v), setAdminUntil() {} });
  const r = await act('row', async () => { throw new Error('lost IPC reply'); });
  assert.equal(r.code, 'noAnswer'); assert.ok(globalThis.__actionStates.includes(null));
  assert.equal(msgs.at(-1).text, 'err.noAnswer'); delete globalThis.__actionStates;
});
test('two clicks during one action start it only once', async () => {
  globalThis.__actionStates = []; const useOperations = await hook();
  const { act } = useOperations({ t: k => k, setMsg() {}, setAdminUntil() {} });
  let release, calls = 0; const pending = new Promise(r => { release = r; });
  const one = act('one', async () => { calls++; return pending; });
  const two = await act('two', async () => { calls++; return { ok: true }; });
  assert.equal(two.error, 'busy'); assert.equal(calls, 1); release({ ok: true }); await one;
  delete globalThis.__actionStates;
});
