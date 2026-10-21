// Downloading a file over HTTPS, with progress and an optional SHA-256 check.
// Bounded: an overall deadline, a stall limit (no data for a while), a size ceiling, and no
// redirect to plain http. The file is written under a temporary name and gets its real name only
// once it is complete and verified, so a failed, stopped or mismatched download never leaves a
// half-written file behind. Disk errors (full disk, no access) come back as an error, not a crash.
const crypto = require('crypto');
const fs = require('fs');
const { vendorFetch } = require('./vendor-fetch.cjs');

const LIMITS = { deadlineMs: 60 * 60 * 1000, stallMs: 90 * 1000, maxBytes: 4 * 1024 ** 3 };

async function downloadFile(url, file, { headers = {}, sha256, onProgress, limits = {} } = {}) {
  const { deadlineMs, stallMs, maxBytes } = { ...LIMITS, ...limits };
  const part = `${file}.part`;
  const abort = new AbortController();
  let why = null;
  const stop = (reason) => { if (!why) why = reason; abort.abort(); };
  const deadline = setTimeout(() => stop('download took too long'), deadlineMs);
  let stall = setTimeout(() => stop('download stalled'), stallMs);
  let out = null;
  try {
    const res = await vendorFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: abort.signal });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    // the address the download finally came from, after redirects
    if (new URL(res.url || url).protocol !== 'https:') return { ok: false, error: 'redirected to an insecure address' };
    const total = Number(res.headers.get('content-length')) || 0;
    if (total > maxBytes) return { ok: false, error: 'file is too large' };
    const hash = crypto.createHash('sha256');
    out = fs.createWriteStream(part);
    let diskError = null;
    out.on('error', (e) => { diskError = e; stop(`could not save the file: ${e.message}`); });
    let got = 0;
    let shown = -1;
    for await (const chunk of res.body) {
      clearTimeout(stall);
      stall = setTimeout(() => stop('download stalled'), stallMs);
      got += chunk.length;
      if (got > maxBytes) { stop('file is too large'); break; }
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => { out.once('drain', r); out.once('error', r); });
      if (diskError) break;
      const pct = total ? Math.floor((got * 100) / total) : null;
      if (onProgress && pct !== shown) { shown = pct; onProgress({ phase: 'download', percent: pct, bytes: got, total }); }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (why || diskError) throw new Error(why || String(diskError));
    if (total && got !== total) throw new Error('download was cut short');
    if (sha256 && hash.digest('hex').toLowerCase() !== String(sha256).toLowerCase()) {
      fs.rmSync(part, { force: true });
      return { ok: false, error: 'checksum mismatch' };
    }
    fs.renameSync(part, file);
    return { ok: true, data: file };
  } catch (e) {
    out?.destroy();
    fs.rmSync(part, { force: true });
    return { ok: false, error: why || String(e.message || e) };
  } finally {
    clearTimeout(deadline);
    clearTimeout(stall);
  }
}

module.exports = { downloadFile, LIMITS };
