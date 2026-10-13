import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SlidersHorizontal, RefreshCw, Cpu, Sparkles, Trash2, Rocket, Thermometer, Settings2, History, Settings, Home,
  ChevronLeft, ChevronRight, Download, Monitor, Wifi, Bluetooth, Network, Volume2, HardDrive, Usb, Camera, AlertTriangle, Check,
  Loader2, ShieldCheck, ExternalLink, Search, Undo2, RotateCcw, FolderOpen, FileSpreadsheet, FileText,
  CircuitBoard, ScanSearch, Info, X, Globe, MemoryStick, Gauge, Zap, Activity, BookOpen,
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

// The success sound (public/sounds/check-premium.mp3, 0.7 s, loudest about 0.12 s in).
function playChime() {
  try {
    const a = new Audio('sounds/check-premium.mp3');
    a.volume = 0.8;
    a.play().catch(() => {});
  } catch { /* no audio device: the animation is enough */ }
}

// "Everything is up to date": the ring draws itself, fills green, the check is written in one
// stroke, then a pop, a ripple and a few sparks. The sound plays once per finished scan, timed to
// the check (soundKey is the scan's time, or null for no sound).
let lastChime = null;
function AllGood({ soundKey }) {
  const t = useT();
  useEffect(() => {
    if (!soundKey || soundKey === lastChime) return undefined;
    lastChime = soundKey;
    const timer = setTimeout(playChime, 900);
    return () => clearTimeout(timer);
  }, [soundKey]);
  return (
    <div className="all-good" role="status">
      <div className="ag-stage">
        <span className="ag-wave" />
        <span className="ag-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--a': `${i * 30}deg`, '--d': `${(i % 3) * 50}ms` }} />)}</span>
        <svg className="ag-mark" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="ag-ring" cx="60" cy="60" r="50" />
          <path className="ag-check" d="M38 62 L53 77 L84 45" />
        </svg>
      </div>
      <div className="ag-title">{t('up.allGoodTitle')}</div>
      <div className="ag-sub">{t('up.allGood')}</div>
    </div>
  );
}

function UpdatesPage({ hw, wu, gpu, bios, scan, soundKey, onScan, onInstall, onGpu, onBiosDownload, onGuide, onEnable, busy, prog }) {
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
        {!loading && total === 0 && <AllGood soundKey={soundKey} />}
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
  microcode: r.hex,
  powerLimit: r.powerW != null ? t('rec.powerLimit.value', { w: r.powerW, t: r.tempC ?? '—' }) : '',
  memChannels: r.channels == null ? t('rec.memChannels.unknown') : t(r.channels >= 2 ? 'rec.memChannels.dual' : r.sticks > 1 ? 'rec.memChannels.sameOne' : 'rec.memChannels.one', { n: r.sticks }),
  memSpeed: r.rated ? t('rec.memSpeed.value', { now: r.configured, rated: r.rated }) : `${r.configured} MT/s`,
  trim: t(r.on ? 'on' : 'off'),
  gpuDriver: t(r.ok ? 'rec.gpuDriver.latest' : 'rec.gpuDriver.newer', { v: r.latest }),
  junk: fmtGB(r.bytes),
  startup: t('rec.startup.value', { n: r.n }),
}[r.key] ?? '');
// A short "why" for every recommendation...
const recNote = (r, t) => (r.key === 'bios' ? t(r.intel1314 ? 'rec.bios.note1314' : 'rec.bios.note')
  : r.key === 'power' ? t(`rec.power.why.${r.cpuKind || 'other'}`)
    : r.key === 'powerLimit' ? t(r.cpuKind === 'intelHybrid' ? 'rec.powerLimit.noteIntel' : 'rec.powerLimit.noteAmd')
      : r.key === 'memSpeed' ? t('rec.memSpeed.note', { profile: r.profile })
        : r.key === 'memChannels' && r.sticks === 1 ? t('rec.memChannels.noteOne') : t(`rec.${r.key}.note`));
