// Graphics drivers from AMD and NVIDIA's own sites (Intel: a link only), with the signer checked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nvidiaPackageMatches } = require('../domain/catalog-policy.cjs');
const { amdProductPage, amdDriverFromPage, amdReleaseVersion } = require('../domain/amd-catalog.cjs');
const { cmpVer } = require('../domain/versions.cjs');
const { downloadFile } = require('../infra/download.cjs');
const { runPS } = require('../infra/powershell.cjs');
const { vendorFetch, boundedBody } = require('../infra/vendor-fetch.cjs');

// A maker's page or API: an HTTP error, a time-out or an empty answer is a failure, never "no update".
const MAKER_TIMEOUT_MS = 12000;
async function makerFetch(url, headers = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await vendorFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: AbortSignal.timeout(MAKER_TIMEOUT_MS) });
      if (!r.ok) {
        await r.body?.cancel?.();
        const error = new Error(`HTTP ${r.status}`);
        error.retryable = r.status === 408 || r.status === 429 || r.status >= 500;
        throw error;
      }
      const bytes = await boundedBody(r, 8 * 1024 * 1024);
      return { text: async () => bytes.toString('utf8'), json: async () => JSON.parse(bytes.toString('utf8')) };
    } catch (error) {
      // Retry transient network/HTTP failures once; trust-policy failures never gain another route.
      const transient = error.retryable ?? /fetch failed|network|timeout|timed out|abort|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(String(error.message));
      if (attempt || !transient) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

// Graphics drivers: Windows Update lags behind the GPU makers, so check their official sites too.
// Every GPU gets a status: 'ok' (the maker answered, newer or not), 'error' (the check failed, so
// whether there is a newer driver is unknown), 'unsupported' (Tune can't check this card).
async function gpuVendorCheck(gpus, amdSoftware) {
  const out = [];
  for (const g of gpus || []) {
    if (/AMD|Radeon/i.test(g.name)) {
      out.push(await amdCheck(g, amdSoftware));
    } else if (/NVIDIA|GeForce|RTX|GTX|Quadro/i.test(g.name)) {
      out.push(await nvidiaCheck(g));
    } else if (/Intel.*Arc/i.test(g.name)) {
      // intel.com only serves its download pages to browsers; Windows Update carries Intel's
      // releases, and the official page is one click away.
      out.push({ status: 'unsupported', gpu: g.name, vendor: 'Intel', installed: g.driverVersion, latest: null, url: null, newer: false,
        page: 'https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html' });
    }
  }
  return { ok: true, data: out };
}

async function amdCheck(g, amdSoftware) {
  const page = amdProductPage(g.name);
  const base = { gpu: g.name, vendor: 'AMD', installed: g.driverVersion, package: amdReleaseVersion(amdSoftware), latest: null, url: null, newer: false, page: page || 'https://www.amd.com/en/support/download/drivers.html' };
  try {
    if (process.arch !== 'x64') throw new Error('AMD catalog requires Windows x64');
    if (!page) throw new Error('This AMD model needs the official auto-detect tool');
    const windows11 = Number(os.release().split('.')[2]) >= 22000;
    const html = await (await makerFetch(page)).text();
    const driver = amdDriverFromPage(html, g.name, windows11);
    let newer;
    // The AMD release number and Windows' four-part driver number are different namespaces.
    // Only compare the installed Adrenalin release with the package release from AMD's page.
    if (base.package) newer = cmpVer(driver.version, base.package) > 0;
    else {
      if (!driver.notes || !/^\d+\.\d+\.\d+\.\d+$/.test(String(g.driverVersion || ''))) throw new Error('Installed AMD release could not be identified');
      const notes = await (await makerFetch(driver.notes)).text();
      if (!notes.includes(`Adrenalin Edition ${driver.version}`)) throw new Error('AMD release notes do not match the package');
      const versions = [...new Set([...notes.matchAll(/Windows Driver Store Version\s+(\d+\.\d+\.\d+\.\d+)/gi)].map(m => m[1]))];
      if (versions.includes(g.driverVersion)) newer = false;
      else if (versions.length === 1) newer = cmpVer(versions[0], g.driverVersion) > 0;
      else throw new Error('AMD lists multiple driver branches; installed release could not be matched');
    }
    return { ...base, status: 'ok', latest: driver.version, url: driver.url, title: `AMD Software ${driver.version}`, installerKind: 'package', newer };
  } catch (error) {
    // Keep the existing official auto-detect action for models or installed versions that
    // cannot be matched. It is explicitly a tool, never proof that the GPU is up to date.
    if (process.arch === 'x64') {
      try {
        const html = await (await makerFetch('https://www.amd.com/en/support/download/drivers.html')).text();
        const url = html.match(/https:\/\/drivers\.amd\.com\/drivers\/installer\/[^"'\s]+minimalsetup[^"'\s]+\.exe/)?.[0];
        if (url) return { ...base, status: 'ok', installerKind: 'autodetect', url, error: String(error.message || error) };
      } catch { /* retain the original failure and official product page */ }
    }
    return { ...base, status: 'error', error: String(error.message || error) };
  }
}

// NVIDIA's own driver finder: its product list gives the IDs for this card's exact name (listed
// either with or without "NVIDIA"), and the lookup returns the newest Game Ready (WHQL) driver.
let nvidiaProducts = null;

async function nvidiaCheck(g) {
  const base = { gpu: g.name, vendor: 'NVIDIA', installed: g.driverVersion, latest: null, url: null, newer: false, page: 'https://www.nvidia.com/en-us/drivers/' };
  try {
    const norm = (s) => String(s).replace(/^NVIDIA\s+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!nvidiaProducts) {
      const xml = await (await makerFetch('https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=3')).text();
      const list = [...xml.matchAll(/<LookupValue ParentID="(\d+)">\s*<Name>([^<]+)<\/Name>\s*<Value>(\d+)<\/Value>/g)].map((m) => ({ psid: m[1], name: m[2], pfid: m[3] }));
      // an empty list is a broken answer: not kept, so the next check asks again
      if (!list.length) throw new Error("NVIDIA's product list was empty");
      nvidiaProducts = list;
    }
    const p = nvidiaProducts.find((x) => norm(x.name) === norm(g.name));
    // a card NVIDIA's finder doesn't list can't be checked here (not a failure, nothing to retry)
    if (!p) return { ...base, status: 'unsupported' };
    const osId = Number(os.release().split('.')[2]) >= 22000 ? 135 : 57; // Windows 11 : Windows 10
    const j = await (await makerFetch(`https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=${p.psid}&pfid=${p.pfid}&osID=${osId}&languageCode=1033&isWHQL=1&dch=1&sort1=0&numberOfResults=1`)).json();
    const d = j?.IDS?.[0]?.downloadInfo;
    if (!d?.Version || !d.DownloadURL) throw new Error("no driver in NVIDIA's answer");
    if (!nvidiaPackageMatches(d, { gpu: g.name, windows11: osId === 135, arch: process.arch })) throw new Error("NVIDIA's package did not match the requested driver version, Windows or device type");
    // Windows shows NVIDIA drivers as 32.0.15.6636; NVIDIA calls that 566.36 (the last five digits).
    const digits = String(g.driverVersion || '').split('.').slice(-2).join('');
    const installed = digits.length >= 5 ? `${digits.slice(-5, -2)}.${digits.slice(-2)}` : null;
    return {
      ...base, status: 'ok', latest: d.Version, url: d.DownloadURL, size: d.DownloadURLFileSize, title: `${decodeURIComponent(d.Name)} ${d.Version}`,
      package: installed, newer: !installed || cmpVer(d.Version, installed) > 0,
    };
  } catch (e) {
    return { ...base, status: 'error', error: String(e.message || e) };
  }
}

// Official installers only, from the GPU maker's own download server, and only if Windows confirms
// the maker's valid signature on the file before it is opened. AMD only lets the file through with
// an amd.com Referer, the same header a browser sends when the link is clicked on their page.
const GPU_SOURCES = [
  { host: /^drivers\.amd\.com$/, signer: /Advanced Micro Devices/i, headers: { Referer: 'https://www.amd.com/' } },
  { host: /^([a-z]+\.)?download\.nvidia\.com$/, signer: /NVIDIA/i, headers: {} },
];

async function downloadGpuInstaller(url, dir, onProgress) {
  const u = new URL(url);
  const src = GPU_SOURCES.find((s) => s.host.test(u.hostname));
  if (u.protocol !== 'https:' || !src) return { ok: false, error: 'not an official GPU download' };
  const r = await downloadFile(url, path.join(dir, path.basename(u.pathname)), { headers: src.headers, onProgress });
  if (!r.ok) return r;
  const sig = await runPS(`$s = Get-AuthenticodeSignature -LiteralPath '${r.data.replace(/'/g, "''")}'; $result = @{ status = [string]$s.Status; signer = [string]$s.SignerCertificate.Subject }`);
  if (!sig.ok || sig.data.status !== 'Valid' || !src.signer.test(sig.data.signer)) {
    fs.rmSync(r.data, { force: true });
    return { ok: false, error: 'signature check failed' };
  }
  return r;
}

module.exports = { gpuVendorCheck, downloadGpuInstaller };
