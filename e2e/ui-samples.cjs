// Synthetic PC only. No personal profile, hardware lookup or privileged operation is used.
const hardware = {
  computer: 'SAMPLE PC', systemMaker: 'ASUS', systemModel: 'SAMPLE desktop', systemSku: null,
  board: 'ASUS PRIME Z790-P WIFI', boardMaker: 'ASUS', boardModel: 'PRIME Z790-P WIFI',
  bios: { version: '1836', date: '2025-01-01' }, cpu: 'Intel Core i7-14700K', ramGB: 32,
  gpus: [{ name: 'NVIDIA GeForce RTX 4070', driverVersion: '32.0.15.6094', pnp: 'PCI\\VEN_10DE&DEV_2786' }],
  devices: [
    { id: 'gpu', name: 'NVIDIA GeForce RTX 4070', cls: 'Display', provider: 'NVIDIA', version: '32.0.15.6094', date: '2025-01-01', hwid: 'PCI\\VEN_10DE&DEV_2786' },
    { id: 'wifi', name: 'Intel Wi-Fi 6E AX211', cls: 'Net', provider: 'Intel', version: '23.40.0.4', date: '2025-02-01', hwid: 'PCI\\VEN_8086&DEV_51F0' },
    { id: 'audio', name: 'Realtek USB Audio', cls: 'MEDIA', provider: 'Realtek', version: '6.3.9600.2396', date: '2025-03-01', hwid: 'USB\\VID_0BDA&PID_4080' },
  ], problems: [{ id: 'SAMPLE-disabled', name: 'SAMPLE Bluetooth adapter', code: 22 }],
};
const updates = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Intel - Net - 23.50.0.6', maker: 'Intel', model: 'Intel Wi-Fi 6E AX211', cls: 'Net', hwid: 'PCI\\VEN_8086&DEV_51F0', size: 48e6, date: '2026-09-01' },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Realtek - MEDIA - 6.3.9600.2400', maker: 'Realtek', model: 'Realtek USB Audio', cls: 'MEDIA', hwid: 'USB\\VID_0BDA&PID_4080', size: 18e6, date: '2026-09-02' },
];
const bios = { supported: true, newer: true, maker: 'ASUS', model: 'PRIME Z790-P WIFI', site: 'asus.com',
  installed: '1836', installedDate: '2025-01-01', flash: 'bios', page: 'https://www.asus.com/support/',
  latest: { version: '1901', date: '2026-10-01', size: '15 MB', url: 'https://dlcdnets.asus.com/SAMPLE.zip', notes: 'SAMPLE release notes. Improve system stability and compatibility.' } };
const junk = [
  { key: 'userTemp', bytes: 1.6e9, files: 620, minAgeHours: 24, dirs: ['C:\\SAMPLE\\Temp'] },
  { key: 'browser', bytes: 820e6, files: 281, dirs: ['C:\\SAMPLE\\Chrome\\Cache', 'C:\\SAMPLE\\Edge\\Cache'] },
  { key: 'thumbs', bytes: 25e6, files: 16, dirs: ['C:\\SAMPLE\\Thumbnails'] },
];
const startup = ['Microsoft Teams', 'Spotify', 'OneDrive', 'Discord', 'Steam', 'SAMPLE utility'].map((name, i) => ({
  name, key: `SAMPLE-${i}`, source: 'HKCU', enabled: i < 4, admin: false,
  cmd: `"C:\\SAMPLE\\Programs\\${name}\\application.exe" --start-minimized --sample`,
}));
const recommendations = [
  { key: 'power', group: 'cpu', ok: false, action: true, plan: 'high', value: 'High performance', cpuKind: 'intelHybrid' },
  { key: 'powerLimit', group: 'cpu', ok: null, guide: 'powerLimit', cpuKind: 'intelHybrid' },
  { key: 'bios', group: 'board', ok: false, version: '1836', date: '2025-01-01', intel1314: true },
  { key: 'microcode', group: 'cpu', ok: true, hex: '0x12F' },
  { key: 'memChannels', group: 'memory', ok: false, channels: 1, sticks: 2, guide: 'channels', boardMaker: 'ASUS', boardModel: 'PRIME Z790-P WIFI' },
  { key: 'memSpeed', group: 'memory', ok: false, configured: 4800, rated: 6000, profile: 'XMP', guide: 'xmp' },
  { key: 'disk', group: 'storage', ok: true, freeGB: 310, sizeGB: 1000 },
  { key: 'trim', group: 'storage', ok: true, on: true },
  { key: 'gamemode', group: 'windows', ok: true, on: true, action: true },
  { key: 'hags', group: 'gpu', ok: false, on: false, action: true },
];
const performance = {
  cpuLoad: 8, cpuTempC: 48, cpuPowerW: 52, cpuClockMHz: 5100, cpuVoltageV: 1.18,
  ramTotalGB: 32, ramFreeGB: 21.8,
  gpuTemps: [{ name: 'NVIDIA GeForce RTX 4070', tempC: 44, hotspotC: 55, fanRpm: 900 }],
  topCpu: [{ name: 'SAMPLE browser', cpu: 3, count: 4 }, { name: 'SAMPLE editor', cpu: 2, count: 2 }],
  topRam: [{ name: 'SAMPLE browser', ramMB: 2600, count: 4 }, { name: 'SAMPLE editor', ramMB: 1100, count: 2 }],
};
const live = () => ({ ...performance, cpuNote: null, freshness: 'fresh', sampledAt: new Date().toISOString(),
  ramUsedBytes: 10.2e9, ramTotalBytes: 32e9, powerLimits: { pl1W: 125, pl1On: true, pl2W: 200, pl2On: true } });
const gpu = [{ status: 'ok', gpu: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', newer: true,
  installed: '560.94', latest: '561.09', title: 'GeForce Game Ready Driver 561.09', size: '650 MB',
  url: 'https://us.download.nvidia.com/SAMPLE.exe', page: 'https://www.nvidia.com/drivers/' }];

module.exports = { hardware, updates, bios, junk, startup, recommendations, performance, live, gpu };
