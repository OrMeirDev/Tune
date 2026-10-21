// Explicit per-maker trust groups. A redirect never expands trust to another maker or a host suffix.
const HOSTS = [
  ['drivers.amd.com', 'www.amd.com'],
  ['www.nvidia.com', 'gfwsl.geforce.com', 'download.nvidia.com', 'us.download.nvidia.com', 'international.download.nvidia.com'],
  ['www.asus.com', 'dlcdnets.asus.com'],
  ['download.lenovo.com'],
  ['downloads.dell.com', 'dl.dell.com'],
  ['hpia.hpcloud.hp.com', 'ftp.hp.com', 'ftp.ext.hp.com'],
];
function allowedAddress(value, hosts) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && hosts.includes(u.hostname);
  } catch { return false; }
}
function downloadHosts(url) { return HOSTS.find(hosts => allowedAddress(url, hosts)) || []; }
module.exports = { allowedAddress, downloadHosts };
