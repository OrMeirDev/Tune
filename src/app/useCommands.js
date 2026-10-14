// What each button that changes something does: the operation to run (through useOperations'
// `act`), the message for its result, and what to reload afterwards. Actions send only an ID; the
// main process acts on what it found itself (electron/ipc/offers.cjs).
import { api } from '../api.js';
import { recTitle } from '../features/diagnostics/recommendationText.js';
import { errText, fmtGB } from '../presentation/format.jsx';

// What a cleanup did to the drive's free space, measured right before and after (plan PF02).
function onDiskText(m, t) {
  const drive = m?.after?.conditions?.drive || m?.before?.conditions?.drive || 'C:';
  if (m?.state === 'better') return t('msg.onDisk', { size: fmtGB(m.delta), drive });
  if (m?.state === 'same') return t('msg.onDiskSame', { drive });
  if (m?.state === 'worse') return t('msg.onDiskWorse', { size: fmtGB(-m.delta), drive });
  return '';
}

export function useCommands({ t, act, results, loadService, setGuide, setAdminUntil, setSettings, onMeasured }) {
  const { bios, scanDrivers, loadJunk, loadStartup, loadRecs, loadPerf } = results;

  const installDrivers = (items) => {
    const key = items.length === 1 ? items[0].id : 'all';
    return act(key, () => api.installDrivers(items.map((i) => i.id), key), (d) => {
      const okCount = (d.results || []).filter((x) => x.code === 2 || x.code === 3).length;
      scanDrivers();
      const rp = d.restore === 'created' ? t('msg.rpCreated') : d.restore === 'recent' ? t('msg.rpRecent') : d.restore === 'unavailable' ? t('msg.rpUnavailable') : t('msg.rpNot', { e: d.restore });
      return t('msg.installed', { ok: okCount, n: items.length }) + rp + (d.reboot ? t('msg.rebootNeeded') : '');
    }, { admin: true });
  };
  const gpuInstall = (g) => act(g.gpu, () => api.gpuInstaller(g.gpu), () => t('msg.gpuDone', { vendor: g.vendor }));
  const biosDownload = () => act('bios', () => api.biosDownload('bios'), () => { setGuide(true); return t('msg.biosDone', { v: bios.latest.version, maker: bios.maker }); });
  const enable = (p) => act(p.id, () => api.enableDevice(p.id), () => { scanDrivers(); return t('msg.enabled', { name: p.name }); }, { admin: true });
  const clean = (cats) => act('clean', () => api.junkClean(cats.map((c) => c.key)), (d) => {
    loadJunk();
    onMeasured();
    return t('msg.cleaned', { size: fmtGB(d.freed) }) + onDiskText(d.onDisk, t) + (d.skipped ? t('msg.skipped', { n: d.skipped }) : '') + (d.adminError ? t('msg.adminPartFailed', { e: errText(d.adminError, t) }) : '') + (d.busy?.length ? t('msg.wuBusy') : '');
  }, { admin: cats.some((c) => c.admin) });
  const toggle = (s, en) => act(s.source + s.key, () => api.startupToggle(s.source, s.key, en), () => { loadStartup(); return t(en ? 'msg.startupOn' : 'msg.startupOff', { name: s.name }); }, { admin: s.admin });
  const apply = (r) => act(r.key, () => api.applyRecommendation(r.key), (d) => { loadRecs(); return t(d === 'reboot' ? 'msg.recReboot' : 'msg.recDone', { title: recTitle(r, t) }); }, { admin: r.key === 'hags' });
  const restorePoint = () => act('restore', () => api.createRestorePoint(), (d) => t({ created: 'msg.rpCreatedFull', recent: 'msg.rpRecentFull' }[d] || 'msg.rpUnavailableFull'), { admin: true });
  const exportHw = (format) => act('export', () => api.exportHardware(format), (file) => t('msg.saved', { file }));
  const adminStart = () => act('admin', () => api.adminStart(), () => t('msg.adminOn'), { admin: true });
  const adminStop = async () => { await api.adminStop(); setAdminUntil(0); };
  const installService = () => act('service', () => api.installService(), (d) => {
    loadService();
    loadPerf();
    const pawn = { installed: t('msg.pawnInstalled'), present: '', reboot: t('msg.pawnReboot') }[d.pawnio] ?? t('msg.pawnFailed', { e: d.pawnio });
    return t('msg.svcInstalled') + pawn;
  }, { admin: true });
  const removeService = () => window.confirm(t('msg.svcRemoveConfirm'))
    && act('service', () => api.uninstallService(), () => { loadService(); return t('msg.svcRemoved'); }, { admin: true });
  const setLang = async (lang) => setSettings(await api.setLanguage(lang));
  // 20 seconds of readings at rest; a busy PC is measured but never compared with rest measurements
  const measureRest = () => act('measure', () => api.measureTake('rest'), (recs) => {
    onMeasured();
    const load = [].concat(recs || []).find((r) => r.metric === 'restCpuLoad');
    return t(load?.conditions?.loadBand === 'busy' ? 'msg.measuredBusy' : 'msg.measured');
  });
  const exportMeasurements = () => act('exportMeasurements', () => api.measureExport(), (file) => t('msg.saved', { file }));

  return { installDrivers, gpuInstall, biosDownload, enable, clean, toggle, apply, restorePoint, exportHw, adminStart, adminStop, installService, removeService, setLang, measureRest, exportMeasurements };
}
