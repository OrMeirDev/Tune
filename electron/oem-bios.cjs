// BIOS updates for brand-name PCs, from each maker's own update catalog (the same catalogs their
// update tools read). Every result carries the maker's SHA-256 for the file. These BIOS updates
// run from Windows with the maker's own tool, unlike motherboard BIOS files (flashed from the BIOS).
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vendorFetch, boundedBody } = require('./infra/vendor-fetch.cjs');

const UA = { 'User-Agent': 'Mozilla/5.0' };
// Catalog requests are bounded: a time limit, and a size ceiling for the downloaded catalogs.
const CATALOG_TIMEOUT_MS = 30000;
const CATALOG_MAX_BYTES = 200 * 1024 * 1024;

const cmpVer = (a, b) => {
  const x = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};

async function getText(url) {
  const r = await vendorFetch(url, { headers: UA, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await boundedBody(r, 16 * 1024 * 1024)).toString('utf8').replace(/^\ufeff/, '');
}

// Dell and HP publish their catalogs as .cab archives; Windows' own expand.exe opens them (without
// blocking the main process, and with a time limit).
async function getCab(url) {
  const r = await vendorFetch(url, { headers: UA, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS * 4) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (Number(r.headers.get('content-length')) > CATALOG_MAX_BYTES) throw new Error('catalog is too large');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-cab-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.cab'), await boundedBody(r, CATALOG_MAX_BYTES));
    fs.mkdirSync(path.join(dir, 'out'));
    await promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'expand.exe'), [path.join(dir, 'in.cab'), '-F:*', path.join(dir, 'out')], { windowsHide: true, timeout: 60000 });
    const [file] = fs.readdirSync(path.join(dir, 'out'));
    const buf = fs.readFileSync(path.join(dir, 'out', file));
    // Dell writes its catalogs in UTF-16 (byte order mark FF FE); HP in UTF-8.
    return (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\ufeff/, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tag = (xml, name) => (xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || null;

// Lenovo: catalog per machine type (first 4 characters of the model, e.g. 20XW), then a small
// descriptor per package. The installed BIOS shows its version in brackets: "N32ET86W (1.62 )".
async function lenovo(model, biosString) {
  const mtm = String(model || '').slice(0, 4).toUpperCase();
  const installed = (String(biosString).match(/\(\s*([\d.]+)\s*\)/) || [])[1] || biosString;
  const catalog = await getText(`https://download.lenovo.com/catalog/${mtm}_Win11.xml`).catch(() => getText(`https://download.lenovo.com/catalog/${mtm}_Win10.xml`));
  const pkg = [...catalog.matchAll(/<package>([\s\S]*?)<\/package>/g)].map((m) => m[1]).find((p) => /<category>BIOS/i.test(p));
  if (!pkg) return null;
  const descUrl = tag(pkg, 'location');
  const desc = await getText(descUrl);
  const version = (desc.match(/<Package [^>]*version="([^"]+)"/) || [])[1];
  const installer = (desc.match(/<Installer>[\s\S]*?<\/Installer>/) || [])[0] || '';
  const file = tag(installer, 'Name');
  if (!version || !file) return null;
  return {
    installed, newer: cmpVer(version, installed) > 0, site: 'lenovo.com', page: `https://pcsupport.lenovo.com/search?query=${encodeURIComponent(mtm)}`,
    latest: { version, date: tag(desc, 'ReleaseDate'), size: `${(Number(tag(installer, 'Size')) / 1e6).toFixed(1)} MB`, url: new URL(file, descUrl).href, sha256: tag(installer, 'CRC'), notes: tag(desc, 'Desc') },
  };
}

// Dell: an index of every system (by the SKU Windows reports, e.g. 07E8) pointing at its own catalog.
async function dell(sku, biosVersion) {
  const index = await getCab('https://downloads.dell.com/catalog/CatalogIndexPC.cab');
  const group = [...index.matchAll(/<GroupManifest[\s\S]*?<\/GroupManifest>/g)].map((m) => m[0])
    .find((g) => new RegExp(`systemID="${String(sku).replace(/[^0-9A-Za-z]/g, '')}"`, 'i').test(g));
  if (!group) return null;
  const manifest = (group.match(/<ManifestInformation[^>]*path="([^"]+)"/) || [])[1];
  const catalog = await getCab(`https://downloads.dell.com/${manifest}`);
  const bios = [...catalog.matchAll(/<SoftwareComponent[\s\S]*?<\/SoftwareComponent>/g)].map((m) => m[0])
    .filter((c) => /<ComponentType value="BIOS"/.test(c))
    .map((c) => ({ c, version: (c.match(/vendorVersion="([^"]+)"/) || [])[1] }))
    .sort((a, b) => cmpVer(b.version, a.version))[0];
  if (!bios) return null;
  const attr = (n) => (bios.c.match(new RegExp(`${n}="([^"]+)"`)) || [])[1];
  return {
    installed: biosVersion, newer: cmpVer(bios.version, biosVersion) > 0, site: 'dell.com', page: 'https://www.dell.com/support/home/en-us/product-support/servicetag/drivers',
    latest: {
      version: bios.version, date: attr('releaseDate'), size: `${(Number(attr('size')) / 1e6).toFixed(1)} MB`, url: `https://downloads.dell.com/${attr('path')}`,
      sha256: (bios.c.match(/<Hash algorithm="SHA256">([^<]+)<\/Hash>/) || [])[1], notes: tag(tag(bios.c, 'Description') || '', 'Display'),
    },
  };
}

// HP: a platform list (by the board ID Windows reports, e.g. 81C5), then one catalog per Windows
// release. The BIOS entry for this PC is the one whose BIOS family matches ("P61 Ver. 02.97").
async function hp(systemId, biosString) {
  const sid = String(systemId).replace(/[^0-9A-Za-z]/g, '').toLowerCase();
  const family = (String(biosString).match(/^([A-Z]\d{2})/i) || [])[1];
  const installed = (String(biosString).match(/(\d+\.\d+(?:\.\d+)?)/) || [])[1];
  const list = await getCab('https://hpia.hpcloud.hp.com/ref/platformList.cab');
  const platform = [...list.matchAll(/<Platform [\s\S]*?<\/Platform>/g)].map((m) => m[0]).find((p) => new RegExp(`<SystemID>${sid}</SystemID>`, 'i').test(p));
  if (!platform || !family) return null;
  const win11 = Number(os.release().split('.')[2]) >= 22000;
  const releases = [...platform.matchAll(/<OS [\s\S]*?<\/OS>/g)].map((m) => m[0])
    .filter((o) => /<IsWindows11>(\w+)</.exec(o)?.[1] === String(win11)).map((o) => tag(o, 'OSReleaseIdFilename')).filter(Boolean);
  const release = releases.sort().pop();
  if (!release) return null;
  const catalog = await getCab(`https://hpia.hpcloud.hp.com/ref/${sid}/${sid}_64_${win11 ? '11' : '10'}.0.${release.toLowerCase()}.cab`);
  const entry = [...catalog.matchAll(/<UpdateInfo[^>]*>(?:(?!<UpdateInfo)[\s\S])*?<\/UpdateInfo>/g)].map((m) => m[0])
    .find((u) => /<Category>BIOS/.test(u) && new RegExp(`<BiosFamily>${family}</BiosFamily>`, 'i').test(u));
  if (!entry) return null;
  const version = tag(entry, 'BiosVersion') || tag(entry, 'Version');
  return {
    installed, newer: cmpVer(version, installed) > 0, site: 'hp.com', page: 'https://support.hp.com/drivers',
    latest: { version, date: tag(entry, 'DateReleased'), size: `${(Number(tag(entry, 'Size')) / 1e6).toFixed(1)} MB`, url: `https://${tag(entry, 'Url').replace(/^\w+:\/\//, '')}`, sha256: tag(entry, 'SHA256'), notes: tag(entry, 'Description') },
  };
}

// Brand-name PCs are identified by the computer maker; anything else by the motherboard maker.
async function oemBios({ systemMaker = '', systemModel = '', systemSku = '', model = '', version = '' }) {
  let r = null;
  if (/lenovo/i.test(systemMaker)) r = await lenovo(systemModel, version);
  else if (/dell/i.test(systemMaker)) r = await dell(systemSku, version);
  else if (/^hp\b|hewlett/i.test(systemMaker)) r = await hp(model, version);
  else return null;
  if (!r) return null;
  // A catalog field is taken as the file's SHA-256 only if it looks like one: Lenovo calls the
  // field "CRC", and a value that isn't 64 hex characters means "no usable hash" (the download is
  // then refused), never a false match.
  if (r.latest) r.latest = { ...r.latest, sha256: sha256Or(r.latest.sha256) };
  return { ...r, maker: /lenovo/i.test(systemMaker) ? 'Lenovo' : /dell/i.test(systemMaker) ? 'Dell' : 'HP', model: systemModel };
}
const sha256Or = (v) => (/^[0-9a-f]{64}$/i.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : null);

// Makers whose sites only serve browsers: a search on their own site instead.
const SITES = [[/MSI|Micro-Star/i, 'msi.com'], [/Gigabyte/i, 'gigabyte.com'], [/ASRock/i, 'asrock.com'], [/Biostar/i, 'biostar.com.tw'], [/Acer/i, 'acer.com']];
function searchPage(maker, model) {
  const site = (SITES.find(([re]) => re.test(maker)) || [])[1];
  return `https://www.google.com/search?q=${encodeURIComponent(`${maker} ${model} BIOS${site ? ` site:${site}` : ''}`)}`;
}

// Where each maker's BIOS files may come from, and whose signature an .exe must carry.
const BIOS_SOURCES = [
  { host: /^dlcdnets\.asus\.com$/, signer: null },
  { host: /^download\.lenovo\.com$/, signer: /Lenovo/i },
  { host: /^(downloads|dl)\.dell\.com$/, signer: /Dell/i },
  { host: /^ftp(\.ext)?\.hp\.com$/, signer: /HP|Hewlett/i },
];

module.exports = { oemBios, searchPage, BIOS_SOURCES, sha256Or };
