const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('tune', {
  scanHardware: call('hw:scan'),
  driverUpdates: call('drv:updates'),
  gpuCheck: call('drv:gpu'),
  installDrivers: call('drv:install'),
  gpuInstaller: call('drv:gpuInstaller'),
  enableDevice: call('dev:enable'),
  biosCheck: call('bios:check'),
  biosDownload: call('bios:download'),
  exportHardware: call('hw:export'),
  openFolder: call('folder:open'),
  serviceStatus: call('service:status'),
  installService: call('service:install'),
  uninstallService: call('service:uninstall'),
  adminStatus: call('admin:status'),
  adminStart: call('admin:start'),
  adminStop: call('admin:stop'),
  getSettings: call('settings:get'),
  pickSaveDir: call('settings:pickDir'),
  setLanguage: call('settings:setLang'),
  onProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('task:progress', handler);
    return () => ipcRenderer.removeListener('task:progress', handler);
  },
  junkScan: call('junk:scan'),
  junkClean: call('junk:clean'),
  startupList: call('startup:list'),
  startupToggle: call('startup:toggle'),
  performance: call('perf:get'),
  recommendations: call('rec:list'),
  applyRecommendation: call('rec:apply'),
  createRestorePoint: call('restore:create'),
  openSystemRestore: call('restore:open'),
  getHistory: call('history:get'),
  openLink: call('link:open'),
  appVersion: call('app:version'),
  checkAppUpdate: call('update:check'),
  downloadAppUpdate: call('update:download'),
  installAppUpdate: call('update:install'),
  onAppUpdate: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
});
