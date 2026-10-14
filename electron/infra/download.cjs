// Downloading a file over HTTPS, with progress and an optional SHA-256 check.
const crypto = require('crypto');
const fs = require('fs');

// Streams a download to disk with progress and an optional SHA-256 check; a failed or
// mismatched file is removed rather than left half-written.
async function downloadFile(url, file, { headers = {}, sha256, onProgress } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0;
    let shown = -1;
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((got * 100) / total) : null;
      if (onProgress && pct !== shown) { shown = pct; onProgress({ phase: 'download', percent: pct, bytes: got, total }); }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (sha256 && hash.digest('hex').toLowerCase() !== String(sha256).toLowerCase()) {
      fs.rmSync(file, { force: true });
      return { ok: false, error: 'checksum mismatch' };
    }
    return { ok: true, data: file };
  } catch (e) {
    fs.rmSync(file, { force: true });
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { downloadFile };
