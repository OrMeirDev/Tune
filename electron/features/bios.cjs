// BIOS updates from the board or PC maker's official catalog.
const fs = require('fs');
const path = require('path');
const { cmpVer } = require('../domain/versions.cjs');
const { downloadFile } = require('../infra/download.cjs');
const { runPS } = require('../infra/powershell.cjs');
const { vendorFetch, boundedBody } = require('../infra/vendor-fetch.cjs');
const { BIOS_SOURCES, oemBios, searchPage, sha256Or } = require('../oem-bios.cjs');

// ASUS's support site lists every BIOS for a board through the same JSON its own pages load,
// with a SHA-256 for each file. Other makers: a search for their official page.
async function biosCheck(board) {
  const { maker = '', model = '', version = '', date = '' } = board || {};
  const base = { maker, model, installed: version, installedDate: date, supported: false, page: searchPage(maker, model) };
  if (!/ASUS/i.test(maker)) {
    // Brand-name PCs (Lenovo, Dell, HP): the maker's update catalog; others: a search on their site.
    try {
      const oem = await oemBios(board);
      return { ok: true, data: oem ? { ...base, ...oem, installedDate: date, supported: !!oem.latest?.url, flash: 'windows' } : base };
    } catch (e) {
      return { ok: true, data: { ...base, error: String(e.message || e) } };
    }
  }
  if (!model) return { ok: true, data: base };
  try {
    const files = await asusBiosFiles(model);
    if (!files.length) return { ok: true, data: base };
    const newest = (list) => list.reduce((a, b) => (cmpVer(b.Version, a.Version) > 0 ? b : a));
    // Only stable releases are offered; a beta is mentioned, never recommended.
    const stable = files.filter((f) => String(f.IsRelease) !== '0');
    const f = stable.length ? newest(stable) : null;
    const beta = newest(files);
    const info = (x) => ({
      version: x.Version, date: String(x.ReleaseDate || '').replace(/\//g, '-'), size: x.FileSize, sha256: x.sha256,
      url: /^https?:/i.test(x.DownloadUrl?.Global || '') ? x.DownloadUrl.Global : x.DownloadUrl?.Global ? ASUS_DOWNLOADS + x.DownloadUrl.Global : null,
      notes: String(x.Description || '').replace(/^"|"$/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim(),
    });
    return {
      ok: true,
      data: {
        ...base, supported: !!f, maker: 'ASUS', site: 'asus.com', flash: 'ezflash',
        newer: !!f && cmpVer(f.Version, version) > 0,
        // Installed a beta that is newer than the latest stable release: up to date, and said so.
        onBeta: !!f && cmpVer(version, f.Version) > 0,
        beta: String(beta.IsRelease) === '0' && (!f || cmpVer(beta.Version, f.Version) > 0) && cmpVer(beta.Version, version) > 0 ? info(beta) : null,
        page: `https://www.asus.com/supportonly/${encodeURIComponent(model)}/helpdesk_bios/`,
        latest: f ? info(f) : null,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ASUS's BIOS list, from the service its support pages use since 2026 (webapi/ProductV2); the
// older product.asmx endpoint answers "FAIL" now but is kept as a fallback. Download links come
// back as paths on ASUS's download server.
const ASUS_DOWNLOADS = 'https://dlcdnets.asus.com';

async function asusBiosFiles(model) {
  const urls = [
    `https://www.asus.com/support/webapi/ProductV2/GetPDBIOS?website=global&model=${encodeURIComponent(model).replace(/%20/g, '+')}&pdhashedid=&pdid=99999&cpu=&siteID=www&sitelang=`,
    `https://www.asus.com/support/api/product.asmx/GetPDBIOS?website=global&model=${encodeURIComponent(model)}`,
  ];
  // An empty list is only "this board has no BIOS files" when ASUS actually answered; when neither
  // address gives a valid answer (network, HTTP error, bad JSON, "FAIL"), the check failed.
  let answered = false;
  const failures = [];
  for (const url of urls) {
    try {
      const r = await vendorFetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = JSON.parse((await boundedBody(r, 8 * 1024 * 1024)).toString('utf8'));
      if (!j || String(j.Status).toUpperCase() === 'FAIL' || j.Result == null) throw new Error(`ASUS answered ${j?.Status || 'nothing'}`);
      // the answer counts only if it has the expected shape: a list of groups, and the BIOS group's
      // files (if there is one) a list too; anything else is a broken answer, not "no BIOS files"
      const groups = j.Result.Obj;
      if (!Array.isArray(groups)) throw new Error('ASUS answer has an unexpected shape');
      const group = groups.find((o) => o && o.Name === 'BIOS');
      if (group && !Array.isArray(group.Files)) throw new Error('ASUS answer has an unexpected shape');
      answered = true;
      const files = group ? group.Files : [];
      if (files.length) return files;
    } catch (e) { failures.push(String(e.message || e)); /* try the next one */ }
  }
  if (!answered) throw new Error(`ASUS BIOS list unavailable (${failures.join('; ')})`);
  return [];
}

// Only the maker's own download server, only a file whose SHA-256 matches what the maker published,
// and for an .exe also the maker's valid digital signature.
async function downloadBios(latest, dir, onProgress) {
  const u = new URL(latest.url);
  const src = BIOS_SOURCES.find((s) => s.host.test(u.hostname));
  if (u.protocol !== 'https:' || !src || !sha256Or(latest.sha256)) return { ok: false, error: 'not an official BIOS download' };
  const r = await downloadFile(u.href, path.join(dir, path.basename(u.pathname)), { sha256: latest.sha256, onProgress });
  if (!r.ok || !src.signer) return r;
  const sig = await runPS(`$s = Get-AuthenticodeSignature -LiteralPath '${r.data.replace(/'/g, "''")}'; $result = @{ status = [string]$s.Status; signer = [string]$s.SignerCertificate.Subject }`);
  if (!sig.ok || sig.data.status !== 'Valid' || !src.signer.test(sig.data.signer)) {
    fs.rmSync(r.data, { force: true });
    return { ok: false, error: 'signature check failed' };
  }
  return r;
}

module.exports = { biosCheck, downloadBios };
