import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Home, Loader2 } from 'lucide-react';
// The Tune name with its symbol on the right (vector, from the brand package).
import brandLockup from './assets/brand/logo-lockup.svg';
import { api } from './api.js';
import { NAV_GROUPS, PAGES } from './app/routes.js';
import { UpdateBanner } from './components/AppUpdateBanner.jsx';
import { Banner } from './components/NoticeBanner.jsx';
import { sourcesFrom } from './domain/scan-verdict.mjs';
import { BiosGuide } from './features/bios/BiosGuideDialog.jsx';
import { CleanPage } from './features/cleanup/CleanupPage.jsx';
import { CenterPage } from './features/diagnostics/DiagnosticsPage.jsx';
import { centerItems } from './features/diagnostics/findingSelectors.js';
import { recTitle } from './features/diagnostics/recommendationText.js';
import { SettingGuide } from './features/guides/SettingGuideDialog.jsx';
import { HardwarePage } from './features/hardware/HardwarePage.jsx';
import { HistoryPage } from './features/history/HistoryPage.jsx';
import { OverviewPage } from './features/overview/OverviewPage.jsx';
import { PerfPage } from './features/performance/PerformancePage.jsx';
import { useLiveSensors } from './features/sensors/useSensorSnapshot.js';
import { AdminChip } from './features/settings/PrivilegeSessionChip.jsx';
import { SettingsPage } from './features/settings/SettingsPage.jsx';
import { StartupPage } from './features/startup/StartupPage.jsx';
import { UpdatesPage } from './features/updates/UpdatesPage.jsx';
import { LangContext, makeT } from './i18n.js';
import { errText, fmtGB } from './presentation/format.jsx';

// Which results each page shows, for the "showing the last scan · updating" label.
const STALE_KEYS = { updates: ['wu', 'gpu', 'bios'], hardware: ['hw'], overview: ['junk', 'startup', 'recs'], clean: ['junk'], startup: ['startup'], recs: ['recs'] };

// ---------------- shell ----------------

