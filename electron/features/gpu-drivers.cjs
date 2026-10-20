// Graphics drivers from AMD and NVIDIA's own sites (Intel: a link only), with the signer checked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cmpVer } = require('../domain/versions.cjs');
const { downloadFile } = require('../infra/download.cjs');
const { runPS } = require('../infra/powershell.cjs');
const { vendorFetch, boundedBody } = require('../infra/vendor-fetch.cjs');

// A maker's page or API: an HTTP error, a time-out or an empty answer is a failure, never "no update".
const MAKER_TIMEOUT_MS = 20000;
async function makerFetch(url, headers = {}) {
  const r = await vendorFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: AbortSignal.timeout(MAKER_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bytes = await boundedBody(r, 8 * 1024 * 1024);
  return { text: async () => bytes.toString('utf8'), json: async () => JSON.parse(bytes.toString('utf8')) };
}

// Graphics drivers: Windows Update lags behind the GPU makers, so check their official sites too.
// Every GPU gets a status: 'ok' (the maker answered, newer or not), 'error' (the check failed, so
// whether there is a newer driver is unknown), 'unsupported' (Tune can't check this card).
async function gpuVendorCheck(gpus, amdSoftware) {
  const out = [];
  for (const g of gpus || []) {
    if (/AMD|Radeon/i.test(g.name)) {
      try {
        const html = await (await makerFetch('https://www.amd.com/en/support/download/drivers.html')).text();
        const url = (html.match(/https:\/\/drivers\.amd\.com\/drivers\/installer\/[^"'\s]+minimalsetup[^"'\s]+\.exe/) || [])[0];
        const ver = url && (url.match(/adrenalin-edition-([\d.]+)-/) || [])[1];
        // the page answered but without a driver link: changed or blocked, so the result is unknown
        if (!ver) throw new Error("no driver link on AMD's page");
        out.push({
          status: 'ok', gpu: g.name, vendor: 'AMD', installed: g.driverVersion, package: amdSoftware || null, latest: ver || null, url: url || null,
          title: ver ? `AMD Software ${ver}` : null,
          // Unknown package version: offer it rather than hide a possible update.
          newer: !!ver && (!amdSoftware || cmpVer(ver, amdSoftware) > 0),
          page: 'https://www.amd.com/en/support/download/drivers.html',
        });
      } catch (e) {
        out.push({ status: 'error', gpu: g.name, vendor: 'AMD', installed: g.driverVersion, error: String(e.message || e), page: 'https://www.amd.com/en/support/download/drivers.html' });
      }
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
