// Launched only by dpapi-users-check.ps1, in an isolated profile with a synthetic licence.
if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('DPAPI user probe runs only on a disposable CI runner');
const { app, safeStorage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createProtectedStore, electronCrypt } = require('../../electron/licensing/protected-store.cjs');
const [mode, file] = process.argv.slice(2);
if (!['owner', 'other'].includes(mode) || !/^C:\\Users\\Public\\TuneDpapi-[a-f0-9]{32}\\license\.bin$/i.test(file || '')) throw new Error('refuse any real licence or profile');
app.setPath('userData', path.join(path.dirname(file), mode + '-profile'));
app.whenReady().then(() => {
  const store = createProtectedStore({ file, crypt: electronCrypt(safeStorage) });
  if (mode === 'owner') {
    const saved = store.write({ marker: 'TUNE_DPAPI_SYNTHETIC', privateKey: 'synthetic-not-a-key' });
    const bytes = fs.readFileSync(file);
    const ok = saved.ok && store.read().data?.marker === 'TUNE_DPAPI_SYNTHETIC' && !bytes.includes(Buffer.from('synthetic-not-a-key'));
    console.log(JSON.stringify({ ok: !!ok, storage: store.kind() })); app.exit(ok ? 0 : 1);
  } else {
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const r = store.read();
    const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const ok = !r.ok && r.reason === 'unreadable' && before === after;
    console.log(JSON.stringify({ ok, reason: r.reason, unchanged: before === after, storage: store.kind() })); app.exit(ok ? 0 : 1);
  }
}).catch(e => { console.error(e.message); app.exit(1); });
