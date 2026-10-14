// Driver, graphics driver and BIOS updates.
import { useMemo } from 'react';
import {
  AlertTriangle, CircleAlert, CircleCheck, CircuitBoard, Download, ExternalLink, HardDrive, Info,
  Loader2, Monitor, ScanSearch, ShieldCheck,
} from 'lucide-react';
import { api } from '../../api.js';
import { ScanIncomplete } from '../../components/ScanIncomplete.jsx';
import { AllGood } from '../../components/ScanSuccess.jsx';
import { ProgressPill } from '../../components/TaskProgress.jsx';
import { scanVerdict } from '../../domain/scan-verdict.mjs';
import { useT } from '../../i18n.js';
import { fmtGB, ltr, titleVersion } from '../../presentation/format.jsx';
import { classIcon } from '../hardware/devicePresentation.js';

export function UpdatesPage({ hw, wu, gpu, bios, sources, scan, soundKey, onScan, onInstall, onGpu, onBiosDownload, onGuide, onEnable, busy, prog }) {
  const t = useT();
  const loading = !!scan.running;
  const devByHwid = useMemo(() => {
    const m = new Map();
    for (const d of hw?.devices || []) if (d.hwid) m.set(d.hwid.toUpperCase(), d);
    return m;
  }, [hw]);
  const findDevice = (u) => {
    const h = (u.hwid || '').toUpperCase();
    return devByHwid.get(h) || (hw?.devices || []).find((d) => d.hwid && (d.hwid.toUpperCase().startsWith(h) || h.startsWith(d.hwid.toUpperCase())));
  };
  const gpuNewer = (gpu || []).filter((g) => g.newer && g.url);
  const biosNewer = bios?.supported && bios.newer && bios.latest?.url ? bios : null;
  const problems = hw?.problems || [];
  const total = (wu?.length || 0) + gpuNewer.length + (biosNewer ? 1 : 0);
  const verdict = scanVerdict({ running: loading, sources, total });
  const failedList = verdict.failed.map((k) => t(`src.${k}`)).join(', ');

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t('up.title')}</h1>
          <p className="subtitle">{hw ? `${hw.board} · ${hw.cpu.replace(/\(R\)|\(TM\)/g, '')} · ${hw.gpus.map((g) => g.name).join(', ')}` : t('up.scanningPc')}</p>
          <div className="scan-line">
            {loading ? (<>
              <span className="progress"><div style={{ width: `${Math.round((scan.step / scan.total) * 100)}%` }} /></span>
              <span>{t('up.step', { n: scan.step, total: scan.total, label: scan.label ? t(scan.label) : '' })}</span>
            </>) : scan.at ? <span>{t('up.lastScan', { time: new Date(scan.at).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' }) })}</span> : null}
          </div>
        </div>
        <button className="btn-primary" onClick={onScan} disabled={loading || !!busy} title={t('up.scanTitle')}>
          {loading ? <Loader2 size={14} className="spin" /> : <ScanSearch size={14} />} {t('up.scanNow')}
        </button>
      </header>
      <div className="stats tiled">
        <div className="stat"><i className="stat-tile"><HardDrive size={20} /></i><span>{t('up.stScanned')}</span><b>{hw ? hw.devices.length : '…'}</b></div>
        <div className="stat"><i className="stat-tile"><Download size={20} /></i><span>{t('up.stAvailable')}</span><b style={{ color: 'var(--accent)' }}>{loading ? '…' : total}</b></div>
        <div className="stat"><i className="stat-tile"><CircleCheck size={20} /></i><span>{t('up.stUpToDate')}</span><b>{hw && !loading ? hw.devices.length - (wu?.length || 0) : '…'}</b></div>
        <div className="stat"><i className="stat-tile"><CircleAlert size={20} /></i><span>{t('up.stAttention')}</span><b style={{ color: problems.length ? '#b45309' : undefined }}>{hw ? problems.length : '…'}</b></div>
      </div>
      <section className="panel">
        <div className="panel-title">{t('up.available')} {loading && <Loader2 size={15} className="spin" />}</div>
        {verdict.state === 'allGood' && <AllGood soundKey={soundKey} />}
        {verdict.state === 'incomplete' && <ScanIncomplete list={failedList} onScan={onScan} busy={busy} />}
        {verdict.state === 'updates' && verdict.failed.length > 0 && <div className="finding warn partial-scan"><AlertTriangle size={15} /><span>{t('up.partial', { list: failedList })}</span></div>}
        {biosNewer && (
          <div className="drow">
            <span className="dicon"><CircuitBoard size={17} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname"><bdi>BIOS · {biosNewer.model}</bdi><span className="src">{biosNewer.site} · {t('official')}</span></div>
              <div className="dmeta">{biosNewer.installed} {t('arrow')} <b>{biosNewer.latest.version}</b> · {biosNewer.latest.date} · {ltr(biosNewer.latest.size)} · {biosNewer.flash === 'windows' ? t('up.biosInstallWin', { maker: biosNewer.maker }) : t('up.biosInstallBios')}</div>
            </div>
            <div className="acts">
              {busy === 'bios' ? <ProgressPill p={prog.bios} fallback={t('prog.downloading')} /> : (<>
                <button className="btn-ghost" onClick={onGuide}><Info size={14} /> {t('up.howInstall')}</button>
                <button className="icon-btn accent" title={t('up.downloadOfficial')} onClick={onBiosDownload} disabled={!!busy}><Download size={15} /></button>
              </>)}
            </div>
          </div>
        )}
        {(wu || []).map((u) => {
          const dev = findDevice(u);
          const Icon = classIcon(u.cls, u.title);
          return (
            <div key={u.id} className="drow">
              <span className="dicon"><Icon size={17} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="dname"><bdi>{dev?.name || u.model || u.title}</bdi><span className="src">{t('up.signed')}</span></div>
                <div className="dmeta">{dev ? `${dev.version} ${t('arrow')} ` : ''}<b>{titleVersion(u.title) || u.date}</b> · {u.maker} · {fmtGB(u.size)}</div>
              </div>
              <div className="acts">
                {busy === u.id || busy === 'all' ? <ProgressPill p={busy === 'all' ? null : prog[busy]} fallback={t(busy === 'all' ? 'prog.updating' : 'prog.installing')} />
                  : <button className="icon-btn accent" title={t('up.updateOne')} onClick={() => onInstall([u])} disabled={!!busy}><Download size={15} /></button>}
              </div>
            </div>
          );
        })}
        {gpuNewer.map((g) => (
          <div key={g.gpu} className="drow">
            <span className="dicon"><Monitor size={17} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname"><bdi>{g.gpu}</bdi><span className="src">{g.vendor.toLowerCase()}.com · {t('official')}</span></div>
              <div className="dmeta">{g.package ? t('up.installedPkg', { pkg: `${g.vendor === 'AMD' ? 'AMD Software ' : ''}${g.package}` }) : t('up.installedDrv', { v: g.installed })} · {t('up.latestOnSite')} <b>{g.title || g.latest}</b>{g.size ? <> · {ltr(g.size)}</> : null}</div>
            </div>
            <div className="acts">
              {busy === g.gpu ? <ProgressPill p={prog[g.gpu]} fallback={t('prog.downloading')} />
                : <button className="btn-ghost" onClick={() => onGpu(g)} disabled={!!busy} title={t('up.downloadRunTitle')}><Download size={14} /> {t('up.downloadRun')}</button>}
            </div>
          </div>
        ))}
        {(gpu || []).filter((g) => g.vendor === 'Intel').map((g) => (
          <div key={g.gpu} className="drow">
            <span className="dicon"><Monitor size={17} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname"><bdi>{g.gpu}</bdi><span className="src">intel.com · {t('official')}</span></div>
              <div className="dmeta">{t('up.installedDrv', { v: g.installed })} · {t('up.intelNote')}</div>
            </div>
            <div className="acts"><button className="btn-ghost" onClick={() => api.openLink(g.page)}><ExternalLink size={14} /> {t('up.officialPage')}</button></div>
          </div>
        ))}
        {problems.length > 0 && <div className="panel-title" style={{ position: 'static' }}>{t('up.attention')}</div>}
        {problems.map((p) => {
          const Icon = classIcon('', p.name);
          return (
            <div key={p.id} className="drow">
              <span className="dicon warn"><Icon size={17} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="dname">{p.name}</div>
                <div className="dmeta">{p.code === 22 ? t('up.disabled') : p.code === 28 ? t('up.noDriver') : t('up.devError', { code: p.code })}</div>
              </div>
              <div className="acts">
                {busy === p.id ? <ProgressPill p={prog[p.id]} fallback={t('prog.enabling')} />
                  : p.code === 22 && <button className="btn-ghost" onClick={() => onEnable(p)} disabled={!!busy}>{t('up.enable')}</button>}
              </div>
            </div>
          );
        })}
      </section>
      <footer className="action-bar">
        <span className="muted save-where"><ShieldCheck size={14} style={{ verticalAlign: -3 }} /> {t('up.restoreNote')}</span>
        {busy === 'all' ? <ProgressPill p={prog.all} fallback={t('prog.installing')} /> : (
          <button className="btn-primary big" onClick={() => onInstall(wu || [])} disabled={!wu?.length || !!busy}>
            <Download size={15} /> {t('up.updateAll', { n: wu?.length || 0 })}
          </button>
        )}
      </footer>
    </>
  );
}