// ...and, when it isn't met, what happens if it stays that way.
function recIf(r, t) {
  if (r.key === 'bios') return t(r.intel1314 ? 'rec.bios.if1314' : 'rec.bios.if');
  if (r.key === 'powerLimit') return t('rec.powerLimit.if', { t: r.tempC });
  if (r.key === 'memChannels' && r.sticks === 1) return t('rec.memChannels.ifOne');
  if (r.key === 'memSpeed') return t('rec.memSpeed.if', { now: r.configured, rated: r.rated, profile: r.profile });
  if (r.key !== 'power') return t(`rec.${r.key}.if`);
  if (r.plan === 'saver') return t('rec.power.if.saver');
  if (r.plan === 'custom') return t('rec.power.if.custom');
  return t('rec.power.if.fast') + (r.cpuKind === 'intelHybrid' ? t('rec.power.if.hybrid') : r.cpuKind === 'amdX3D' ? t('rec.power.if.x3d') : '');
}

function OverviewPage({ junk, startup, perf, live, recs, go }) {
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
            {(live?.cpuTempC ?? perf.cpuTempC) != null && (
              <div className="orow"><span>{t('lv.temp')}</span><span className={tempClass(live?.cpuTempC ?? perf.cpuTempC)}>{ltr(`${live?.cpuTempC ?? perf.cpuTempC}°C${live?.cpuPowerW != null ? ` · ${live.cpuPowerW} W` : ''}`)}</span></div>
            )}
            <div className="orow"><span>{t('ov.ramUsed')}</span><span>{ltr(`${(perf.ramTotalGB - perf.ramFreeGB).toFixed(1)} / ${perf.ramTotalGB} GB`)}</span></div>
            {[].concat(perf.gpuTemps || []).slice(0, 1).map((g) => <div key={g.name} className="orow"><span>{t('ov.gpuTemp')}</span><span className={tempClass(g.tempC)}>{ltr(`${g.tempC}°C`)}</span></div>)}
            <div className="orow"><span>{t('ov.topRam')}</span><span className="note">{[].concat(perf.topRam).slice(0, 2).map((p) => p.name).join(', ')}</span></div>
          </>) : <div className="center-msg"><Loader2 size={16} className="spin" /></div>}
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('perf')}>{t('ov.details')}</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Settings2 size={16} /> {t('ov.recs')}</span><span className="muted">{recs ? (toImprove ? (toImprove === 1 ? t('ov.oneToImprove') : t('ov.toImprove', { n: toImprove })) : t('ov.allOk')) : '…'}</span></div>
          {[...(recs || [])].sort((a, b) => statusRank(a.ok) - statusRank(b.ok)).slice(0, 4).map((r) => (
            <div key={r.key} className="orow"><span>{recTitle(r, t)}</span>{r.ok === true ? <span className="ok-text">{t('ok')}</span> : r.ok === false ? <span className="warn-text">{t('improve')}</span> : <span className="note">{t(r.guide ? 'cc.tip' : 'toCheck')}</span>}</div>
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

// "Why is my PC hot?": a plain-language finding from the CPU readings.
// At rest a CPU usually sits around 30–50°C; warmer than that at idle is worth explaining. Modern
// CPUs jump 20°C for a fraction of a second on every small task, so one reading says little: the
// finding uses the median of the last 30 seconds, and only the moments the CPU was at rest.
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
function coolingFindings(history, t) {
  const rest = history.filter((h) => h.cpuTempC != null && h.cpuLoad != null && h.cpuLoad < 20);
  if (rest.length < 5) return [];
  const temp = median(rest.map((h) => h.cpuTempC));
  if (temp >= 55) return [{ level: 'warn', text: t(temp >= 70 ? 'fd.cpuHot' : 'fd.cpuWarm', { t: temp }), tips: t('fd.tipCpu') }];
  return [{ level: 'ok', text: t('fd.ok', { t: temp }) }];
}

function PerfPage({ perf, live, history = [], service, onRefresh, onInstallService, busy }) {
  const t = useT();
  const findings = coolingFindings(history, t);
  const gpu = [].concat(perf?.gpuTemps || [])[0];
  const gpuTile = (
    <div key="gpu" className="stat" title={gpu?.name || ''}>
      <span><Monitor size={13} /> {t('pf.gpuTemp')}</span>
      {gpu ? (<>
        <b className={tempClass(gpu.tempC)}>{ltr(`${gpu.tempC}°C`)}</b>
        <small>{[gpu.hotspotC ? t('pf.hotspot', { t: ltr(`${gpu.hotspotC}°C`) }) : null, gpu.fanRpm ? t('pf.fan', { rpm: rpm(gpu.fanRpm, t) }) : null].filter(Boolean).join(' · ') || gpu.name}</small>
      </>) : <><b className="na">—</b><small>{t('pf.gpuNone')}</small></>}
    </div>
  );
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
        <LiveCpu live={live || perf} service={service} onInstallService={onInstallService} busy={busy} extra={[gpuTile]} />
        {perf.cpuTempC == null && perf.cpuNote && perf.cpuNote !== 'no service' && <div className="dmeta">{t(cpuNoteKey(perf.cpuNote))}</div>}
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

// ---------------- performance center ----------------

// Live CPU readings from the background service, every 2 seconds while a page shows them, with the
// last 30 seconds kept so findings don't hang on a single momentary reading.
function useLiveSensors(on) {
  const [live, setLive] = useState(null);
  const [history, setHistory] = useState([]);
  useEffect(() => {
    if (!on || !api?.sensors) return undefined;
    let stop = false;
    let timer;
    const tick = async () => {
      const r = await api.sensors().catch(() => null);
      if (stop) return;
      if (r?.ok) {
        setLive(r.data);
        setHistory((h) => [...h, r.data].slice(-15));
      }
      timer = setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [on]);
  return [live, history];
}

// Temperature, power, voltage and clock of the CPU as tiles; `extra` adds tiles after them.
// Without the service (or with an older one) it says what to do to see them.
function LiveCpu({ live, service, onInstallService, busy, extra = [] }) {
  const t = useT();
  const v = live || {};
  const tiles = [
    { key: 'temp', icon: Thermometer, label: t('lv.temp'), value: v.cpuTempC != null ? `${v.cpuTempC}°C` : null, cls: tempClass(v.cpuTempC) },
    { key: 'power', icon: Zap, label: t('lv.power'), value: v.cpuPowerW != null ? `${v.cpuPowerW} W` : null, title: t('lv.powerTitle') },
    { key: 'volt', icon: Activity, label: t('lv.volt'), value: v.cpuVoltageV != null ? `${Number(v.cpuVoltageV).toFixed(3)} V` : null, title: t('lv.voltTitle') },
    { key: 'clock', icon: Gauge, label: t('lv.clock'), value: v.cpuClockMHz != null ? `${(v.cpuClockMHz / 1000).toFixed(2)} GHz` : null },
  ];
  const noService = live && v.cpuNote === 'no service';
  const outdated = service?.running && !service.current;
  const hint = noService ? t('lv.noService') : outdated ? t('lv.outdated') : null;
  return (
    <>
      <div className={`stats live n${tiles.length + extra.length}`}>
        {tiles.map((x) => (
          <div key={x.key} className="stat" title={x.title || ''}>
            <span><x.icon size={13} /> {x.label}</span>
            {x.value != null ? <b className={x.cls || ''}>{ltr(x.value)}</b> : <b className="na">{live ? '—' : <Loader2 size={15} className="spin" />}</b>}
          </div>
        ))}
        {extra}
      </div>
      {hint && (
        <div className="finding warn live-hint">
          <Info size={15} />
          <div>{hint} <button className="link-btn" onClick={onInstallService} disabled={!!busy}>{t(noService ? 'lv.install' : 'lv.update')}</button></div>
        </div>
      )}
    </>
  );
}

// Every check, grouped by the part of the PC it is about. Tune's own scans (graphics driver,
// leftover files, startup apps) join the settings checks, so everything is in one place.
const GROUPS = [
  { id: 'cpu', icon: Cpu }, { id: 'board', icon: CircuitBoard }, { id: 'memory', icon: MemoryStick },
  { id: 'gpu', icon: Monitor }, { id: 'storage', icon: HardDrive }, { id: 'windows', icon: Settings2 },
];
function centerItems({ recs, bios, gpu, junk, startup, live, history = [] }) {
  const recent = median(history.map((h) => h.cpuTempC).filter((x) => x != null));
  const items = (recs || []).map((r) => {
    // BIOS: checked against the maker's site, so its status comes from the BIOS check.
    if (r.key === 'bios') return { ...r, ok: bios?.supported ? !bios.newer : null };
    // The power-limit tip turns into a finding when the CPU has been very hot for the last half
    // minute (not on one momentary jump).
    if (r.key === 'powerLimit') return { ...r, ok: history.length >= 5 && recent >= 90 ? false : null, tempC: recent ?? live?.cpuTempC, powerW: live?.cpuPowerW };
    return r;
  });
  const drivers = (gpu || []).filter((g) => g.vendor !== 'Intel' && g.latest);
  if (drivers.length) {
    const g = drivers.find((x) => x.newer && x.url) || drivers[0];
    items.push({ key: 'gpuDriver', group: 'gpu', ok: !(g.newer && g.url), latest: g.latest, vendor: g.vendor, go: 'updates' });
  }
  if (junk) {
    const bytes = junk.reduce((s, c) => s + c.bytes, 0);
    items.push({ key: 'junk', group: 'storage', bytes, ok: bytes < 5e9, go: 'clean' });
  }
  if (startup) {
    const n = startup.filter((s) => s.enabled).length;
    items.push({ key: 'startup', group: 'windows', n, ok: n <= 12, go: 'startup' });
  }
  return items;
}
// Which results each page shows, for the "showing the last scan · updating" label.
const STALE_KEYS = { updates: ['wu', 'gpu', 'bios'], hardware: ['hw'], overview: ['junk', 'startup', 'recs'], clean: ['junk'], startup: ['startup'], recs: ['recs'] };
const statusRank = (ok) => (ok === false ? 0 : ok == null ? 1 : 2);

function CenterRow({ r, bios, onApply, onBiosDownload, onBiosGuide, onGuide, go, busy, prog }) {
  const t = useT();
  const isBios = r.key === 'bios';
  const note = isBios && bios?.supported
    ? (bios.newer ? `${t('rc.biosNewer', { v: bios.latest.version, maker: bios.maker, date: bios.latest.date })} ${recNote(r, t)}` : t('rc.biosLatest', { maker: bios.maker }))
    : recNote(r, t);
  const value = String(recValue(r, t) ?? '');
  const tip = r.ok == null && !isBios;
  return (
    <div className="drow">
      <span className={`dicon ${r.ok === false ? 'warn' : r.ok === true ? 'good' : ''}`}>{r.ok === false ? <AlertTriangle size={16} /> : r.ok === true ? <Check size={16} /> : <Info size={16} />}</span>
      <div style={{ minWidth: 0 }}>
        <div className="dname">{recTitle(r, t)}{value && <> · <span style={{ fontWeight: 400 }}>{/^0x/.test(value) ? ltr(value) : value.replace(/\(?\d[\d.,:/-]*\)?(?:\s?(?:GB|MB|W|V|GHz|MT\/s))?/g, (m) => ltr(m))}</span></>}</div>
        <div className="dmeta" style={{ whiteSpace: 'normal' }}>{note}</div>
        {r.ok === false && <div className="dmeta if-not">{recIf(r, t)}</div>}
      </div>
      <div className="acts">
        {r.ok === true && <span className="ok-text">{t('ok')}</span>}
        {tip && <span className="note">{t('cc.tip')}</span>}
        {r.guide && <button className={r.ok === false ? 'btn-primary' : 'btn-ghost'} onClick={() => onGuide(r)}><BookOpen size={14} /> {t('cc.how')}</button>}
        {r.go && r.ok === false && <button className="btn-primary" onClick={() => go(r.go)}>{t(`cc.go.${r.go}`)}</button>}
        {r.go && r.ok !== false && <button className="btn-ghost" onClick={() => go(r.go)}>{t('cc.open')}</button>}
        {r.key === 'microcode' && r.ok === false && <button className="btn-primary" onClick={onBiosGuide}>{t('cc.toBios')}</button>}
        {isBios && bios?.supported && bios.newer && (busy === 'bios' ? <ProgressPill p={prog.bios} fallback={t('prog.downloading')} /> : (<>
          <button className="btn-ghost" onClick={onBiosGuide}><Info size={14} /> {t('up.howInstall')}</button>
          <button className="btn-primary" disabled={!!busy} onClick={onBiosDownload}><Download size={14} /> {t('rc.download')}</button>
        </>))}
        {isBios && !bios && <Loader2 size={15} className="spin" />}
        {isBios && bios && !bios.supported && <button className="btn-ghost" onClick={() => api.openLink(bios.page || r.link)}><ExternalLink size={14} /> {t('rc.searchMaker')}</button>}
        {r.action && !isBios && (busy === r.key ? <ProgressPill p={prog[r.key]} fallback={t('prog.applying')} />
          : <button className="btn-primary" disabled={!!busy} onClick={() => onApply(r)}>{t(r.key === 'power' ? 'rc.applyPlan' : 'rc.apply')}</button>)}
      </div>
    </div>
  );
}

function CenterPage({ recs, bios, gpu, junk, startup, live, history, service, onInstallService, onRefresh, onGuide, onBiosGuide, go, ...rowProps }) {
  const t = useT();
  const items = useMemo(() => centerItems({ recs, bios, gpu, junk, startup, live, history }), [recs, bios, gpu, junk, startup, live, history]);
  const judged = items.filter((i) => i.ok != null);
  const good = judged.filter((i) => i.ok).length;
  return (
    <>
      <header className="page-header">
        <div><h1>{t('cc.title')}</h1><p className="subtitle">{t('cc.subtitle')}</p></div>
        <div className="header-actions">
          {recs && <div className={`score ${good === judged.length ? 'all' : ''}`} title={t('cc.scoreTitle')}><b>{ltr(`${good}/${judged.length}`)}</b> {t('cc.okCount')}</div>}
          <button className="btn-ghost" onClick={onRefresh} disabled={!recs}><RefreshCw size={14} /> {t('pf.refresh')}</button>
        </div>
      </header>
      <LiveCpu live={live} service={service} onInstallService={onInstallService} busy={rowProps.busy} />
      <section className="panel">
        {!recs ? <div className="center-msg"><Loader2 size={16} className="spin" /> {t('loading')}</div> : GROUPS.map((g) => {
          const list = items.filter((i) => i.group === g.id).sort((a, b) => statusRank(a.ok) - statusRank(b.ok));
          if (!list.length) return null;
          const bad = list.filter((i) => i.ok === false).length;
          return (
            <React.Fragment key={g.id}>
              <div className="group-title"><g.icon size={14} /> {t(`cc.g.${g.id}`)}{bad > 0 && <span className="warn-text">{bad === 1 ? t('ov.oneToImprove') : t('ov.toImprove', { n: bad })}</span>}</div>
              {list.map((r) => <CenterRow key={r.key} r={r} bios={bios} go={go} onGuide={onGuide} onBiosGuide={onBiosGuide} {...rowProps} />)}
            </React.Fragment>
          );
        })}
      </section>
    </>
  );
}

// BIOS menus differ by board maker; these are the names each maker uses.
const BIOS_HINTS = {
  asus: { name: 'ASUS', key: 'Del', adv: 'F7', xmp: 'Ai Tweaker → Ai Overclock Tuner → {profile} I', power: 'Ai Tweaker' },
  msi: { name: 'MSI', key: 'Del', adv: 'F7', xmp: 'OC → Extreme Memory Profile ({profile})', power: 'OC' },
  gigabyte: { name: 'Gigabyte', key: 'Del', adv: 'F2', xmp: 'Tweaker → Extreme Memory Profile ({profile})', power: 'Tweaker' },
  asrock: { name: 'ASRock', key: 'F2', adv: 'F6', xmp: 'OC Tweaker → DRAM Configuration → {profile}', power: 'OC Tweaker' },
  other: { name: '', key: 'Del / F2', adv: 'F7', xmp: '{profile}', power: 'Advanced' },
};
const biosHint = (maker = '') => BIOS_HINTS[/asus/i.test(maker) ? 'asus' : /micro-star|msi/i.test(maker) ? 'msi' : /gigabyte/i.test(maker) ? 'gigabyte' : /asrock/i.test(maker) ? 'asrock' : 'other'];
const GUIDE_STEPS = { channels: 5, xmp: 4, powerLimitIntel: 5, powerLimitAmd: 3 };

// Step-by-step for the changes Tune can't make from Windows (inside the PC or in the BIOS).
function SettingGuide({ item, boardMaker, onClose }) {
  const t = useT();
  const kind = item.guide === 'powerLimit' ? (item.cpuKind === 'intelHybrid' ? 'powerLimitIntel' : 'powerLimitAmd') : item.guide;
  const h = biosHint(item.boardMaker || boardMaker);
  const profile = item.profile || 'XMP';
  const vars = { key: h.key, adv: h.adv, power: h.power, profile, option: h.xmp.replace('{profile}', profile), maker: h.name || t('g2.yourBoard') };
  const manual = item.boardModel ? `https://www.google.com/search?q=${encodeURIComponent(`${item.boardMaker || ''} ${item.boardModel} manual`)}` : null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal guide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><h2>{t(`g2.${kind}.title`, vars)}</h2><div className="dmeta" style={{ whiteSpace: 'normal' }}>{t(`g2.${kind}.why`, vars)}</div></div>
          <button className="icon-btn ghost" onClick={onClose} aria-label={t('close')}><X size={16} /></button>
        </div>
        <div className="guide-body">
          <ol>{Array.from({ length: GUIDE_STEPS[kind] }, (_, i) => <li key={i}>{rich(t(`g2.${kind}.${i + 1}`, vars))}</li>)}</ol>
          <div className="warn-box"><AlertTriangle size={14} /> {t(`g2.${kind}.warn`, vars)}</div>
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>{t('g2.done')}</button>
          {manual && kind === 'channels' && <button className="btn-ghost" onClick={() => api.openLink(manual)}><ExternalLink size={14} /> {t('g2.manual')}</button>}
        </div>
      </div>
    </div>
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

function SettingsPage({ version, status, onCheck, settings, onPickDir, onLang, onSound, service, onInstallService, onRemoveService, busy, prog }) {
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
          <div><div className="setting-title">{t('se.sound')}</div><div className="row-meta">{t('se.soundNote')}</div></div>
          <div className="acts">
            <button className="btn-ghost" onClick={playChime}>{t('se.soundTry')}</button>
            <button className={`toggle ${settings?.sound !== false ? 'on' : ''}`} aria-label={t('se.sound')} onClick={() => onSound(settings?.sound === false)} />
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
    setWu(w.ok ? [].concat(w.data || []) : []);
    if (w.ok) markFresh('wu', [].concat(w.data || []));
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
    setWu(w.ok ? [].concat(w.data || []) : []);
    if (w.ok) markFresh('wu', [].concat(w.data || []));
    else setMsg({ kind: 'err', key: 'msg.wuFailed', vars: { e: w.error } });
    setGpu(g.ok ? [].concat(g.data || []) : []);
    if (g.ok) markFresh('gpu', [].concat(g.data || []));
    setBios(b.ok ? b.data : { supported: false, page: null });
    if (b.ok) markFresh('bios', b.data);
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
          <div className="breadcrumbs"><Home size={15} /> <Crumb size={13} /> <span>{t(PAGES.find((p) => p.id === page)?.key || '')}</span>
            {(STALE_KEYS[page] || []).some(stale) && <span className="stale-chip"><Loader2 size={12} className="spin" /> {t('stale.updating')}</span>}</div>
          <UpdateBanner status={appUpdate} />
          <Banner msg={shownMsg} onClose={() => setMsg(null)} />
          {page === 'updates' && <UpdatesPage hw={hw} wu={wu} gpu={gpu} bios={bios} scan={scan} soundKey={settings?.sound !== false && fresh.wu && !scan.running ? scan.at : null} busy={lockWhile(scan.running)} onScan={fullScan} onInstall={installDrivers} onGpu={gpuInstall} onBiosDownload={biosDownload} onGuide={() => setGuide(true)} onEnable={enable} prog={prog} />}
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
