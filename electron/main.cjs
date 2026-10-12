const { app, BrowserWindow, ipcMain, shell, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const sys = require('./system.cjs');
const { hardwareReport } = require('./report.cjs');

// ---------- history of everything Tune changed ----------

const historyFile = () => path.join(app.getPath('userData'), 'history.json');
const readHistory = () => { try { return JSON.parse(fs.readFileSync(historyFile(), 'utf8')); } catch { return []; } };
function addHistory(action, detail) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify([{ action, detail, at: new Date().toISOString() }, ...readHistory()].slice(0, 500), null, 2));
}

// ---------- settings (the save folder is chosen only here) ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function getSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* first run */ }
  // English unless the user picked Hebrew in Settings.
  return { saveDir: s.saveDir && fs.existsSync(s.saveDir) ? s.saveDir : app.getPath('downloads'), lang: s.lang === 'he' ? 'he' : 'en' };
}
function saveSettings(s) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

// ---------- app updates (same flow as Grab and Morph: GitHub releases, silent install + relaunch) ----------

let mainWindow = null;
const sendUpdate = (status) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status);
};
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('update-available', (info) => sendUpdate({ state: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => sendUpdate({ state: 'ready', version: info.version }));
autoUpdater.on('error', (e) => sendUpdate({ state: 'error', message: String(e?.message || e).slice(0, 200) }));

ipcMain.handle('update:check', () => (app.isPackaged ? autoUpdater.checkForUpdates().then(() => true).catch(() => false) : false));
ipcMain.handle('update:download', () => autoUpdater.downloadUpdate().catch(() => null));
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));
ipcMain.handle('app:version', () => app.getVersion());

// ---------- system ----------

// Long jobs report { key, phase, percent } so the row that started them can show it.
const progressTo = (key) => (p) => mainWindow?.webContents.send('task:progress', { key, ...p });

ipcMain.handle('hw:scan', () => sys.scanHardware());
ipcMain.handle('drv:updates', () => sys.driverUpdates());
ipcMain.handle('drv:gpu', (_e, gpus, amdSoftware) => sys.gpuVendorCheck(gpus, amdSoftware));
ipcMain.handle('drv:install', async (_e, items, key) => {
  const r = await sys.installDrivers(items.map((i) => i.id), progressTo(key));
  if (r.ok) addHistory('drivers', { items: items.map((i) => i.title), reboot: r.data.reboot, restore: r.data.restore });
  return r;
});
ipcMain.handle('drv:gpuInstaller', async (_e, url, key) => {
  const r = await sys.downloadGpuInstaller(url, getSettings().saveDir, progressTo(key));
  if (r.ok) { shell.openPath(r.data); addHistory('gpu', { file: path.basename(r.data) }); }
  return r;
});
ipcMain.handle('bios:check', (_e, board) => sys.biosCheck(board));
ipcMain.handle('bios:download', async (_e, latest, key) => {
  const r = await sys.downloadBios(latest, getSettings().saveDir, progressTo(key));
  if (r.ok) { shell.showItemInFolder(r.data); addHistory('bios', { file: path.basename(r.data), version: latest.version }); }
  return r;
});
ipcMain.handle('dev:enable', async (_e, dev) => {
  const r = await sys.enableDevice(dev.id);
  if (r.ok) addHistory('enable', { name: dev.name });
  return r;
});

ipcMain.handle('hw:export', (_e, hw, format) => {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const file = path.join(getSettings().saveDir, `Tune-hardware-${stamp}.${format === 'csv' ? 'csv' : 'txt'}`);
  fs.writeFileSync(file, '﻿' + hardwareReport(hw, format), 'utf8'); // BOM: Excel and Notepad read it as UTF-8
  shell.showItemInFolder(file);
  return { ok: true, data: file };
});

