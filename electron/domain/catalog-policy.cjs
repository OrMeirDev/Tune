// Catalog evidence is specific to a device/firmware family. An unrecognised version or identity
// is not evidence that a package applies or that an installed version is old.
function compareFirmware(a, b) {
  const parse = v => {
    const s = String(v || '').trim();
    if (/^A\d+$/i.test(s)) return { kind: 'dell', nums: [Number(s.slice(1))] };
    if (/^\d+(?:\.\d+)*$/.test(s)) return { kind: 'numeric', nums: s.split('.').map(Number) };
    return null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y || x.kind !== y.kind) return null;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const diff = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}
const dellId = v => /^[a-f0-9]{4,8}$/i.test(String(v || '').trim()) ? String(v).trim().toUpperCase() : null;
function supportsDell(xml, sku) {
  const id = dellId(sku);
  const supported = String(xml || '').match(/<SupportedSystems\b[^>]*>([\s\S]*?)<\/SupportedSystems>/i)?.[1] || '';
  return !!id && [...supported.matchAll(/\bsystemID=["']([^"']+)["']/gi)].some(m => m[1].toUpperCase() === id);
}
function lenovoFamily(version) {
  const s = String(version || '').trim().toUpperCase();
  return s.match(/^([A-Z0-9]{3})(?:ET|HT)\d{2}/)?.[1] || s.match(/^([A-Z0-9]{2,4}CN)\d{2}/)?.[1] || null;
}
function lenovoInstallerMatches(version, file) {
  const family = lenovoFamily(version);
  return !!family && typeof file === 'string' &&
    new RegExp('^' + family + '(?:UJ|CN|[0-9])', 'i').test(file) &&
    /^[a-z0-9._-]+\.exe$/i.test(file);
}
function asusFileMatches(model, version, url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'dlcdnets.asus.com' || u.username || u.password || u.port && u.port !== '443') return false;
    const file = decodeURIComponent(u.pathname.split('/').pop());
    const m = file.match(/^(.+)-ASUS-(\d+)\.zip$/i);
    const norm = s => String(s || '').toUpperCase().replace(/[\s_-]/g, '');
    return !!m && norm(m[1]) === norm(model) && m[2] === String(version);
  } catch { return false; }
}
function nvidiaPackageMatches(d, { gpu, windows11, arch = 'x64' }) {
  if (arch !== 'x64' || !/^\d{3}\.\d{2}$/.test(String(d?.Version || ''))) return false;
  try {
    const u = new URL(d.DownloadURL);
    const hosts = ['download.nvidia.com', 'us.download.nvidia.com', 'international.download.nvidia.com'];
    if (u.protocol !== 'https:' || !hosts.includes(u.hostname) || u.username || u.password || u.port && u.port !== '443') return false;
    const file = decodeURIComponent(u.pathname.split('/').pop()).toLowerCase();
    if (!file.startsWith(d.Version + '-') || !file.endsWith('.exe') || !file.includes('64bit') || !file.includes(windows11 ? 'win11' : 'win10')) return false;
    if (/laptop|notebook/i.test(gpu) && /-desktop-/.test(file)) return false;
    if (!/laptop|notebook/i.test(gpu) && /-notebook-/.test(file)) return false;
    return true;
  } catch { return false; }
}
module.exports = { compareFirmware, dellId, supportsDell, lenovoFamily, lenovoInstallerMatches, asusFileMatches, nvidiaPackageMatches };
