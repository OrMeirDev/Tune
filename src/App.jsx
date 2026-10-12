import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SlidersHorizontal, RefreshCw, Cpu, Sparkles, Trash2, Rocket, Thermometer, Settings2, History, Settings, Home,
  ChevronLeft, ChevronRight, Download, Monitor, Wifi, Bluetooth, Network, Volume2, HardDrive, Usb, Camera, AlertTriangle, Check,
  Loader2, ShieldCheck, ExternalLink, Search, Undo2, RotateCcw, FolderOpen, FileSpreadsheet, FileText,
  CircuitBoard, ScanSearch, Info, X, Globe,
} from 'lucide-react';
import { LangContext, makeT, useT } from './i18n.js';

const api = window.tune;

const PAGES = [
  { group: 'nav.drivers' },
  { id: 'updates', icon: RefreshCw, key: 'nav.updates' },
  { id: 'hardware', icon: Cpu, key: 'nav.hardware' },
  { group: 'nav.optimize' },
  { id: 'overview', icon: Sparkles, key: 'nav.overview' },
  { id: 'clean', icon: Trash2, key: 'nav.clean' },
  { id: 'startup', icon: Rocket, key: 'nav.startup' },
  { id: 'perf', icon: Thermometer, key: 'nav.perf' },
  { id: 'recs', icon: Settings2, key: 'nav.recs' },
  { group: '' },
  { id: 'history', icon: History, key: 'nav.history' },
  { id: 'settings', icon: Settings, key: 'nav.settings' },
];