// Folders shown on the cleanup page open in Explorer; only folders the last scan reported.
let junkDirs = new Set();
ipcMain.handle('junk:scan', async () => {
  const r = await sys.junkScan();
  if (r.ok) junkDirs = new Set([].concat(r.data || []).flatMap((c) => [].concat(c.dirs || [])));
  return r;
});
ipcMain.handle('folder:open', (_e, dir) => (junkDirs.has(dir) ? shell.openPath(dir) : null));
ipcMain.handle('junk:clean', async (_e, cats) => {
  const r = await sys.junkClean(cats.map((c) => c.key));
  if (r.ok) addHistory('clean', { cats: cats.map((c) => c.key), freed: r.data.freed });
  return r;
});
ipcMain.handle('startup:list', () => sys.startupList());
ipcMain.handle('startup:toggle', async (_e, item, enable) => {
  const r = await sys.startupToggle(item.source, item.key, enable);
  if (r.ok) addHistory('startup', { name: item.name, enabled: enable });
  return r;
});
ipcMain.handle('perf:get', () => sys.performance());
ipcMain.handle('rec:list', () => sys.recommendations());
ipcMain.handle('rec:apply', async (_e, rec) => {
  const r = await sys.applyRecommendation(rec.key);
  if (r.ok) addHistory('setting', { key: rec.key });
  return r;
});
ipcMain.handle('restore:create', async () => {
  const r = await sys.createRestorePoint('Tune - manual restore point');
  if (r.ok && r.data === 'created') addHistory('restore', {});
  return r;
});
ipcMain.handle('restore:open', () => sys.openSystemRestore());
ipcMain.handle('history:get', () => readHistory());
ipcMain.handle('link:open', (_e, url) => (/^https:\/\//.test(url) ? shell.openExternal(url) : null));

// The background service ships in resources/service (service/bin while developing).
const serviceDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'service') : path.join(__dirname, '..', 'service', 'bin'));
ipcMain.handle('service:status', async () => {
  const r = await sys.serviceStatus();
  return { ...r.data, bundled: sys.SERVICE_VERSION };
});
ipcMain.handle('service:install', async () => {
  const r = await sys.installService(serviceDir(), progressTo('service'));
  if (r.ok) addHistory('service', { installed: true, pawnio: r.data.pawnio });
  return r;
});
ipcMain.handle('service:uninstall', async () => {
  const r = await sys.uninstallService();
  if (r.ok) addHistory('service', { installed: false });
  return r;
});

ipcMain.handle('admin:status', () => sys.adminStatus());
ipcMain.handle('admin:start', () => sys.adminStart());
ipcMain.handle('admin:stop', () => sys.adminStop());

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:setLang', (_e, lang) => {
  saveSettings({ ...getSettings(), lang: lang === 'he' ? 'he' : 'en' });
  return getSettings();
});
ipcMain.handle('settings:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], defaultPath: getSettings().saveDir });
  if (!r.canceled && r.filePaths[0]) saveSettings({ ...getSettings(), saveDir: r.filePaths[0] });
  return getSettings();
});

// ---------- window ----------

function createWindow() {
  // Fits the screen and never needs page scrolling down to the minimum size.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1280, area.width - 40),
    height: Math.min(860, area.height - 40),
    minWidth: Math.min(980, area.width),
    minHeight: Math.min(640, area.height),
    center: true,
    title: 'Tune',
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  mainWindow = win;
  win.webContents.once('did-finish-load', () => {
    if (!app.isPackaged) return;
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  });
  if (process.env.VITE_DEV) win.loadURL('http://localhost:5175');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

// The installer runs "Tune.exe --install-service" (and the uninstaller "--uninstall-service"):
// do just that, with Windows' one approval prompt, and exit without opening a window.
const serviceArg = process.argv.find((a) => a === '--install-service' || a === '--uninstall-service');
if (serviceArg) {
  app.whenReady().then(async () => {
    const install = serviceArg === '--install-service';
    const r = install ? await sys.installService(serviceDir()) : await sys.uninstallService();
    if (r.ok) addHistory('service', install ? { installed: true, pawnio: r.data.pawnio, at: 'setup' } : { installed: false });
    app.exit(r.ok ? 0 : 1);
  });
} else {
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => app.quit());
// Closing Tune also ends an open admin session instead of leaving it for the rest of its 10 minutes.
app.on('will-quit', () => sys.adminStop());