export default function App() {
  const [page, setPage] = useState('updates');
  const [hw, setHw] = useState(null);
  const [wu, setWu] = useState(null);
  const [gpu, setGpu] = useState(null);
  const [bios, setBios] = useState(null);
  // Whether each check of the last scan answered (see domain/scan-verdict.mjs).
  const [sources, setSources] = useState({});
  const [scan, setScan] = useState({ running: true, step: 0, total: 3, label: '', at: null });
  const [junk, setJunk] = useState(null);
  const [startup, setStartup] = useState(null);
  const [perf, setPerf] = useState(null);
  const [recs, setRecs] = useState(null);
  const [busy, setBusy] = useState(null);
  const [prog, setProg] = useState({});
  const [msg, setMsg] = useState(null);
  const [version, setVersion] = useState('');
  const [appUpdate, setAppUpdate] = useState(null);
  const [adminUntil, setAdminUntil] = useState(0);
  const [guide, setGuide] = useState(false);
  const [settingGuide, setSettingGuide] = useState(null);
  const [settings, setSettings] = useState(null);
  const [live, history] = useLiveSensors(page === 'perf' || page === 'recs' || page === 'overview');
  const [service, setService] = useState(null);
  // English until the saved choice is read; a first launch stays English.
  const t = useMemo(() => makeT(settings?.lang || 'en'), [settings?.lang]);

  useEffect(() => {
    document.documentElement.lang = t.lang;
    document.documentElement.dir = t.lang === 'he' ? 'rtl' : 'ltr';
  }, [t]);

  // What the page shows came from the last launch until this launch's own result arrives; actions
  // on that data wait for the fresh result (`stale`). Every fresh result is kept for next time.
  const [fromCache, setFromCache] = useState({});
  const [fresh, setFresh] = useState({});
  const markFresh = useCallback((key, value) => {
    setFresh((f) => ({ ...f, [key]: true }));
    api.cacheSet?.(key, value);
  }, []);
  const stale = (key) => !!fromCache[key] && !fresh[key];
  // While a page still shows the last launch's data its action buttons wait: 'stale' counts as busy
  // (it matches no row, so no row shows progress).
  const lockWhile = (cond) => busy || (cond ? 'stale' : null);

  const loadService = useCallback(async () => setService(await api.serviceStatus()), []);
  const loadJunk = useCallback(async () => { const r = await api.junkScan(); const v = r.ok ? [].concat(r.data) : []; setJunk(v); if (r.ok) markFresh('junk', v); }, [markFresh]);
  const loadStartup = useCallback(async () => { const r = await api.startupList(); const v = r.ok ? [].concat(r.data || []) : []; setStartup(v); if (r.ok) markFresh('startup', v); }, [markFresh]);
  const loadPerf = useCallback(async () => { const r = await api.performance(); if (r.ok) setPerf(r.data); }, []);
  const loadRecs = useCallback(async () => { const r = await api.recommendations(); const v = r.ok ? [].concat(r.data) : []; setRecs(v); if (r.ok) markFresh('recs', v); }, [markFresh]);

  // Drivers only: after an install, to refresh what is still offered.
  const scanDrivers = useCallback(async () => {
    const h = await api.scanHardware();
    if (h.ok) { setHw(h.data); markFresh('hw', h.data); }
    const w = await api.driverUpdates();
    // a failed check keeps the last answer on screen, marked as not checked
    if (w.ok) { setWu([].concat(w.data || [])); markFresh('wu', [].concat(w.data || [])); }
    setSources((s) => ({ ...s, hw: h.ok ? 'ok' : 'error', wu: w.ok ? 'ok' : 'error' }));
  }, [markFresh]);

  // Full scan. The optimization pages don't depend on the driver scan, so they load right away,
  // side by side with it, and can be used while Windows Update is still searching.
  // Step labels are dictionary keys, so they follow a language change mid-scan.
  const fullScan = useCallback(async () => {
    const step = (n, label) => setScan((s) => ({ ...s, running: true, step: n, label }));
    const optimize = Promise.all([loadJunk(), loadStartup(), loadRecs(), loadPerf()]);
    step(1, 'scan.s1');
    const h = await api.scanHardware();
    if (h.ok) { setHw(h.data); markFresh('hw', h.data); }
    step(2, 'scan.s2');
    const board = h.ok ? { maker: h.data.boardMaker, model: h.data.boardModel, version: h.data.bios.version, date: h.data.bios.date, systemMaker: h.data.systemMaker, systemModel: h.data.systemModel, systemSku: h.data.systemSku } : null;
    const [w, g, b] = await Promise.all([
      api.driverUpdates(),
      h.ok ? api.gpuCheck(h.data.gpus, h.data.amdSoftware) : Promise.resolve({ ok: false }),
      board ? api.biosCheck(board) : Promise.resolve({ ok: false }),
    ]);
    // A failed check keeps the last answer on screen (marked as not checked) instead of turning
    // into "nothing to update".
    if (w.ok) {
      setWu([].concat(w.data || [])); markFresh('wu', [].concat(w.data || []));
      setMsg((m) => (m?.key === 'msg.wuFailed' ? null : m)); // an earlier failure is resolved
    } else setMsg({ kind: 'err', key: 'msg.wuFailed', vars: { e: w.error } });
    if (g.ok) { setGpu([].concat(g.data || [])); markFresh('gpu', [].concat(g.data || [])); }
    if (b.ok) { setBios(b.data); markFresh('bios', b.data); }
    setSources(sourcesFrom({ hw: h, wu: w, gpu: g, bios: b }));
    step(3, 'scan.s3');
    await optimize;
    const at = Date.now();
    setScan((s) => ({ ...s, running: false, at }));
    api.cacheSet?.('scanAt', at);
  }, [loadJunk, loadStartup, loadRecs, loadPerf, markFresh]);

  // The last launch's results, shown at once; this launch's scan replaces them as they arrive.
  const showCached = useCallback(async () => {
    const c = (await api.cacheGet?.().catch(() => null)) || {};
    const keys = {};
    const use = (key, set) => { if (c[key] != null) { set(c[key]); keys[key] = true; } };
    use('hw', setHw); use('wu', setWu); use('gpu', setGpu); use('bios', setBios);
    use('junk', setJunk); use('startup', setStartup); use('recs', setRecs);
    setFromCache(keys);
    if (c.scanAt) setScan((s) => ({ ...s, at: c.scanAt }));
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    api.appVersion().then(setVersion);
    api.getSettings().then(setSettings);
    api.adminStatus().then(setAdminUntil);
    loadService();
    const offUpdate = api.onAppUpdate(setAppUpdate);
    const offProgress = api.onProgress((p) => setProg((m) => ({ ...m, [p.key]: p })));
    showCached().finally(fullScan);
    return () => { offUpdate(); offProgress(); };
  }, [fullScan, loadService, showCached]);

  // Every action that changes the system: one at a time, progress on its row, result in a banner.
  // Actions that need admin rights show "waiting for approval" until Windows' prompt is answered.
  const act = async (key, fn, done, { admin = false } = {}) => {
    setBusy(key);
    setMsg(null);
    const prompt = admin && !(service?.running && service.current) && adminUntil - Date.now() < 4000;
    setProg((m) => ({ ...m, [key]: prompt ? { phase: 'auth' } : null }));
    const r = await fn();
    setBusy(null);
    setProg((m) => ({ ...m, [key]: null }));
    if (admin || r?.adminUntil) api.adminStatus().then(setAdminUntil);
    if (!r?.ok) setMsg({ kind: 'err', text: errText(r?.error, t) });
    else if (done) setMsg({ kind: 'info', text: done(r.data) });
    return r;
  };

  const installDrivers = (items) => {
    const key = items.length === 1 ? items[0].id : 'all';
    return act(key, () => api.installDrivers(items, key), (d) => {
      const okCount = (d.results || []).filter((x) => x.code === 2 || x.code === 3).length;
      scanDrivers();
      const rp = d.restore === 'created' ? t('msg.rpCreated') : d.restore === 'recent' ? t('msg.rpRecent') : t('msg.rpNot', { e: d.restore });
      return t('msg.installed', { ok: okCount, n: items.length }) + rp + (d.reboot ? t('msg.rebootNeeded') : '');
    }, { admin: true });
  };
  const gpuInstall = (g) => act(g.gpu, () => api.gpuInstaller(g.url, g.gpu), () => t('msg.gpuDone', { vendor: g.vendor }));
  const biosDownload = () => act('bios', () => api.biosDownload(bios.latest, 'bios'), () => { setGuide(true); return t('msg.biosDone', { v: bios.latest.version, maker: bios.maker }); });
  const enable = (p) => act(p.id, () => api.enableDevice(p), () => { scanDrivers(); return t('msg.enabled', { name: p.name }); }, { admin: true });
  const clean = (cats) => act('clean', () => api.junkClean(cats), (d) => {
    loadJunk();
    return t('msg.cleaned', { size: fmtGB(d.freed) }) + (d.skipped ? t('msg.skipped', { n: d.skipped }) : '') + (d.adminError ? t('msg.adminPartFailed', { e: errText(d.adminError, t) }) : '');
  }, { admin: cats.some((c) => c.admin) });
  const toggle = (s, en) => act(s.source + s.key, () => api.startupToggle(s, en), () => { loadStartup(); return t(en ? 'msg.startupOn' : 'msg.startupOff', { name: s.name }); }, { admin: s.admin });
  const apply = (r) => act(r.key, () => api.applyRecommendation(r), (d) => { loadRecs(); return t(d === 'reboot' ? 'msg.recReboot' : 'msg.recDone', { title: recTitle(r, t) }); }, { admin: r.key === 'hags' });
  const restorePoint = () => act('restore', () => api.createRestorePoint(), (d) => t(d === 'created' ? 'msg.rpCreatedFull' : 'msg.rpRecentFull'), { admin: true });
  const exportHw = (format) => act('export', () => api.exportHardware(hw, format), (file) => t('msg.saved', { file }));
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

  const updatesCount = (wu?.length || 0) + (gpu || []).filter((g) => g.newer && g.url).length + (bios?.supported && bios.newer ? 1 : 0);
  const Crumb = t.lang === 'he' ? ChevronLeft : ChevronRight;
  // A message stored as a key (from the scan) is translated when shown.
  const shownMsg = msg && msg.key ? { ...msg, text: t(msg.key, msg.vars) } : msg;

  return (
    <LangContext.Provider value={t}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand"><img className="brand-lockup" src={brandLockup} alt="Tune" draggable={false} /></div>
          <nav>
            {NAV_GROUPS.map((g, i) => (
              <React.Fragment key={i}>
                {g.group && <div className="nav-group">{t(g.group)}</div>}
                <div className="nav-panel">
                  {g.pages.map((p) => (
                    <button key={p.id} className={`nav-item ${page === p.id ? 'active' : ''}`} onClick={() => setPage(p.id)}>
                      <span>{t(p.key)}</span>
                      {p.id === 'updates' && updatesCount > 0 && <span className="nav-badge">{updatesCount}</span>}
                      <p.icon size={18} />
                    </button>
                  ))}
                </div>
              </React.Fragment>
            ))}
          </nav>
          <div className="sidebar-footer">
            <AdminChip service={service} until={adminUntil} onStart={adminStart} onStop={adminStop} onInstall={installService} busy={busy} />
            <div><span className={`dot ${scan.running ? 'dot-off' : ''}`} /> {scan.running ? t('scanning') : t('sb.done')}</div>
            <div className="muted">{t('version', { v: version || '…' })}</div>
          </div>
        </aside>
        <main className="main">
          <div className="breadcrumbs"><Home size={15} /> <Crumb size={13} /> <span>{t(PAGES.find((p) => p.id === page)?.key || '')}</span>
            {(STALE_KEYS[page] || []).some(stale) && <span className="stale-chip"><Loader2 size={12} className="spin" /> {t('stale.updating')}</span>}</div>
          <UpdateBanner status={appUpdate} />
          <Banner msg={shownMsg} onClose={() => setMsg(null)} />
          {page === 'updates' && <UpdatesPage hw={hw} wu={wu} gpu={gpu} bios={bios} sources={sources} scan={scan} soundKey={settings?.sound !== false && fresh.wu && !scan.running ? scan.at : null} busy={lockWhile(scan.running)} onScan={fullScan} onInstall={installDrivers} onGpu={gpuInstall} onBiosDownload={biosDownload} onGuide={() => setGuide(true)} onEnable={enable} prog={prog} />}
          {page === 'hardware' && <HardwarePage hw={hw} onExport={exportHw} />}
          {page === 'overview' && <OverviewPage junk={junk} startup={startup} perf={perf} live={live} recs={recs && centerItems({ recs, bios, gpu, junk, startup, live, history })} go={setPage} />}
          {page === 'clean' && <CleanPage junk={junk} onRescan={() => { setJunk(null); loadJunk(); }} onClean={clean} busy={lockWhile(stale('junk'))} />}
          {page === 'startup' && <StartupPage startup={startup} onToggle={toggle} busy={lockWhile(stale('startup'))} prog={prog} />}
          {page === 'perf' && <PerfPage perf={perf} live={live} history={history} service={service} onRefresh={() => { setPerf(null); loadPerf(); }} onInstallService={installService} busy={busy} />}
          {page === 'recs' && (
            <CenterPage
              recs={recs} bios={bios} gpu={gpu} junk={junk} startup={startup} live={live} history={history} service={service} go={setPage}
              onInstallService={installService} onRefresh={() => { setRecs(null); loadRecs(); }}
              onApply={apply} onBiosDownload={biosDownload} onBiosGuide={() => (bios?.latest ? setGuide(true) : setPage('updates'))}
              onGuide={setSettingGuide} busy={lockWhile(stale('recs'))} prog={prog}
            />
          )}
          {page === 'history' && <HistoryPage busy={busy} onRestorePoint={restorePoint} />}
          {page === 'settings' && <SettingsPage version={version} status={appUpdate} settings={settings} onLang={setLang} onSound={async (on) => setSettings(await api.setSound(on))} service={service} onInstallService={installService} onRemoveService={removeService} busy={busy} prog={prog} onPickDir={async () => setSettings(await api.pickSaveDir())} onCheck={async () => { setAppUpdate({ state: 'checking' }); if (!(await api.checkAppUpdate())) setAppUpdate({ state: 'dev' }); }} />}
        </main>
        {guide && bios?.latest && <BiosGuide bios={bios} onClose={() => setGuide(false)} onDownload={biosDownload} busy={busy === 'bios'} prog={prog.bios} />}
        {settingGuide && <SettingGuide item={settingGuide} boardMaker={hw?.boardMaker} onClose={() => setSettingGuide(null)} />}
      </div>
    </LangContext.Provider>
  );
}