// Keeps "8.67 GB" in reading order inside Hebrew text (harmless in English).
const ltr = (s) => '⁦' + s + '⁩';
const fmtGB = (b) => ltr(b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
const fmtDate = (iso, t) => (iso ? new Date(iso).toLocaleString(t.locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
// Intel stamps some chipset drivers 1968-07-18 on purpose; it is not an old driver.
const shownDate = (d) => (!d || d.startsWith('1968') ? '—' : d);
const errText = (e, t) => ({
  cancelled: t('err.cancelled'),
  'admin session ended': t('err.adminEnded'),
  'checksum mismatch': t('err.checksum'),
  'signature check failed': t('err.signature'),
}[e] || t('err.generic', { e }));
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const tempClass = (c) => (c == null ? '' : c >= 85 ? 'temp-hot' : c >= 70 ? 'temp-warm' : 'temp-ok');
// "**bold**" inside a translated string.
const rich = (s) => String(s).split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
// A translated label when the key is known; otherwise the stored text (older history entries).
const tOr = (t, key, fallback) => { const s = t(key); return s === key ? fallback : s; };

// What a long job is doing right now: approval, restore point, download %, install %.
function ProgressPill({ p, fallback }) {
  const t = useT();
  const label = ['auth', 'restore', 'prepare', 'download', 'install', 'service', 'pawnio', 'start'].includes(p?.phase) ? t(`prog.${p.phase}`) : fallback;
  const pct = p && ['download', 'install'].includes(p.phase) && p.percent != null ? p.percent : null;
  return (
    <span className="pill prog-pill">
      <Loader2 size={13} className="spin" />
      {label}{pct != null ? ` ${pct}%` : p && ['download', 'install'].includes(p.phase) ? '…' : ''}
      {p?.count > 1 && p.index ? t('prog.ofN', { i: p.index, n: p.count }) : ''}
      {pct != null && <span className="mini-bar"><i style={{ width: `${pct}%` }} /></span>}
    </span>
  );
}

// BIOS can't be updated from Windows safely on most boards, so Tune downloads the verified file
// and explains the maker's own update tool.
function BiosGuide({ bios, onClose, onDownload, busy, prog }) {
  const t = useT();
  if (!bios) return null;
  const l = bios.latest;
  const m = { maker: bios.maker };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal guide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{t('guide.title', { model: bios.model })}</h2>
            <div className="dmeta">{t('guide.installed', { v: bios.installed, d: bios.installedDate })} {t('arrow')} {t('guide.available')} <b>{l.version}</b> ({l.date}) · {ltr(l.size)}</div>
          </div>
          <button className="icon-btn ghost" onClick={onClose} aria-label={t('close')}><X size={16} /></button>
        </div>
        <div className="guide-body">
          {l.notes && <><div className="setting-title">{t('guide.whatsNew', m)}</div><div className="notes" dir="ltr">{l.notes}</div></>}
          {bios.flash === 'windows' ? (<>
            <div className="setting-title">{t('guide.winTitle', m)}</div>
            <ol>{[1, 2, 3, 4, 5].map((i) => <li key={i}>{rich(t(`guide.win${i}`, m))}</li>)}</ol>
          </>) : (<>
            <div className="setting-title">{t('guide.ezTitle')}</div>
            <ol>{[1, 2, 3, 4, 5, 6].map((i) => <li key={i}>{rich(t(`guide.ez${i}`))}</li>)}</ol>
          </>)}
          <div className="warn-box"><AlertTriangle size={14} /> {t('guide.warn')}</div>
        </div>
        <div className="modal-actions">
          {busy ? <ProgressPill p={prog} fallback={t('prog.downloading')} />
            : <button className="btn-primary" onClick={onDownload}><Download size={14} /> {t('guide.download', { size: ltr(l.size) })}</button>}
          <button className="btn-ghost" onClick={() => api.openLink(bios.page)}><ExternalLink size={14} /> {t('guide.page')}</button>
        </div>
      </div>
    </div>
  );
}

// With the background service running nothing asks for approval; otherwise one approval covers
// 10 minutes, with a countdown and a way to end it early.
function AdminChip({ service, until, onStart, onStop, onInstall, busy }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until <= Date.now()) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (service?.running && service.current) {
    return <div className="admin-chip on" title={t('admin.serviceOnTitle')}><ShieldCheck size={14} /> {t('admin.serviceOn')}</div>;
  }
  if (service?.installed) {
    return <button className="admin-chip" onClick={onInstall} disabled={!!busy}><ShieldCheck size={14} /> {t(service.running ? 'admin.serviceUpdate' : 'admin.serviceStopped')}</button>;
  }
  const left = until - now;
  if (left > 0) {
    return (
      <div className="admin-chip on" title={t('admin.activeTitle')}>
        <ShieldCheck size={14} /> {t('admin.active', { t: mmss(left) })}
        <button onClick={onStop} disabled={!!busy}>{t('admin.end')}</button>
      </div>
    );
  }
  return (
    <>
      <button className="admin-chip" onClick={onStart} disabled={!!busy} title={t('admin.startTitle')}>
        <ShieldCheck size={14} /> {t('admin.start')}
      </button>
      <button className="admin-link" onClick={onInstall} disabled={!!busy} title={t('admin.installTitle')}>{t('admin.install')}</button>
    </>
  );
}

function classIcon(cls = '', name = '') {
  const s = `${cls} ${name}`.toUpperCase();
  if (/DISPLAY|RADEON|GEFORCE/.test(s)) return Monitor;
  if (/BLUETOOTH/.test(s)) return Bluetooth;
  if (/WI-?FI|WIRELESS|802\.11/.test(s)) return Wifi;
  if (/NET|ETHERNET|LAN/.test(s)) return Network;
  if (/MEDIA|AUDIO|SOUND/.test(s)) return Volume2;
  if (/CAMERA|IMAGE/.test(s)) return Camera;
  if (/USB/.test(s)) return Usb;
  if (/DISK|STORAGE|NVME|SCSI/.test(s)) return HardDrive;
  return Cpu;
}

// Pull the version out of a Windows Update driver title such as "Intel ... Update (24.70.0.4)".
const titleVersion = (s = '') => (s.match(/(\d+\.\d+(?:\.\d+){1,2})(?!.*\d+\.\d+)/) || [])[1] || null;

function Banner({ msg, onClose }) {
  const t = useT();
  if (!msg) return null;
  return (
    <div className={`banner ${msg.kind || 'info'}`}>
      {msg.kind === 'err' ? <AlertTriangle size={16} /> : <Check size={16} />}
      <span>{msg.text}</span>
      <button className="btn-ghost" onClick={onClose}>{t('close')}</button>
    </div>
  );
}

function UpdateBanner({ status }) {
  const t = useT();
  if (!status || !['available', 'downloading', 'ready'].includes(status.state)) return null;
  return (
    <div className="banner info">
      <Sparkles size={16} />
      <span>
        {status.state === 'available' && <>{t('upd.available')} <b>{status.version}</b></>}
        {status.state === 'downloading' && t('upd.downloading', { p: status.percent || 0 })}
        {status.state === 'ready' && t('upd.ready', { v: status.version })}
      </span>
      {status.state === 'available' && <button className="btn-primary" onClick={() => api.downloadAppUpdate()}><Download size={14} /> {t('upd.now')}</button>}
      {status.state === 'ready' && <button className="btn-primary" onClick={() => api.installAppUpdate()}><RefreshCw size={14} /> {t('upd.restart')}</button>}
    </div>
  );
}

// ---------------- driver updates ----------------

function UpdatesPage({ hw, wu, gpu, bios, scan, onScan, onInstall, onGpu, onBiosDownload, onGuide, onEnable, busy, prog }) {
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
      <div className="stats">
        <div className="stat"><span>{t('up.stScanned')}</span><b>{hw ? hw.devices.length : '…'}</b></div>
        <div className="stat"><span>{t('up.stAvailable')}</span><b style={{ color: 'var(--accent)' }}>{loading ? '…' : total}</b></div>
        <div className="stat"><span>{t('up.stUpToDate')}</span><b>{hw && !loading ? hw.devices.length - (wu?.length || 0) : '…'}</b></div>
        <div className="stat"><span>{t('up.stAttention')}</span><b style={{ color: problems.length ? '#b45309' : undefined }}>{hw ? problems.length : '…'}</b></div>
      </div>
      <section className="panel">
        <div className="panel-title">{t('up.available')} {loading && <Loader2 size={15} className="spin" />}</div>
        {!loading && total === 0 && <div className="center-msg"><Check size={18} /> {t('up.allGood')}</div>}
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

function HardwarePage({ hw, onExport }) {
  const t = useT();
  const [q, setQ] = useState('');
  const list = useMemo(() => (hw?.devices || [])
    .filter((d) => !/^(Microsoft|\(Standard)/.test(d.provider || '') || q)
    .filter((d) => !q || `${d.name} ${d.provider} ${d.cls}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.cls || '').localeCompare(b.cls || '')), [hw, q]);
  return (
    <>
      <header className="page-header">
        <div><h1>{t('hw.title')}</h1><p className="subtitle">{hw ? t('hw.subtitle', { computer: hw.computer, v: hw.bios.version, d: hw.bios.date, ram: hw.ramGB }) : t('scanning')}</p></div>
        <div className="header-actions">
          <button className="btn-ghost" disabled={!hw} onClick={() => onExport('csv')} title={t('hw.exportExcelTitle')}><FileSpreadsheet size={14} /> {t('hw.exportExcel')}</button>
          <button className="btn-ghost" disabled={!hw} onClick={() => onExport('txt')} title={t('hw.exportTextTitle')}><FileText size={14} /> {t('hw.exportText')}</button>
        </div>
      </header>
      <label className="search"><Search size={16} /><input placeholder={t('hw.search')} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <section className="panel">
        <div className="panel-title">{q ? t('hw.results', { n: list.length }) : t('hw.count', { n: list.length })}</div>
        {list.map((d) => {
          const Icon = classIcon(d.cls, d.name);
          return (
            <div key={d.id} className="drow">
              <span className="dicon"><Icon size={17} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="dname">{d.name}</div>
                <div className="dmeta"><bdi dir="ltr">{d.version}</bdi> · {shownDate(d.date)} · {d.provider || d.maker}</div>
              </div>
              <span className="src">{d.cls || t('hw.other')}</span>
            </div>
          );
        })}
      </section>
    </>
  );
}

// ---------------- optimization ----------------

// Recommendations arrive as data; their wording lives in the dictionary.
const recTitle = (r, t) => t(`rec.${r.key}.title`);
const planName = (r, t) => (['balanced', 'high', 'ultimate', 'saver'].includes(r.plan) ? t(`plan.${r.plan}`) : r.value);
const recValue = (r, t) => ({
  // Off the recommended plan, say which one is recommended right next to the current one.
  power: planName(r, t) + (r.ok === false ? ` · ${t('rec.power.recommended', { plan: t('plan.balanced') })}` : ''),
  gamemode: t(r.on ? 'on' : 'off'),
  hags: t(r.on ? 'on' : 'off'),
  disk: t('rec.disk.value', { free: r.freeGB, size: r.sizeGB }),
  bios: `${r.version} (${r.date})`,
}[r.key] ?? '');
// A short "why" for every recommendation...
const recNote = (r, t) => (r.key === 'bios' ? t(r.intel1314 ? 'rec.bios.note1314' : 'rec.bios.note')
  : r.key === 'power' ? t(`rec.power.why.${r.cpuKind || 'other'}`) : t(`rec.${r.key}.note`));
// ...and, when it isn't met, what happens if it stays that way.
function recIf(r, t) {
  if (r.key === 'bios') return t(r.intel1314 ? 'rec.bios.if1314' : 'rec.bios.if');
  if (r.key !== 'power') return t(`rec.${r.key}.if`);
  if (r.plan === 'saver') return t('rec.power.if.saver');
  if (r.plan === 'custom') return t('rec.power.if.custom');
  return t('rec.power.if.fast') + (r.cpuKind === 'intelHybrid' ? t('rec.power.if.hybrid') : r.cpuKind === 'amdX3D' ? t('rec.power.if.x3d') : '');
}

function OverviewPage({ junk, startup, perf, recs, go }) {
  const t = useT();
  const junkTotal = (junk || []).reduce((s, c) => s + c.bytes, 0);
  const startOn = (startup || []).filter((s) => s.enabled).length;
  const toImprove = (recs || []).filter((r) => r.ok === false).length;
  return (
    <>
      <header className="page-header"><div><h1>{t('ov.title')}</h1><p className="subtitle">{t('ov.subtitle')}</p></div></header>
      <div className="grid2">
        <div className="ocard">
          <div className="ohead"><span><Trash2 size={16} /> {t('ov.clean')}</span><b style={{ color: 'var(--accent)' }}>{junk ? fmtGB(junkTotal) : '…'}</b></div>
          {(junk || []).filter((c) => c.bytes > 1e6).slice(0, 4).map((c) => <div key={c.key} className="orow"><span>{t(`junk.${c.key}`)}</span><span>{fmtGB(c.bytes)}</span></div>)}
          <div className="ofoot"><span /><button className="btn-primary" onClick={() => go('clean')}>{t('ov.toClean')}</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Rocket size={16} /> {t('ov.startup')}</span><span className="muted">{startup ? t('ov.activeOf', { n: startOn, total: startup.length }) : '…'}</span></div>
          {(startup || []).filter((s) => s.enabled).slice(0, 4).map((s) => <div key={s.source + s.key} className="orow"><span>{s.name}</span><span className="ok-text">{t('ov.active')}</span></div>)}
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('startup')}>{t('ov.allList')}</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Thermometer size={16} /> {t('ov.perf')}</span></div>
          {perf ? (<>
            <div className="orow"><span>{t('ov.cpuLoad')}</span><span>{perf.cpuLoad}%</span></div>
            <div className="orow"><span>{t('ov.ramUsed')}</span><span>{ltr(`${(perf.ramTotalGB - perf.ramFreeGB).toFixed(1)} / ${perf.ramTotalGB} GB`)}</span></div>
            {[].concat(perf.gpuTemps || []).slice(0, 1).map((g) => <div key={g.name} className="orow"><span>{t('ov.gpuTemp')}</span><span className={tempClass(g.tempC)}>{ltr(`${g.tempC}°C`)}</span></div>)}
            <div className="orow"><span>{t('ov.topRam')}</span><span className="note">{[].concat(perf.topRam).slice(0, 2).map((p) => p.name).join(', ')}</span></div>
          </>) : <div className="center-msg"><Loader2 size={16} className="spin" /></div>}
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('perf')}>{t('ov.details')}</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Settings2 size={16} /> {t('ov.recs')}</span><span className="muted">{recs ? (toImprove ? t('ov.toImprove', { n: toImprove }) : t('ov.allOk')) : '…'}</span></div>
          {(recs || []).slice(0, 4).map((r) => (
            <div key={r.key} className="orow"><span>{recTitle(r, t)}</span>{r.ok === true ? <span className="ok-text">{t('ok')}</span> : r.ok === false ? <span className="warn-text">{t('improve')}</span> : <span className="note">{t('toCheck')}</span>}</div>
          ))}
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('recs')}>{t('ov.allRecs')}</button></div>
        </div>
      </div>
    </>
  );
}

function CleanPage({ junk, onRescan, onClean, busy }) {
  const t = useT();
  const [sel, setSel] = useState({});
  useEffect(() => { if (junk) setSel(Object.fromEntries(junk.map((c) => [c.key, c.bytes > 0]))); }, [junk]);
  const chosen = (junk || []).filter((c) => sel[c.key] && c.bytes > 0);
  const total = chosen.reduce((s, c) => s + c.bytes, 0);
  return (
    <>
      <header className="page-header">
        <div><h1>{t('cl.title')}</h1><p className="subtitle">{t('cl.subtitle')}</p></div>
        <button className="btn-ghost" onClick={onRescan} disabled={!!busy}><RefreshCw size={14} /> {t('cl.rescan')}</button>
      </header>
      <section className="panel">
        <div className="panel-title">{junk ? t('cl.found', { size: fmtGB((junk || []).reduce((s, c) => s + c.bytes, 0)) }) : t('scanning')}</div>
        {(junk || []).map((c) => {
          const dirs = [].concat(c.dirs || []);
          const label = t(`junk.${c.key}`);
          // Several folders (one per browser, several crash-report folders): one small link each.
          const dirName = (d) => (/Chrome/i.test(d) ? 'Chrome' : /Edge/i.test(d) ? 'Edge' : /Brave/i.test(d) ? 'Brave' : d.split('\\').pop());
          const open = (e, d) => { e.stopPropagation(); api.openFolder(d); };
          const toggle = () => c.bytes && setSel((s) => ({ ...s, [c.key]: !s[c.key] }));
          return (
            <div key={c.key} className="drow" style={{ cursor: c.bytes ? 'pointer' : 'default' }} onClick={toggle}>
              <span className="dicon"><Trash2 size={16} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="dname">
                  {dirs.length === 1
                    ? <button className="folder-link" title={t('cl.openFolder', { dir: dirs[0] })} onClick={(e) => open(e, dirs[0])}>{label} <FolderOpen size={13} /></button>
                    : label}
                  {dirs.length > 1 && <span className="dir-chips">{dirs.map((d) => <button key={d} className="dir-chip" title={d} onClick={(e) => open(e, d)}><FolderOpen size={11} /> {dirName(d)}</button>)}</span>}
                </div>
                <div className="dmeta">{t('cl.files', { n: c.files.toLocaleString(t.locale) })}{c.minAgeHours ? t('cl.olderDay') : ''}{c.admin ? t('cl.needsAdmin') : ''}</div>
              </div>
              <div className="acts"><b>{fmtGB(c.bytes)}</b><input type="checkbox" checked={!!sel[c.key]} disabled={!c.bytes} onClick={(e) => e.stopPropagation()} onChange={(e) => setSel((s) => ({ ...s, [c.key]: e.target.checked }))} /></div>
            </div>
          );
        })}
      </section>
      <footer className="action-bar">
        <span className="muted save-where">{t('cl.permanent')}</span>
        <button className="btn-primary big" disabled={!total || !!busy} onClick={() => window.confirm(t('cl.confirm', { size: fmtGB(total) })) && onClean(chosen)}>
          {busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} {t('cl.clean', { size: total ? fmtGB(total) : '' })}
        </button>
      </footer>
    </>
  );
}

function StartupPage({ startup, onToggle, busy, prog }) {
  const t = useT();
  return (
    <>
      <header className="page-header"><div><h1>{t('st.title')}</h1><p className="subtitle">{t('st.subtitle')}</p></div></header>
      <section className="panel">
        <div className="panel-title">{startup ? t('ov.activeOf', { n: startup.filter((s) => s.enabled).length, total: startup.length }) : t('loading')}</div>
        {(startup || []).map((s) => (
          <div key={s.source + s.key} className="drow">
            <span className="dicon"><Rocket size={16} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname">{s.name}</div>
              <div className="dmeta path-text" dir="ltr">{s.cmd}</div>
            </div>
            <div className="acts">
              {s.admin && <span className="src">{t('st.admin')}</span>}
              {busy === s.source + s.key ? <ProgressPill p={prog[busy]} fallback={t('prog.changing')} />
                : <button className={`toggle ${s.enabled ? 'on' : ''}`} aria-label={t(s.enabled ? 'st.turnOff' : 'st.turnOn')} disabled={!!busy} onClick={() => onToggle(s, !s.enabled)} />}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

// Why a sensor has no reading yet, in the user's terms.
const cpuNoteKey = (n) => ({ 'no service': 'cpuNote.noService', 'pawnio not installed': 'cpuNote.pawnio', 'cpu not supported yet': 'cpuNote.unsupported' }[n] || 'cpuNote.unavailable');
const rpm = (n, t) => ltr(`${Number(n).toLocaleString(t.locale)} RPM`);

// "Why is my PC hot?": a plain-language finding from the CPU reading.
// At rest a CPU usually sits around 30–50°C; warmer than that at idle is worth explaining.
function coolingFindings(p, t) {
  if (p.cpuTempC == null) return [];
  const idle = p.cpuLoad < 20;
  if (idle && p.cpuTempC >= 55) return [{ level: 'warn', text: t(p.cpuTempC >= 70 ? 'fd.cpuHot' : 'fd.cpuWarm', { t: p.cpuTempC }), tips: t('fd.tipCpu') }];
  return [{ level: 'ok', text: t('fd.ok') }];
}

function PerfPage({ perf, onRefresh, onInstallService, busy }) {
  const t = useT();
  const findings = perf ? coolingFindings(perf, t) : [];
  const gpu = [].concat(perf?.gpuTemps || [])[0];
  return (
    <>
      <header className="page-header">
        <div><h1>{t('pf.title')}</h1><p className="subtitle">{t('pf.subtitle')}</p></div>
        <button className="btn-ghost" onClick={onRefresh}><RefreshCw size={14} /> {t('pf.refresh')}</button>
      </header>
      {!perf ? <div className="center-msg"><Loader2 size={16} className="spin" /></div> : (<>
        <div className="stats three">
          <div className="stat"><span>{t('pf.cpuLoad')}</span><b>{perf.cpuLoad}%</b></div>
          <div className="stat"><span>{t('pf.ramUsed')}</span><b>{ltr(`${(perf.ramTotalGB - perf.ramFreeGB).toFixed(1)} GB`)}</b></div>
          <div className="stat"><span>{t('pf.ramFree')}</span><b>{ltr(`${perf.ramFreeGB} GB`)}</b></div>
        </div>
        <div className="stats two">
          <div className="stat" title={t('pf.cpuTempTitle')}>
            <span><Cpu size={13} /> {t('pf.cpuTemp')}</span>
            {perf.cpuTempC == null ? (<>
              <b className="na">—</b>
              <small>{t(cpuNoteKey(perf.cpuNote))}{perf.cpuNote === 'no service' && <> · <button className="link-btn" onClick={onInstallService} disabled={!!busy}>{t('pf.install')}</button></>}</small>
            </>) : <b className={tempClass(perf.cpuTempC)}>{ltr(`${perf.cpuTempC}°C`)}</b>}
          </div>
          <div className="stat" title={gpu?.name || ''}>
            <span><Monitor size={13} /> {t('pf.gpuTemp')}</span>
            {gpu ? (<>
              <b className={tempClass(gpu.tempC)}>{ltr(`${gpu.tempC}°C`)}</b>
              <small>{[gpu.hotspotC ? t('pf.hotspot', { t: ltr(`${gpu.hotspotC}°C`) }) : null, gpu.fanRpm ? t('pf.fan', { rpm: rpm(gpu.fanRpm, t) }) : null].filter(Boolean).join(' · ') || gpu.name}</small>
            </>) : <><b className="na">—</b><small>{t('pf.gpuNone')}</small></>}
          </div>
        </div>
        {findings.map((f) => (
          <div key={f.text} className={`finding ${f.level}`}>
            {f.level === 'ok' ? <Check size={15} /> : <AlertTriangle size={15} />}
            <div><b>{f.text}</b>{f.tips && <div>{f.tips}</div>}</div>
          </div>
        ))}
        <div className="grid2">
          <div className="ocard"><div className="ohead"><span><Cpu size={16} /> {t('pf.topCpu')}</span></div>
            {[].concat(perf.topCpu).map((p) => <div key={p.name} className="orow"><span>{p.name}{p.count > 1 ? ` (${p.count})` : ''}</span><span>{p.cpu}%</span></div>)}</div>
          <div className="ocard"><div className="ohead"><span><HardDrive size={16} /> {t('pf.topRam')}</span></div>
            {[].concat(perf.topRam).map((p) => <div key={p.name} className="orow"><span>{p.name}{p.count > 1 ? ` (${p.count})` : ''}</span><span>{ltr(`${(p.ramMB / 1024).toFixed(1)} GB`)}</span></div>)}</div>
        </div>
      </>)}
    </>
  );
}

function RecsPage({ recs, bios, onApply, onBiosDownload, onGuide, busy, prog }) {
  const t = useT();
  return (
    <>
      <header className="page-header"><div><h1>{t('rc.title')}</h1><p className="subtitle">{t('rc.subtitle')}</p></div></header>
      <section className="panel">
        {(recs || []).map((r) => {
          // BIOS: checked against the maker's site, so its status comes from the BIOS check.
          const isBios = r.key === 'bios';
          const ok = isBios ? (bios?.supported ? !bios.newer : null) : r.ok;
          const note = isBios && bios?.supported
            ? (bios.newer ? `${t('rc.biosNewer', { v: bios.latest.version, maker: bios.maker, date: bios.latest.date })} ${recNote(r, t)}` : t('rc.biosLatest', { maker: bios.maker }))
            : recNote(r, t);
          return (
            <div key={r.key} className="drow">
              <span className={`dicon ${ok === false ? 'warn' : ''}`}>{ok === false ? <AlertTriangle size={16} /> : <Check size={16} />}</span>
              <div style={{ minWidth: 0 }}>
                <div className="dname">{recTitle(r, t)} · <span style={{ fontWeight: 400 }}>{String(recValue(r, t)).replace(/\(?\d[\d.,:/-]*\)?(?:\s?(?:GB|MB))?/g, (m) => ltr(m))}</span></div>
                <div className="dmeta" style={{ whiteSpace: 'normal' }}>{note}</div>
                {ok === false && <div className="dmeta if-not">{recIf(r, t)}</div>}
              </div>
              <div className="acts">
                {ok === true && <span className="ok-text">{t('ok')}</span>}
                {isBios && bios?.supported && bios.newer && (busy === 'bios' ? <ProgressPill p={prog.bios} fallback={t('prog.downloading')} /> : (<>
                  <button className="btn-ghost" onClick={onGuide}><Info size={14} /> {t('up.howInstall')}</button>
                  <button className="btn-primary" disabled={!!busy} onClick={onBiosDownload}><Download size={14} /> {t('rc.download')}</button>
                </>))}
                {isBios && !bios && <Loader2 size={15} className="spin" />}
                {isBios && bios && !bios.supported && <button className="btn-ghost" onClick={() => api.openLink(bios.page || r.link)}><ExternalLink size={14} /> {t('rc.searchMaker')}</button>}
                {r.action && !isBios && (busy === r.key ? <ProgressPill p={prog[r.key]} fallback={t('prog.applying')} />
                  : <button className="btn-primary" disabled={!!busy} onClick={() => onApply(r)}>{t(r.key === 'power' ? 'rc.applyPlan' : 'rc.apply')}</button>)}
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}

function HistoryPage({ busy, onRestorePoint }) {
  const t = useT();
  const [items, setItems] = useState([]);
  // Skip anything that isn't a Tune entry, so one malformed line can't take the whole page down.
  useEffect(() => { api.getHistory().then((list) => setItems([].concat(list || []).filter((h) => h && h.action && h.detail))); }, [busy]);
  const describe = (h) => {
    const d = h.detail;
    switch (h.action) {
      case 'drivers': return t('h.drivers', { items: (d.items || []).join(', ') }) + (d.reboot ? t('h.reboot') : '');
      case 'gpu': return t('h.gpu', { file: d.file });
      case 'bios': return t('h.bios', { v: d.version, file: d.file });
      case 'service': return t(!d.installed ? 'h.serviceOut' : d.pawnio === 'installed' ? 'h.serviceInPawn' : 'h.serviceIn');
      case 'enable': return t('h.enable', { name: d.name });
      // Newer entries store category keys; older ones stored the Hebrew label itself.
      case 'clean': return t('h.clean', { size: fmtGB(d.freed || 0), cats: (d.cats || []).map((c) => tOr(t, `junk.${c}`, c)).join(', ') });
      case 'startup': return t(d.enabled ? 'h.startupOn' : 'h.startupOff', { name: d.name });
      case 'setting': return t('h.setting', { title: d.key ? t(`rec.${d.key}.title`) : d.title });
      case 'restore': return t('h.restore');
      default: return h.action;
    }
  };
  return (
    <>
      <header className="page-header">
        <div><h1>{t('hs.title')}</h1><p className="subtitle">{t('hs.subtitle')}</p></div>
        <div className="header-actions">
          <button className="btn-ghost" onClick={onRestorePoint} disabled={!!busy}><ShieldCheck size={14} /> {t('hs.createRp')}</button>
          <button className="btn-ghost" onClick={() => api.openSystemRestore()}><Undo2 size={14} /> {t('hs.restoreRp')}</button>
        </div>
      </header>
      <section className="panel">
        {items.length === 0 && <div className="center-msg">{t('hs.empty')}</div>}
        {items.map((h, i) => (
          <div key={i} className="drow">
            <span className="dicon"><RotateCcw size={16} /></span>
            <div style={{ minWidth: 0 }}><div className="dname" style={{ whiteSpace: 'normal' }}>{describe(h)}</div><div className="dmeta">{fmtDate(h.at, t)}</div></div>
            <span />
          </div>
        ))}
      </section>
    </>
  );
}

function SettingsPage({ version, status, onCheck, settings, onPickDir, onLang, service, onInstallService, onRemoveService, busy, prog }) {
  const t = useT();
  const svcText = !service ? t('se.svc.checking')
    : service.running ? `${t('se.svc.running')}${service.current ? '' : t('se.svc.outdated')} · ${service.pawnio ? t('se.svc.pawnOk', { v: service.pawnio }) : t('se.svc.pawnMissing')}`
      : t(service.installed ? 'se.svc.stopped' : 'se.svc.none');
  const known = ['checking', 'none', 'available', 'downloading', 'ready', 'error', 'dev'];
  const msg = known.includes(status?.state) ? t(`se.upd.${status.state}`, { v: status.version, p: status.percent || 0 }) : t('se.upd.idle');
  return (
    <>
      <header className="page-header"><div><h1>{t('se.title')}</h1></div></header>
      <section className="card settings">
        <div className="setting">
          <div><div className="setting-title"><Globe size={15} style={{ verticalAlign: -2 }} /> {t('se.language')}</div><div className="row-meta">{t('se.languageNote')}</div></div>
          {/* Each language is named in itself, so it can be found from either one. */}
          <div className="segmented">
            <button className={t.lang === 'en' ? 'on' : ''} onClick={() => onLang('en')}>English</button>
            <button className={t.lang === 'he' ? 'on' : ''} onClick={() => onLang('he')}>עברית</button>
          </div>
        </div>
        <div className="setting">
          <div><div className="setting-title">{t('se.updates')}</div><div className="row-meta">{t('se.versionLine', { v: version || '…', msg })}</div></div>
          <button className="btn-ghost" onClick={onCheck}><RefreshCw size={14} /> {t('se.check')}</button>
        </div>
        <div className="setting">
          <div><div className="setting-title">{t('se.saveDir')}</div><div className="row-meta path-text" dir="ltr">{settings?.saveDir || '…'}</div><div className="row-meta">{t('se.saveDirNote')}</div></div>
          <button className="btn-ghost" onClick={onPickDir}><FolderOpen size={14} /> {t('se.change')}</button>
        </div>
        <div className="setting">
          <div>
            <div className="setting-title">{t('se.service', { status: svcText })}</div>
            <div className="row-meta">{t('se.serviceNote')}</div>
            {!service?.running && <div className="row-meta">{t('se.noService')}</div>}
          </div>
          <div className="header-actions">
            {busy === 'service' ? <ProgressPill p={prog.service} fallback={t('prog.working')} /> : (<>
              {(!service?.running || !service.current) && <button className="btn-primary" onClick={onInstallService} disabled={!!busy}><ShieldCheck size={14} /> {t(service?.installed ? 'se.installUpdate' : 'se.install')}</button>}
              {service?.installed && <button className="btn-ghost" onClick={onRemoveService} disabled={!!busy}>{t('se.remove')}</button>}
            </>)}
          </div>
        </div>
        <div className="setting">
          <div><div className="setting-title">{t('se.sources')}</div><div className="row-meta">{t('se.sourcesNote')}</div></div>
        </div>
        <div className="setting">
          <div><div className="setting-title">{t('se.safety')}</div><div className="row-meta">{t('se.safetyNote')}</div></div>
        </div>
      </section>
    </>
  );
}

// ---------------- shell ----------------

export default function App() {
  const [page, setPage] = useState('updates');
  const [hw, setHw] = useState(null);
  const [wu, setWu] = useState(null);
  const [gpu, setGpu] = useState(null);
  const [bios, setBios] = useState(null);
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
  const [settings, setSettings] = useState(null);
  const [service, setService] = useState(null);
  // English until the saved choice is read; a first launch stays English.
  const t = useMemo(() => makeT(settings?.lang || 'en'), [settings?.lang]);

  useEffect(() => {
    document.documentElement.lang = t.lang;
    document.documentElement.dir = t.lang === 'he' ? 'rtl' : 'ltr';
  }, [t]);

  const loadService = useCallback(async () => setService(await api.serviceStatus()), []);
  const loadJunk = useCallback(async () => { setJunk(null); const r = await api.junkScan(); setJunk(r.ok ? [].concat(r.data) : []); }, []);
  const loadStartup = useCallback(async () => { const r = await api.startupList(); setStartup(r.ok ? [].concat(r.data || []) : []); }, []);
  const loadPerf = useCallback(async () => { const r = await api.performance(); if (r.ok) setPerf(r.data); }, []);
  const loadRecs = useCallback(async () => { const r = await api.recommendations(); setRecs(r.ok ? [].concat(r.data) : []); }, []);

  // Drivers only: after an install, to refresh what is still offered.
  const scanDrivers = useCallback(async () => {
    const h = await api.scanHardware();
    if (h.ok) setHw(h.data);
    const w = await api.driverUpdates();
    setWu(w.ok ? [].concat(w.data || []) : []);
  }, []);

  // Full scan: components, then every update source at once, then the optimization pages.
  // Step labels are dictionary keys, so they follow a language change mid-scan.
  const fullScan = useCallback(async () => {
    const step = (n, label) => setScan((s) => ({ ...s, running: true, step: n, label }));
    step(1, 'scan.s1');
    const h = await api.scanHardware();
    if (h.ok) setHw(h.data);
    step(2, 'scan.s2');
    const board = h.ok ? { maker: h.data.boardMaker, model: h.data.boardModel, version: h.data.bios.version, date: h.data.bios.date, systemMaker: h.data.systemMaker, systemModel: h.data.systemModel, systemSku: h.data.systemSku } : null;
    const [w, g, b] = await Promise.all([
      api.driverUpdates(),
      h.ok ? api.gpuCheck(h.data.gpus, h.data.amdSoftware) : Promise.resolve({ ok: false }),
      board ? api.biosCheck(board) : Promise.resolve({ ok: false }),
    ]);
    setWu(w.ok ? [].concat(w.data || []) : []);
    if (!w.ok) setMsg({ kind: 'err', key: 'msg.wuFailed', vars: { e: w.error } });
    setGpu(g.ok ? [].concat(g.data || []) : []);
    setBios(b.ok ? b.data : { supported: false, page: null });
    step(3, 'scan.s3');
    await Promise.all([loadJunk(), loadStartup(), loadRecs(), loadPerf()]);
    setScan((s) => ({ ...s, running: false, at: Date.now() }));
  }, [loadJunk, loadStartup, loadRecs, loadPerf]);

  useEffect(() => {
    if (!api) return undefined;
    api.appVersion().then(setVersion);
    api.getSettings().then(setSettings);
    api.adminStatus().then(setAdminUntil);
    loadService();
    const offUpdate = api.onAppUpdate(setAppUpdate);
    const offProgress = api.onProgress((p) => setProg((m) => ({ ...m, [p.key]: p })));
    fullScan();
    return () => { offUpdate(); offProgress(); };
  }, [fullScan, loadService]);

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
          <div className="brand"><span>Tune</span><SlidersHorizontal size={24} strokeWidth={2.4} className="brand-icon" /></div>
          <nav>
            {PAGES.map((p, i) => (p.group !== undefined
              ? <div key={`g${i}`} className="nav-group">{p.group ? t(p.group) : ''}</div>
              : (
                <button key={p.id} className={`nav-item ${page === p.id ? 'active' : ''}`} onClick={() => setPage(p.id)}>
                  <span>{t(p.key)}</span>
                  {p.id === 'updates' && updatesCount > 0 && <span className="nav-badge">{updatesCount}</span>}
                  <p.icon size={18} />
                </button>
              )))}
          </nav>
          <div className="sidebar-footer">
            <AdminChip service={service} until={adminUntil} onStart={adminStart} onStop={adminStop} onInstall={installService} busy={busy} />
            <div><span className={`dot ${scan.running ? 'dot-off' : ''}`} /> {scan.running ? t('scanning') : t('sb.done')}</div>
            <div className="muted">{t('version', { v: version || '…' })}</div>
          </div>
        </aside>
        <main className="main">
          <div className="breadcrumbs"><Home size={15} /> <Crumb size={13} /> <span>{t(PAGES.find((p) => p.id === page)?.key || '')}</span></div>
          <UpdateBanner status={appUpdate} />
          <Banner msg={shownMsg} onClose={() => setMsg(null)} />
          {page === 'updates' && <UpdatesPage hw={hw} wu={wu} gpu={gpu} bios={bios} scan={scan} onScan={fullScan} onInstall={installDrivers} onGpu={gpuInstall} onBiosDownload={biosDownload} onGuide={() => setGuide(true)} onEnable={enable} busy={busy} prog={prog} />}
          {page === 'hardware' && <HardwarePage hw={hw} onExport={exportHw} />}
          {page === 'overview' && <OverviewPage junk={junk} startup={startup} perf={perf} recs={recs} go={setPage} />}
          {page === 'clean' && <CleanPage junk={junk} onRescan={loadJunk} onClean={clean} busy={busy} />}
          {page === 'startup' && <StartupPage startup={startup} onToggle={toggle} busy={busy} prog={prog} />}
          {page === 'perf' && <PerfPage perf={perf} onRefresh={() => { setPerf(null); loadPerf(); }} onInstallService={installService} busy={busy} />}
          {page === 'recs' && <RecsPage recs={recs} bios={bios} onApply={apply} onBiosDownload={biosDownload} onGuide={() => setGuide(true)} busy={busy} prog={prog} />}
          {page === 'history' && <HistoryPage busy={busy} onRestorePoint={restorePoint} />}
          {page === 'settings' && <SettingsPage version={version} status={appUpdate} settings={settings} onLang={setLang} service={service} onInstallService={installService} onRemoveService={removeService} busy={busy} prog={prog} onPickDir={async () => setSettings(await api.pickSaveDir())} onCheck={async () => { setAppUpdate({ state: 'checking' }); if (!(await api.checkAppUpdate())) setAppUpdate({ state: 'dev' }); }} />}
        </main>
        {guide && bios?.latest && <BiosGuide bios={bios} onClose={() => setGuide(false)} onDownload={biosDownload} busy={busy === 'bios'} prog={prog.bios} />}
      </div>
    </LangContext.Provider>
  );
}
