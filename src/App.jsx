import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Home, Loader2 } from 'lucide-react';
// The Tune name with its symbol on the right (vector, from the brand package).
import brandLockup from './assets/brand/logo-lockup.svg';
import { api } from './api.js';
import { NAV_GROUPS, PAGES } from './app/routes.js';
import { useCommands } from './app/useCommands.js';
import { useOperations } from './app/useOperations.js';
import { useScanResults } from './app/useScanResults.js';
import { UpdateBanner } from './components/AppUpdateBanner.jsx';
import { Banner } from './components/NoticeBanner.jsx';
import { BiosGuide } from './features/bios/BiosGuideDialog.jsx';
import { CleanPage } from './features/cleanup/CleanupPage.jsx';
import { CenterPage } from './features/diagnostics/DiagnosticsPage.jsx';
import { centerItems } from './features/diagnostics/findingSelectors.js';
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

// Which results each page shows, for the "showing the last scan · updating" label.
const STALE_KEYS = { updates: ['wu', 'gpu', 'bios'], hardware: ['hw'], overview: ['junk', 'startup', 'recs'], clean: ['junk'], startup: ['startup'], recs: ['recs'] };

// ---------------- shell ----------------

export default function App() {
  const [page, setPage] = useState('updates');
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

  // The scan results and how they are fetched (app/useScanResults.js).
  const results = useScanResults({ setMsg });
  const { hw, wu, gpu, bios, sources, scan, junk, startup, perf, recs, fresh, stale, setJunk, setPerf, setRecs, loadJunk, loadPerf, loadRecs, fullScan, showCached } = results;
  // Actions that change the system, one at a time (app/useOperations.js), and what each button does
  // (app/useCommands.js).
  const { busy, prog, act, lockWhile } = useOperations({ t, service, adminUntil, setAdminUntil, setMsg });
  const loadService = useCallback(async () => setService(await api.serviceStatus()), []);
  const {
    installDrivers, gpuInstall, biosDownload, enable, clean, toggle, apply, restorePoint, exportHw,
    adminStart, adminStop, installService, removeService, setLang,
  } = useCommands({ t, act, results, loadService, setGuide, setAdminUntil, setSettings });

  useEffect(() => {
    if (!api) return undefined;
    api.appVersion().then(setVersion);
    api.getSettings().then(setSettings);
    api.adminStatus().then(setAdminUntil);
    loadService();
    const offUpdate = api.onAppUpdate(setAppUpdate);
    showCached().finally(fullScan);
    return () => { offUpdate(); };
  }, [fullScan, loadService, showCached]);

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
          {page === 'overview' && <OverviewPage junk={junk} startup={startup} perf={perf} live={live} recs={recs && centerItems({ recs, bios, gpu, junk, startup, live, history, sources })} go={setPage} sources={sources} />}
          {page === 'clean' && <CleanPage junk={junk} failed={sources.junk === 'error'} onRescan={() => { setJunk(null); loadJunk(); }} onClean={clean} busy={lockWhile(stale('junk'))} />}
          {page === 'startup' && <StartupPage startup={startup} failed={sources.startup === 'error'} onToggle={toggle} busy={lockWhile(stale('startup'))} prog={prog} />}
          {page === 'perf' && <PerfPage perf={perf} live={live} history={history} service={service} onRefresh={() => { setPerf(null); loadPerf(); }} onInstallService={installService} busy={busy} />}
          {page === 'recs' && (
            <CenterPage
              recs={recs} bios={bios} gpu={gpu} junk={junk} startup={startup} live={live} history={history} sources={sources} service={service} go={setPage}
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
