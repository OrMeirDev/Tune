// What licensing keeps on this PC: this install's device private key, the signed certificate, the
// last successful check with the server, and the last time Tune saw the clock. All of it is one
// file, encrypted for this Windows user with DPAPI (Electron's safeStorage uses DPAPI on Windows).
//
// There is no plaintext fallback. When protected storage isn't available nothing is written and the
// caller is told ('unavailable'); a key or a licence is then simply not kept. A file that can't be
// decrypted (another Windows user, another PC, damage) is left where it is: a licensing problem
// never deletes anything, and the next successful activation replaces it.
//
// `crypt` is injected: { kind, available(), encrypt(string) -> Buffer, decrypt(Buffer) -> string }.
// electronCrypt() wraps safeStorage for the app; tests pass stand-ins.
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = Buffer.from('TUNE-LICENSE/1\n');

function createProtectedStore({ file, crypt }) {
  const usable = () => {
    try { return !!crypt && crypt.available(); } catch { return false; }
  };

  // -> { ok: true, data } | { ok: false, reason: 'none' | 'unavailable' | 'unreadable' }
  function read() {
    let buf;
    try { buf = fs.readFileSync(file); } catch (err) { return { ok: false, reason: err.code === 'ENOENT' ? 'none' : 'unreadable' }; }
    if (!usable()) return { ok: false, reason: 'unavailable' };
    if (buf.length <= MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return { ok: false, reason: 'unreadable' };
    try {
      const data = JSON.parse(crypt.decrypt(buf.subarray(MAGIC.length)));
      return data && typeof data === 'object' && !Array.isArray(data) ? { ok: true, data } : { ok: false, reason: 'unreadable' };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }

  // -> { ok: true } | { ok: false, reason: 'unavailable' | 'failed' }. Written next to the file and
  // renamed over it, so a crash never leaves half a file.
  function write(data) {
    if (!usable()) return { ok: false, reason: 'unavailable' };
    try {
      const sealed = crypt.encrypt(JSON.stringify(data));
      if (!Buffer.isBuffer(sealed) || !sealed.length) return { ok: false, reason: 'failed' };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([MAGIC, sealed]));
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }

  // A file that can't be read is kept under another name (never deleted) before a new one is
  // written in its place.
  function setAside() {
    try { fs.renameSync(file, `${file}.unreadable`); return true; } catch { return false; }
  }

  return { read, write, setAside, kind: () => (usable() ? crypt.kind : 'unavailable') };
}

// The app's protection: Electron's safeStorage. On Windows it is DPAPI for the logged-on user. On
// other systems it counts only when it uses the system keyring; Chromium's 'basic_text' backend is
// not encryption, so it is refused rather than used.
function electronCrypt(safeStorage, platform = process.platform) {
  return {
    kind: platform === 'win32' ? 'dpapi' : 'os-keyring',
    available: () => {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (platform === 'win32') return true;
      const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'unknown';
      return !['basic_text', 'unknown'].includes(backend);
    },
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
}

// For automated tests of the unpackaged app off Windows only (config.testStorage): NOT protection.
// It never runs in a packaged build, and the app labels it as test storage wherever it is used.
function insecureTestCrypt() {
  const flip = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
  return { kind: 'test', available: () => true, encrypt: (s) => flip(Buffer.from(s, 'utf8')), decrypt: (b) => flip(b).toString('utf8') };
}

module.exports = { createProtectedStore, electronCrypt, insecureTestCrypt, MAGIC };
