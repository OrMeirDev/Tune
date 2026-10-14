// Every request the window can make: the exact arguments it may carry (rules from validate.cjs) and
// what it runs. Requests that act on something carry only an ID; the details (URLs, hashes, devices,
// registry entries) come from what the main process found itself (offers.cjs). Everything the
// handlers need from Electron or the disk comes in `d`, so the whole table can be tested without
// Electron (tests/ipc.test.cjs). Registered in main.cjs behind guard.cjs.
const path = require('path');
const { str, match, oneOf, bool, optional, arrayOf, json } = require('./validate.cjs');
const { APPLYABLE } = require('./offers.cjs');

const CACHE_KEYS = ['hw', 'wu', 'gpu', 'bios', 'junk', 'startup', 'recs', 'scanAt'];
const GUID = /^[0-9a-fA-F-]{36}$/; // a Windows Update ID
const PROGRESS_KEY = str(200); // which row shows a job's progress

// Runs `fn` with what an offer lookup found, or returns the lookup's refusal.
const withOffer = (found, fn) => (found.ok ? fn(found.data) : found);

function createChannels(d) {
  const { sys, offers } = d;
  // Folders shown on the cleanup page open in Explorer; only folders the last scan reported.
  let junkDirs = new Set();
  let measuring = false;
  const remember = (kind) => async (r) => offers.remember(kind, await r);

  return {
    'update:check': { args: [], run: () => d.updater.check() },
    'update:download': { args: [], run: () => d.updater.download() },
    'update:install': { args: [], run: () => d.updater.install() },
    'app:version': { args: [], run: () => d.appVersion() },

    'cache:get': { args: [], run: () => d.cache.read() },
    'cache:set': { args: [oneOf(CACHE_KEYS), json(5_000_000)], run: (key, value) => d.cache.write(key, value) },

    'hw:scan': { args: [], run: () => remember('hw')(d.warmOr('hw', sys.scanHardware)) },
    'drv:updates': { args: [], run: () => remember('wu')(d.warmOr('wu', sys.driverUpdates)) },
    // the GPUs and the board come from the main process' own hardware scan
    'drv:gpu': { args: [], run: () => withOffer(offers.gpus(), ({ gpus, amdSoftware }) => remember('gpu')(sys.gpuVendorCheck(gpus, amdSoftware))) },
    'bios:check': { args: [], run: () => withOffer(offers.board(), (board) => remember('bios')(sys.biosCheck(board))) },

    'drv:install': {
      args: [arrayOf(match(GUID, 36), 100), PROGRESS_KEY],
      run: (ids, key) => withOffer(offers.drivers(ids), async (items) => {
        const r = await sys.installDrivers(items.map((i) => i.id), d.progressTo(key));
        if (r.ok) d.history.add('drivers', { items: items.map((i) => i.title), reboot: r.data.reboot, restore: r.data.restore });
        return r;
      }),
    },
    'drv:gpuInstaller': {
      args: [str(300)],
      run: (gpu) => withOffer(offers.gpuDriver(gpu), async (g) => {
        const r = await sys.downloadGpuInstaller(g.url, d.settings.get().saveDir, d.progressTo(gpu));
        if (r.ok) { d.shell.openPath(r.data); d.history.add('gpu', { file: path.basename(r.data) }); }
        return r;
      }),
    },
    'bios:download': {
      args: [optional(PROGRESS_KEY)],
      run: (key = 'bios') => withOffer(offers.bios(), async (b) => {
        const r = await sys.downloadBios(b.latest, d.settings.get().saveDir, d.progressTo(key));
        if (r.ok) { d.shell.showItemInFolder(r.data); d.history.add('bios', { file: path.basename(r.data), version: b.latest.version }); }
        return r;
      }),
    },
    'dev:enable': {
      args: [str(1024)],
      run: (id) => withOffer(offers.problemDevice(id), async (p) => {
        const r = await sys.enableDevice(p.id);
        if (r.ok) d.history.add('enable', { name: p.name });
        return r;
      }),
    },
    'hw:export': { args: [oneOf(['csv', 'txt'])], run: (format) => withOffer(offers.hardware(), (hw) => d.exportHardware(hw, format)) },

    'junk:scan': {
      args: [],
      run: async () => {
        const r = await remember('junk')(d.warmOr('junk', sys.junkScan));
        if (r.ok) junkDirs = new Set([].concat(r.data || []).flatMap((c) => [].concat(c.dirs || [])));
        return r;
      },
    },
    'folder:open': { args: [str(1024)], run: (dir) => (junkDirs.has(dir) ? d.shell.openPath(dir) : null) },
    'junk:clean': {
      args: [arrayOf(str(40), 30)],
      run: (keys) => withOffer(offers.junkCategories(keys), async (cats) => {
        // Free space on the system drive right before and after, so the result shows what the drive
        // actually gained, next to the size of the files deleted (plan PF02).
        const before = await sys.diskFree();
        const r = await sys.junkClean(cats.map((c) => c.key));
        if (r.ok) {
          const after = await sys.diskFree();
          const id = d.history.add('clean', { cats: cats.map((c) => c.key), freed: r.data.freed });
          return { ...r, data: { ...r.data, onDisk: d.measurements.addDiskPair(before, after, id) } };
        }
        return r;
      }),
    },
    'startup:list': { args: [], run: () => remember('startup')(d.warmOr('startup', sys.startupList)) },
    'startup:toggle': {
      args: [str(100), str(1024), bool()],
      run: (source, key, enable) => withOffer(offers.startupEntry(source, key), async (e) => {
        const r = await sys.startupToggle(e.source, e.key, enable);
        if (r.ok) d.history.add('startup', { name: e.name, enabled: enable });
        return r;
      }),
    },

    // Measurements (read only): the PC at rest, or Windows' start-up records. One at a time, so two
    // rest measurements never see each other's load. The window says which kind; the values are
    // taken here, never sent in.
    'measure:take': {
      args: [oneOf(['rest', 'boot'])],
      run: async (what) => {
        if (measuring) return { ok: false, error: 'busy' };
        measuring = true;
        try {
          if (what === 'rest') {
            const r = await sys.restMeasure({ onProgress: d.progressTo('measure') });
            if (r.ok) d.measurements.add(r.data);
            return r;
          }
          const r = await sys.bootInfo();
          if (!r.ok) return r;
          const { records, ...facts } = r.data;
          d.measurements.add(records);
          return { ok: true, data: facts };
        } finally {
          measuring = false;
        }
      },
    },
    'measure:list': { args: [], run: () => ({ ok: true, data: d.measurements.view(d.history.read()) }) },
    'measure:export': { args: [], run: () => d.exportMeasurements() },

    'perf:get': { args: [], run: () => sys.performance() },
    'perf:sensors': { args: [], run: () => sys.sensors() },
    'rec:list': { args: [], run: () => remember('recs')(d.warmOr('recs', sys.recommendations)) },
    'rec:apply': {
      args: [oneOf(APPLYABLE)],
      run: (key) => withOffer(offers.recommendation(key), async (rec) => {
        const r = await sys.applyRecommendation(rec.key);
        if (r.ok) d.history.add('setting', { key: rec.key });
        return r;
      }),
    },
    'restore:create': {
      args: [],
      run: async () => {
        const r = await sys.createRestorePoint('Tune - manual restore point');
        if (r.ok && r.data === 'created') d.history.add('restore', {});
        return r;
      },
    },
    'restore:open': { args: [], run: () => sys.openSystemRestore() },
    'history:get': { args: [], run: () => d.history.read() },
    // only https pages, without credentials in the address
    'link:open': { args: [match(/^https:\/\/[^\s@/]+(\/[^\s]*)?$/, 2048)], run: (url) => d.shell.openExternal(url) },

    'service:status': { args: [], run: async () => ({ ...(await sys.serviceStatus()).data, bundled: sys.SERVICE_VERSION }) },
    'service:install': {
      args: [],
      run: async () => {
        const r = await sys.installService(d.serviceDir(), d.progressTo('service'));
        if (r.ok) d.history.add('service', { installed: true, pawnio: r.data.pawnio });
        return r;
      },
    },
    'service:uninstall': {
      args: [],
      run: async () => {
        const r = await sys.uninstallService();
        if (r.ok) d.history.add('service', { installed: false });
        return r;
      },
    },
    'admin:status': { args: [], run: () => sys.adminStatus() },
    'admin:start': { args: [], run: () => sys.adminStart() },
    'admin:stop': { args: [], run: () => sys.adminStop() },

    'settings:get': { args: [], run: () => d.settings.get() },
    'settings:setLang': { args: [oneOf(['he', 'en'])], run: (lang) => { d.settings.save({ ...d.settings.get(), lang }); return d.settings.get(); } },
    'settings:setSound': { args: [bool()], run: (on) => { d.settings.save({ ...d.settings.get(), sound: on }); return d.settings.get(); } },
    'settings:pickDir': { args: [], run: () => d.settings.pickDir() },
  };
}

module.exports = { createChannels, CACHE_KEYS };
