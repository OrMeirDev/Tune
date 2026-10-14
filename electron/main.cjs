const { app, BrowserWindow, ipcMain, shell, screen, dialog, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const sys = require('./system.cjs');
const { pathToFileURL } = require('url');
const { hardwareReport } = require('./report.cjs');
const { createMeasureStore } = require('./measure-store.cjs');
const { createLicensing } = require('./licensing/index.cjs');
const { createChannels, CACHE_KEYS } = require('./ipc/channels.cjs');
const { createOffers } = require('./ipc/offers.cjs');
const { isTrustedSender, dispatch, pageOf } = require('./ipc/guard.cjs');

// ---------- history of everything Tune changed ----------

const historyFile = () => path.join(app.getPath('userData'), 'history.json');
const readHistory = () => { try { return JSON.parse(fs.readFileSync(historyFile(), 'utf8')); } catch { return []; } };
// Each entry gets an ID, so measurements taken around a change can point at it (measure-store.cjs).
function addHistory(action, detail) {
  const id = crypto.randomUUID();
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify([{ id, action, detail, at: new Date().toISOString() }, ...readHistory()].slice(0, 500), null, 2));
  return id;
}

// ---------- measurements (before and after a change; kept on this PC only) ----------

let measureStore = null;
const measurements = () => (measureStore ||= createMeasureStore({ file: path.join(app.getPath('userData'), 'measurements.json') }));

// ---------- settings (the save folder is chosen only here) ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function getSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* first run */ }
  // English unless the user picked Hebrew in Settings.
  return { saveDir: s.saveDir && fs.existsSync(s.saveDir) ? s.saveDir : app.getPath('downloads'), lang: s.lang === 'he' ? 'he' : 'en', sound: s.sound !== false };
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


// ---------- system ----------

// Long jobs report { key, phase, percent } so the row that started them can show it.
const progressTo = (key) => (p) => mainWindow?.webContents.send('task:progress', { key, ...p });

// The slow scans start the moment Tune launches, before the window has even loaded; the page's
// first request for each one picks up the scan already under way (later requests scan anew).
const warm = new Map();
function prewarm() {
  warm.set('hw', sys.scanHardware());
  warm.set('wu', sys.driverUpdates());
  warm.set('junk', sys.junkScan());
  warm.set('startup', sys.startupList());
  warm.set('recs', sys.recommendations());
}
const warmOr = (key, fn) => { const p = warm.get(key); warm.delete(key); return p || fn(); };

// The last results, so the next launch can show them at once while fresh ones load.
const cacheFile = () => path.join(app.getPath('userData'), 'cache.json');
let cache = null;
const readCache = () => {
  if (!cache) { try { cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { cache = {}; } }
  return cache;
};
function writeCache(key, value) {
  if (!CACHE_KEYS.includes(key)) return;
  const c = readCache();
  c[key] = value;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(`${cacheFile()}.tmp`, JSON.stringify(c));
    fs.renameSync(`${cacheFile()}.tmp`, cacheFile());
  } catch { /* the cache is only a convenience */ }
}

function exportHardware(hw, format) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const file = path.join(getSettings().saveDir, `Tune-hardware-${stamp}.${format === 'csv' ? 'csv' : 'txt'}`);
  fs.writeFileSync(file, '﻿' + hardwareReport(hw, format), 'utf8'); // BOM: Excel and Notepad read it as UTF-8
  shell.showItemInFolder(file);
  return { ok: true, data: file };
}

function exportMeasurements() {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const file = path.join(getSettings().saveDir, `Tune-measurements-${stamp}.csv`);
  try {
    fs.writeFileSync(file, '\ufeff' + measurements().csv(), 'utf8'); // BOM: Excel reads it as UTF-8
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  shell.showItemInFolder(file);
  return { ok: true, data: file };
}

// ---------- licensing (licensing/: shipped defaults change nothing; see licensing/config.cjs) ----------

// Created on first use, after the app is ready (safeStorage and net need it).
let licensingParts = null;
const licensing = () => (licensingParts ||= createLicensing({
  packaged: app.isPackaged,
  userData: app.getPath('userData'),
  safeStorage,
  fetch: typeof net.fetch === 'function' ? (url, init) => net.fetch(url, init) : globalThis.fetch,
}));

// The background service ships in resources/service (service/bin while developing).
const serviceDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'service') : path.join(__dirname, '..', 'service', 'bin'));

// ---------- requests from the window (see ipc/: who may ask, and what) ----------

// The page Tune shows; requests and navigation are accepted only from it.
const pageUrl = process.env.VITE_DEV ? 'http://localhost:5175/' : pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
// What the main process found itself; actions point at these by ID.
const offers = createOffers();
const channels = createChannels({
  sys, offers, shell, progressTo, warmOr, serviceDir, exportHardware, exportMeasurements,
  appVersion: () => app.getVersion(),
  updater: {
    check: () => (app.isPackaged ? autoUpdater.checkForUpdates().then(() => true).catch(() => false) : false),
    download: () => autoUpdater.downloadUpdate().catch(() => null),
    install: () => autoUpdater.quitAndInstall(true, true),
  },
  cache: { read: readCache, write: writeCache },
  history: { add: addHistory, read: readHistory },
  licensing: {
    status: () => licensing().client.status(),
    startOwner: (email) => licensing().client.startOwner(email),
    confirmOwner: (code) => licensing().client.confirmOwner(code),
    activate: (serial) => licensing().client.activate(serial),
    recover: (licenseId) => licensing().client.recover(licenseId),
    retry: () => licensing().client.retry(),
    refresh: () => licensing().client.refresh(),
    reset: () => licensing().client.reset(),
  },
  entitlements: {
    featureOf: (channel) => licensing().entitlements.featureOf(channel),
    check: (feature) => licensing().entitlements.check(feature),
  },
  measurements: {
    add: (records) => measurements().add(records),
    addDiskPair: (before, after, id) => measurements().addDiskPair(before, after, id),
    view: (actions) => measurements().view(actions),
  },
  settings: {
    get: getSettings,
    save: saveSettings,
    pickDir: async () => {
      const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], defaultPath: getSettings().saveDir });
      if (!r.canceled && r.filePaths[0]) saveSettings({ ...getSettings(), saveDir: r.filePaths[0] });
      return getSettings();
    },
  },
});
const trusted = (event) => isTrustedSender(event, { webContents: mainWindow?.webContents, pageUrl });
for (const [name, channel] of Object.entries(channels)) ipcMain.handle(name, (event, ...args) => dispatch(channel, event, args, trusted));

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
    backgroundColor: '#f4f8fe',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  mainWindow = win;
  // The window only ever shows Tune's own page: links open in the browser through link:open, never here.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (pageOf(url) !== pageOf(pageUrl)) e.preventDefault(); });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  // Shown once the page has drawn, so it opens complete instead of blank.
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', () => {
    if (!app.isPackaged) return;
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  });
  win.loadURL(pageUrl);
}

// One Tune at a time: opening it again brings the open window to the front instead.
const focusMain = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

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
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', focusMain);
  // licensing reads what is stored and renews in the background when due; it never delays the window
  app.whenReady().then(() => { prewarm(); createWindow(); licensing().client.init(); });
}
app.on('window-all-closed', () => app.quit());
// Closing Tune also ends an open admin session instead of leaving it for the rest of its 10 minutes.
app.on('will-quit', () => sys.adminStop());
