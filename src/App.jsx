import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SlidersHorizontal, RefreshCw, Cpu, Sparkles, Trash2, Rocket, Thermometer, Settings2, History, Settings, Home,
  ChevronLeft, Download, Monitor, Wifi, Bluetooth, Network, Volume2, HardDrive, Usb, Camera, AlertTriangle, Check,
  Loader2, ShieldCheck, ExternalLink, Search, Undo2, RotateCcw, FolderOpen, FileSpreadsheet, FileText, Droplets,
  CircuitBoard, ScanSearch, Info, X,
} from 'lucide-react';

const api = window.tune;

const PAGES = [
  { group: 'דרייברים' },
  { id: 'updates', icon: RefreshCw, label: 'עדכונים' },
  { id: 'hardware', icon: Cpu, label: 'החומרה שלי' },
  { group: 'מיטוב' },
  { id: 'overview', icon: Sparkles, label: 'סקירה' },
  { id: 'clean', icon: Trash2, label: 'ניקוי' },
  { id: 'startup', icon: Rocket, label: 'הפעלה עם Windows' },
  { id: 'perf', icon: Thermometer, label: 'מעבד וזיכרון' },
  { id: 'recs', icon: Settings2, label: 'הגדרות מומלצות' },
  { group: '' },
  { id: 'history', icon: History, label: 'היסטוריה ושחזור' },
  { id: 'settings', icon: Settings, label: 'הגדרות' },
];
const pageLabel = (id) => PAGES.find((p) => p.id === id)?.label || '';

// Keeps "8.67 GB" in reading order inside Hebrew text.
const ltr = (s) => '\u2066' + s + '\u2069';
const fmtGB = (b) => ltr(b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
// Intel stamps some chipset drivers 1968-07-18 on purpose; it is not an old driver.
const shownDate = (d) => (!d || d.startsWith('1968') ? '—' : d);
const errText = (e) => ({
  cancelled: 'הפעולה בוטלה (לא אושרה הרשאת מנהל)',
  'admin session ended': 'הרשאת המנהל הופסקה באמצע הפעולה. אפשר לנסות שוב.',
  'checksum mismatch': 'הקובץ שהורד לא תאם לחתימה שהיצרן פרסם, ולכן נמחק. כדאי לנסות שוב.',
  'signature check failed': 'החתימה הדיגיטלית של הקובץ לא אומתה כשל היצרן, ולכן הוא נמחק ולא נפתח.',
}[e] || `הפעולה נכשלה: ${e}`);
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const tempClass = (c) => (c == null ? '' : c >= 85 ? 'temp-hot' : c >= 70 ? 'temp-warm' : 'temp-ok');

// What a long job is doing right now: approval, restore point, download %, install %.
function ProgressPill({ p, fallback }) {
  const label = {
    auth: 'ממתין לאישור מנהל…', restore: 'יוצר נקודת שחזור…', prepare: 'מכין…', download: 'מוריד', install: 'מתקין',
    service: 'מתקין את השירות…', pawnio: 'מתקין את PawnIO…', start: 'מפעיל את השירות…',
  }[p?.phase] || fallback;
  const pct = p && ['download', 'install'].includes(p.phase) && p.percent != null ? p.percent : null;
  return (
    <span className="pill prog-pill">
      <Loader2 size={13} className="spin" />
      {label}{pct != null ? ` ${pct}%` : p && ['download', 'install'].includes(p.phase) ? '…' : ''}
      {p?.count > 1 && p.index ? ` · ${p.index} מתוך ${p.count}` : ''}
      {pct != null && <span className="mini-bar"><i style={{ width: `${pct}%` }} /></span>}
    </span>
  );
}

// BIOS can't be updated from Windows safely, so Tune downloads the verified file and explains
// the board maker's own update tool.
function BiosGuide({ bios, onClose, onDownload, busy, prog }) {
  if (!bios) return null;
  const l = bios.latest;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal guide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>עדכון BIOS · {bios.model}</h2>
            <div className="dmeta">מותקן {bios.installed} ({bios.installedDate}) ← זמין <b>{l.version}</b> ({l.date}) · {ltr(l.size)}</div>
          </div>
          <button className="icon-btn ghost" onClick={onClose} aria-label="סגור"><X size={16} /></button>
        </div>
        <div className="guide-body">
          {l.notes && <><div className="setting-title">מה חדש לפי {bios.maker}</div><div className="notes" dir="ltr">{l.notes}</div></>}
          {bios.flash === 'windows' ? (<>
            <div className="setting-title">איך מתקינים (הכלי הרשמי של {bios.maker}, מתוך Windows)</div>
            <ol>
              <li>מורידים את הקובץ (הכפתור למטה). Tune בודק שהוא זהה למה ש-{bios.maker} פרסמה ושהוא חתום על ידה.</li>
              <li>שומרים עבודה וסוגרים תוכנות. במחשב נייד: מחברים למטען.</li>
              <li>אם BitLocker מופעל, כדאי שמפתח השחזור יהיה זמין (נמצא בחשבון Microsoft). הכלים של {bios.maker} בדרך כלל משהים אותו לבד.</li>
              <li>מפעילים את הקובץ שהורד ועוקבים אחרי ההוראות שלו.</li>
              <li>המחשב יופעל מחדש ויעדכן את ה-BIOS. זה לוקח כמה דקות, ייתכן מסך שחור או כמה הפעלות מחדש.</li>
            </ol>
          </>) : (<>
            <div className="setting-title">איך מתקינים (ASUS EZ Flash, מתוך ה-BIOS)</div>
            <ol>
              <li>מורידים את הקובץ (הכפתור למטה). Tune בודק שהוא זהה לחתימה ש-ASUS פרסמה.</li>
              <li>מעתיקים את קובץ ה-ZIP לדיסק און קי בפורמט FAT32.</li>
              <li>מפעילים מחדש ולוחצים <b>Delete</b> כשהמחשב עולה, כדי להיכנס ל-BIOS.</li>
              <li><b>F7</b> למצב Advanced ← לשונית <b>Tool</b> ← <b>ASUS EZ Flash 3 Utility</b>.</li>
              <li>בוחרים את הדיסק און קי ואת הקובץ, ומאשרים. העדכון לוקח כמה דקות והמחשב יופעל מחדש לבד.</li>
              <li>אחרי העדכון ההגדרות חוזרות לברירת מחדל: אם הפעלת XMP/EXPO לזיכרון, צריך להפעיל שוב.</li>
            </ol>
          </>)}
          <div className="warn-box"><AlertTriangle size={14} /> לא לכבות ולא לנתק חשמל בזמן העדכון. כדאי לעדכן כשאין עבודה פתוחה.</div>
        </div>
        <div className="modal-actions">
          {busy ? <ProgressPill p={prog} fallback="מוריד…" />
            : <button className="btn-primary" onClick={onDownload}><Download size={14} /> הורד ({ltr(l.size)})</button>}
          <button className="btn-ghost" onClick={() => api.openLink(bios.page)}><ExternalLink size={14} /> דף ה-BIOS הרשמי</button>
        </div>
      </div>
    </div>
  );
}

// With the background service running nothing asks for approval; otherwise one approval covers
// 10 minutes, with a countdown and a way to end it early.
function AdminChip({ service, until, onStart, onStop, onInstall, busy }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until <= Date.now()) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (service?.running && service.current) {
    return <div className="admin-chip on" title="פעולות שדורשות הרשאת מנהל עוברות דרך שירות הרקע של Tune"><ShieldCheck size={14} /> שירות רקע פעיל · בלי אישורים</div>;
  }
  if (service?.installed) {
    return <button className="admin-chip" onClick={onInstall} disabled={!!busy}><ShieldCheck size={14} /> {service.running ? 'יש עדכון לשירות הרקע' : 'שירות הרקע לא פועל · הפעל'}</button>;
  }
  const left = until - now;
  if (left > 0) {
    return (
      <div className="admin-chip on" title="פעולות שדורשות הרשאת מנהל לא יבקשו אישור נוסף עד שהזמן נגמר">
        <ShieldCheck size={14} /> הרשאת מנהל · {mmss(left)}
        <button onClick={onStop} disabled={!!busy}>סיים</button>
      </div>
    );
  }
  return (
    <>
      <button className="admin-chip" onClick={onStart} disabled={!!busy} title="אישור אחד שמכסה את כל הפעולות ל-10 דקות">
        <ShieldCheck size={14} /> הרשאת מנהל ל-10 דקות
      </button>
      <button className="admin-link" onClick={onInstall} disabled={!!busy} title="אישור אחד עכשיו, ואחר כך בלי אישורים בכלל">או התקן שירות רקע</button>
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
const titleVersion = (t = '') => (t.match(/(\d+\.\d+(?:\.\d+){1,2})(?!.*\d+\.\d+)/) || [])[1] || null;

function Banner({ msg, onClose }) {
  if (!msg) return null;
  return (
    <div className={`banner ${msg.kind || 'info'}`}>
      {msg.kind === 'err' ? <AlertTriangle size={16} /> : <Check size={16} />}
      <span>{msg.text}</span>
      <button className="btn-ghost" onClick={onClose}>סגור</button>
    </div>
  );
}

function UpdateBanner({ status }) {
  if (!status || !['available', 'downloading', 'ready'].includes(status.state)) return null;
  return (
    <div className="banner info">
      <Sparkles size={16} />
      <span>
        {status.state === 'available' && <>גרסה חדשה של Tune זמינה: <b>{status.version}</b></>}
        {status.state === 'downloading' && <>מוריד את העדכון… {status.percent || 0}%</>}
        {status.state === 'ready' && <>העדכון לגרסה <b>{status.version}</b> מוכן.</>}
      </span>
      {status.state === 'available' && <button className="btn-primary" onClick={() => api.downloadAppUpdate()}><Download size={14} /> עדכן עכשיו</button>}
      {status.state === 'ready' && <button className="btn-primary" onClick={() => api.installAppUpdate()}><RefreshCw size={14} /> הפעל מחדש</button>}
    </div>
  );
}

// ---------------- driver updates ----------------

function UpdatesPage({ hw, wu, gpu, bios, scan, onScan, onInstall, onGpu, onBiosDownload, onGuide, onEnable, busy, prog }) {
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
          <h1>עדכוני דרייברים</h1>
          <p className="subtitle">{hw ? `${hw.board} · ${hw.cpu.replace(/\(R\)|\(TM\)/g, '')} · ${hw.gpus.map((g) => g.name).join(', ')}` : 'סורק את המחשב…'}</p>
          <div className="scan-line">
            {loading ? (<>
              <span className="progress"><div style={{ width: `${Math.round((scan.step / scan.total) * 100)}%` }} /></span>
              <span>שלב {scan.step} מתוך {scan.total}: {scan.label}</span>
            </>) : scan.at ? <span>נסרק לאחרונה {new Date(scan.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</span> : null}
          </div>
        </div>
        <button className="btn-primary" onClick={onScan} disabled={loading || !!busy} title="דרייברים, BIOS, כרטיס מסך, קבצים, הפעלה, הגדרות וביצועים">
          {loading ? <Loader2 size={14} className="spin" /> : <ScanSearch size={14} />} סריקה מלאה עכשיו
        </button>
      </header>
      <div className="stats">
        <div className="stat"><span>רכיבים שנסרקו</span><b>{hw ? hw.devices.length : '…'}</b></div>
        <div className="stat"><span>עדכונים זמינים</span><b style={{ color: 'var(--accent)' }}>{loading ? '…' : total}</b></div>
        <div className="stat"><span>מעודכנים</span><b>{hw && !loading ? hw.devices.length - (wu?.length || 0) : '…'}</b></div>
        <div className="stat"><span>דורשים תשומת לב</span><b style={{ color: problems.length ? '#b45309' : undefined }}>{hw ? problems.length : '…'}</b></div>
      </div>
      <section className="panel">
        <div className="panel-title">עדכונים זמינים {loading && <Loader2 size={15} className="spin" />}</div>
        {!loading && total === 0 && <div className="center-msg"><Check size={18} /> כל הדרייברים מעודכנים לפי המקורות הרשמיים</div>}
        {biosNewer && (
          <div className="drow">
            <span className="dicon"><CircuitBoard size={17} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname"><bdi>BIOS · {biosNewer.model}</bdi><span className="src">{biosNewer.site} · רשמי</span></div>
              <div className="dmeta">{biosNewer.installed} ← <b>{biosNewer.latest.version}</b> · {biosNewer.latest.date} · {ltr(biosNewer.latest.size)} · {biosNewer.flash === 'windows' ? `מתקינים מ-Windows עם הכלי של ${biosNewer.maker}` : 'מתקינים מתוך ה-BIOS'}</div>
            </div>
            <div className="acts">
              {busy === 'bios' ? <ProgressPill p={prog.bios} fallback="מוריד…" /> : (<>
                <button className="btn-ghost" onClick={onGuide}><Info size={14} /> איך מתקינים</button>
                <button className="icon-btn accent" title="הורד את הקובץ הרשמי" onClick={onBiosDownload} disabled={!!busy}><Download size={15} /></button>
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
                <div className="dname"><bdi>{dev?.name || u.model || u.title}</bdi><span className="src">Windows Update · חתום</span></div>
                <div className="dmeta">{dev ? `${dev.version} ← ` : ''}<b>{titleVersion(u.title) || u.date}</b> · {u.maker} · {fmtGB(u.size)}</div>
              </div>
              <div className="acts">
                {busy === u.id || busy === 'all' ? <ProgressPill p={busy === 'all' ? null : prog[busy]} fallback={busy === 'all' ? 'בעדכון…' : 'מתקין…'} />
                  : <button className="icon-btn accent" title="עדכן רק את זה" onClick={() => onInstall([u])} disabled={!!busy}><Download size={15} /></button>}
              </div>
            </div>
          );
        })}
        {gpuNewer.map((g) => (
          <div key={g.gpu} className="drow">
            <span className="dicon"><Monitor size={17} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname"><bdi>{g.gpu}</bdi><span className="src">{g.vendor.toLowerCase()}.com · רשמי</span></div>
              <div className="dmeta">{g.package ? `מותקן ${g.vendor === 'AMD' ? 'AMD Software ' : ''}${g.package}` : `דרייבר מותקן ${g.installed}`} · גרסה אחרונה באתר <b>{g.title || g.latest}</b>{g.size ? <> · {ltr(g.size)}</> : null}</div>
            </div>
            <div className="acts">
              {busy === g.gpu ? <ProgressPill p={prog[g.gpu]} fallback="מוריד…" />
                : <button className="btn-ghost" onClick={() => onGpu(g)} disabled={!!busy} title="מוריד ומפעיל את תוכנת ההתקנה הרשמית"><Download size={14} /> הורד והפעל</button>}
            </div>
          </div>
        ))}
        {(gpu || []).filter((g) => g.vendor === 'Intel').map((g) => (
          <div key={g.gpu} className="drow">
            <span className="dicon"><Monitor size={17} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname"><bdi>{g.gpu}</bdi><span className="src">intel.com · רשמי</span></div>
              <div className="dmeta">דרייבר מותקן {g.installed} · עדכונים של Intel מגיעים גם דרך Windows Update. האתר של Intel מאפשר הורדה רק מהדפדפן.</div>
            </div>
            <div className="acts"><button className="btn-ghost" onClick={() => api.openLink(g.page)}><ExternalLink size={14} /> הדף הרשמי</button></div>
          </div>
        ))}
        {problems.length > 0 && <div className="panel-title" style={{ position: 'static' }}>דורשים תשומת לב</div>}
        {problems.map((p) => {
          const Icon = classIcon('', p.name);
          return (
            <div key={p.id} className="drow">
              <span className="dicon warn"><Icon size={17} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="dname">{p.name}</div>
                <div className="dmeta">{p.code === 22 ? 'מושבת במנהל ההתקנים' : p.code === 28 ? 'אין דרייבר מותקן' : `שגיאה ${p.code} במנהל ההתקנים`}</div>
              </div>
              <div className="acts">
                {busy === p.id ? <ProgressPill p={prog[p.id]} fallback="מפעיל…" />
                  : p.code === 22 && <button className="btn-ghost" onClick={() => onEnable(p)} disabled={!!busy}>הפעל</button>}
              </div>
            </div>
          );
        })}
      </section>
      <footer className="action-bar">
        <span className="muted save-where"><ShieldCheck size={14} style={{ verticalAlign: -3 }} /> נקודת שחזור נוצרת לפני כל התקנה</span>
        {busy === 'all' ? <ProgressPill p={prog.all} fallback="מתקין…" /> : (
          <button className="btn-primary big" onClick={() => onInstall(wu || [])} disabled={!wu?.length || !!busy}>
            <Download size={15} /> עדכן הכול ({wu?.length || 0})
          </button>
        )}
      </footer>
    </>
  );
}

function HardwarePage({ hw, onExport }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => (hw?.devices || [])
    .filter((d) => !/^(Microsoft|\(Standard)/.test(d.provider || '') || q)
    .filter((d) => !q || `${d.name} ${d.provider} ${d.cls}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.cls || '').localeCompare(b.cls || '')), [hw, q]);
  return (
    <>
      <header className="page-header">
        <div><h1>החומרה שלי</h1><p className="subtitle">{hw ? `${hw.computer} · BIOS ${hw.bios.version} (${hw.bios.date}) · ${hw.ramGB} GB זיכרון` : 'סורק…'}</p></div>
        <div className="header-actions">
          <button className="btn-ghost" disabled={!hw} onClick={() => onExport('csv')} title="כל הרכיבים בטבלה, נפתח ב-Excel"><FileSpreadsheet size={14} /> ייצוא ל-Excel</button>
          <button className="btn-ghost" disabled={!hw} onClick={() => onExport('txt')} title="דוח קריא, מתאים להדבקה בפורום או לתמיכה"><FileText size={14} /> ייצוא כטקסט</button>
        </div>
      </header>
      <label className="search"><Search size={16} /><input placeholder="חיפוש רכיב, יצרן או סוג" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <section className="panel">
        <div className="panel-title">{q ? `${list.length} תוצאות` : `${list.length} רכיבים עם דרייבר של יצרן (דרייברים מובנים של Windows מוצגים בחיפוש)`}</div>
        {list.map((d) => {
          const Icon = classIcon(d.cls, d.name);
          return (
            <div key={d.id} className="drow">
              <span className="dicon"><Icon size={17} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="dname">{d.name}</div>
                <div className="dmeta"><bdi dir="ltr">{d.version}</bdi> · {shownDate(d.date)} · {d.provider || d.maker}</div>
              </div>
              <span className="src">{d.cls || 'אחר'}</span>
            </div>
          );
        })}
      </section>
    </>
  );
}

// ---------------- optimization ----------------

function OverviewPage({ junk, startup, perf, recs, go }) {
  const junkTotal = (junk || []).reduce((s, c) => s + c.bytes, 0);
  const startOn = (startup || []).filter((s) => s.enabled).length;
  const toImprove = (recs || []).filter((r) => r.ok === false).length;
  return (
    <>
      <header className="page-header"><div><h1>מיטוב המחשב</h1><p className="subtitle">קודם רואים מה נמצא. שום דבר לא משתנה בלי אישור שלך, ולכל שינוי יש ביטול.</p></div></header>
      <div className="grid2">
        <div className="ocard">
          <div className="ohead"><span><Trash2 size={16} /> ניקוי קבצים</span><b style={{ color: 'var(--accent)' }}>{junk ? fmtGB(junkTotal) : '…'}</b></div>
          {(junk || []).filter((c) => c.bytes > 1e6).slice(0, 4).map((c) => <div key={c.key} className="orow"><span>{c.label}</span><span>{fmtGB(c.bytes)}</span></div>)}
          <div className="ofoot"><span /><button className="btn-primary" onClick={() => go('clean')}>לניקוי</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Rocket size={16} /> עולות עם Windows</span><span className="muted">{startup ? `${startOn} פעילות מתוך ${startup.length}` : '…'}</span></div>
          {(startup || []).filter((s) => s.enabled).slice(0, 4).map((s) => <div key={s.source + s.key} className="orow"><span>{s.name}</span><span className="ok-text">פעילה</span></div>)}
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('startup')}>לכל הרשימה</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Thermometer size={16} /> מעבד וזיכרון</span></div>
          {perf ? (<>
            <div className="orow"><span>עומס על המעבד</span><span>{perf.cpuLoad}%</span></div>
            <div className="orow"><span>זיכרון בשימוש</span><span>{ltr(`${(perf.ramTotalGB - perf.ramFreeGB).toFixed(1)} / ${perf.ramTotalGB} GB`)}</span></div>
            {[].concat(perf.gpuTemps || []).slice(0, 1).map((g) => <div key={g.name} className="orow"><span>טמפ׳ כרטיס מסך</span><span className={tempClass(g.tempC)}>{ltr(`${g.tempC}°C`)}</span></div>)}
            <div className="orow"><span>הכי צורכות זיכרון</span><span className="note">{[].concat(perf.topRam).slice(0, 2).map((p) => p.name).join(', ')}</span></div>
          </>) : <div className="center-msg"><Loader2 size={16} className="spin" /></div>}
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('perf')}>פרטים</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Settings2 size={16} /> הגדרות מומלצות</span><span className="muted">{recs ? (toImprove ? `${toImprove} לשיפור` : 'הכול תקין') : '…'}</span></div>
          {(recs || []).slice(0, 4).map((r) => (
            <div key={r.key} className="orow"><span>{r.title}</span>{r.ok === true ? <span className="ok-text">תקין</span> : r.ok === false ? <span className="warn-text">לשיפור</span> : <span className="note">לבדיקה</span>}</div>
          ))}
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('recs')}>לכל ההמלצות</button></div>
        </div>
      </div>
    </>
  );
}

function CleanPage({ junk, onRescan, onClean, busy }) {
  const [sel, setSel] = useState({});
  useEffect(() => { if (junk) setSel(Object.fromEntries(junk.map((c) => [c.key, c.bytes > 0]))); }, [junk]);
  const chosen = (junk || []).filter((c) => sel[c.key] && c.bytes > 0);
  const total = chosen.reduce((s, c) => s + c.bytes, 0);
  return (
    <>
      <header className="page-header">
        <div><h1>ניקוי קבצים</h1><p className="subtitle">קבצים זמניים ומטמון שאפשר למחוק בבטחה. קבצים שבשימוש כרגע מדולגים.</p></div>
        <button className="btn-ghost" onClick={onRescan} disabled={!!busy}><RefreshCw size={14} /> סרוק שוב</button>
      </header>
      <section className="panel">
        <div className="panel-title">{junk ? `נמצאו ${fmtGB((junk || []).reduce((s, c) => s + c.bytes, 0))}` : 'סורק…'}</div>
        {(junk || []).map((c) => {
          const dirs = [].concat(c.dirs || []);
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
                    ? <button className="folder-link" title={`פתח את התיקייה: ${dirs[0]}`} onClick={(e) => open(e, dirs[0])}>{c.label} <FolderOpen size={13} /></button>
                    : c.label}
                  {dirs.length > 1 && <span className="dir-chips">{dirs.map((d) => <button key={d} className="dir-chip" title={d} onClick={(e) => open(e, d)}><FolderOpen size={11} /> {dirName(d)}</button>)}</span>}
                </div>
                <div className="dmeta">{c.files.toLocaleString('he-IL')} קבצים{c.minAgeHours ? ' · רק מלפני יותר מיממה' : ''}{c.admin ? ' · דורש אישור מנהל' : ''}</div>
              </div>
              <div className="acts"><b>{fmtGB(c.bytes)}</b><input type="checkbox" checked={!!sel[c.key]} disabled={!c.bytes} onClick={(e) => e.stopPropagation()} onChange={(e) => setSel((s) => ({ ...s, [c.key]: e.target.checked }))} /></div>
            </div>
          );
        })}
      </section>
      <footer className="action-bar">
        <span className="muted save-where">מחיקה סופית, בלי סל מחזור. נמחק רק מה שמסומן.</span>
        <button className="btn-primary big" disabled={!total || !!busy} onClick={() => window.confirm(`למחוק ${fmtGB(total)} של קבצים זמניים? אי אפשר לשחזר אותם.`) && onClean(chosen)}>
          {busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} נקה {total ? fmtGB(total) : ''}
        </button>
      </footer>
    </>
  );
}

function StartupPage({ startup, onToggle, busy, prog }) {
  return (
    <>
      <header className="page-header"><div><h1>הפעלה עם Windows</h1><p className="subtitle">כל תוכנה שמכבים כאן עדיין מותקנת ונפתחת כרגיל. היא רק לא עולה לבד. כל מתג הפיך.</p></div></header>
      <section className="panel">
        <div className="panel-title">{startup ? `${startup.filter((s) => s.enabled).length} פעילות מתוך ${startup.length}` : 'טוען…'}</div>
        {(startup || []).map((s) => (
          <div key={s.source + s.key} className="drow">
            <span className="dicon"><Rocket size={16} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname">{s.name}</div>
              <div className="dmeta" dir="ltr" style={{ textAlign: 'right' }}>{s.cmd}</div>
            </div>
            <div className="acts">
              {s.admin && <span className="src">מנהל</span>}
              {busy === s.source + s.key ? <ProgressPill p={prog[busy]} fallback="משנה…" />
                : <button className={`toggle ${s.enabled ? 'on' : ''}`} aria-label={s.enabled ? 'כבה' : 'הפעל'} disabled={!!busy} onClick={() => onToggle(s, !s.enabled)} />}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

// Why there is no CPU temperature yet, in the user's terms.
const cpuNoteText = (n) => ({
  'no service': 'דורש את שירות הרקע',
  'pawnio not installed': 'דורש את PawnIO (התקן מחדש את השירות)',
  'cpu not supported yet': 'עדיין רק למעבדי Intel',
}[n] || 'החיישן לא זמין כרגע');

const rpm = (n) => ltr(`${Number(n).toLocaleString('he-IL')} RPM`);
const liquidNoteText = (n) => ({
  'no service': 'דורש את שירות הרקע',
  'corsair needs icue': 'Corsair: פתח את iCUE כדי לראות',
  'no reading from icue': 'לא התקבלה קריאה מ-iCUE',
  'no supported cooler': 'המקרר לא מדווח טמפ׳ נוזל',
}[n] || 'לא זמין');
// Coolant runs much cooler than the CPU: about 30-40°C at rest is normal, past ~45°C is worth a look.
const liquidClass = (c) => (c == null ? '' : c >= 48 ? 'temp-hot' : c >= 42 ? 'temp-warm' : 'temp-ok');

// "Why is my PC hot?": plain-language findings from the readings, most important first.
function coolingFindings(p) {
  const out = [];
  const idle = p.cpuLoad < 20;
  const radiator = [].concat(p.fans || []).filter((f) => f.source === p.liquidSource).map((f) => f.rpm);
  const fast = radiator.length && radiator.reduce((a, b) => a + b, 0) / radiator.length > 1700;
  if (p.liquidTempC != null && p.liquidTempC >= 45) {
    out.push({
      level: 'warn',
      text: `נוזל הקירור חם (${p.liquidTempC}°C)${idle ? ' כשהמחשב כמעט לא עובד' : ''}. במנוחה הוא בדרך כלל 30–40°C.`
        + (p.pumpRpm ? ` המשאבה מסתובבת (${p.pumpRpm.toLocaleString('he-IL')} RPM), אז היא לא תקועה.` : '')
        + (fast ? ' המאווררים ברדיאטור כבר מהירים, כלומר החום לא יוצא ממנו טוב.' : ''),
      tips: 'כדאי לבדוק: אבק ברדיאטור ובמסננים, שהרדיאטור מקבל אוויר קר מבחוץ ולא אוויר חם מכרטיס המסך, וחום החדר. אם זה נשאר כך, קירור נוזלי סגור מאבד נוזל עם השנים, וכדאי לפנות לאחריות של היצרן.',
    });
  }
  // At rest a CPU usually sits around 30–50°C; warmer than that at idle is worth explaining.
  if (p.cpuTempC != null && idle && p.cpuTempC >= 55) {
    out.push({
      level: 'warn',
      text: `המעבד ${p.cpuTempC >= 70 ? 'חם' : 'חם מהרגיל'} (${p.cpuTempC}°C) בזמן מנוחה. בדרך כלל במנוחה הוא 30–50°C.`,
      tips: p.liquidTempC != null && p.liquidTempC < 42
        ? 'נוזל הקירור עצמו קר, אז הבעיה כנראה במגע בין המעבד לקירור: משחה תרמית יבשה או הידוק לא אחיד.'
        : p.liquidTempC == null
          ? 'כדי לדעת אם הקירור הוא הסיבה, צריך את טמפ׳ נוזל הקירור (אם יש לך קירור נוזלי). בינתיים כדאי לבדוק אבק ברדיאטור ובמאווררים, ואת התוכנות שמעמיסות ברקע (ברשימה למטה).'
          : 'בדוק את הקירור לפי הסעיף למעלה, ואת התוכנות שמעמיסות ברקע (ברשימה למטה).',
    });
  }
  // "Fine" only when what we can see supports it.
  const cpuFine = p.cpuTempC != null && (!idle || p.cpuTempC < 55);
  const liquidFine = p.liquidTempC == null || p.liquidTempC < 42;
  if (!out.length && cpuFine && liquidFine) out.push({ level: 'ok', text: 'הקירור נראה תקין לפי הקריאות עכשיו.' });
  return out;
}

function PerfPage({ perf, onRefresh, onInstallService, busy }) {
  const findings = perf ? coolingFindings(perf) : [];
  const gpu = [].concat(perf?.gpuTemps || [])[0];
  return (
    <>
      <header className="page-header">
        <div><h1>מעבד וזיכרון</h1><p className="subtitle">מה מעמיס על המחשב עכשיו, כמה חם בו, ולמה.</p></div>
        <button className="btn-ghost" onClick={onRefresh}><RefreshCw size={14} /> רענן</button>
      </header>
      {!perf ? <div className="center-msg"><Loader2 size={16} className="spin" /></div> : (<>
        <div className="stats three">
          <div className="stat"><span>עומס על המעבד</span><b>{perf.cpuLoad}%</b></div>
          <div className="stat"><span>זיכרון בשימוש</span><b>{ltr(`${(perf.ramTotalGB - perf.ramFreeGB).toFixed(1)} GB`)}</b></div>
          <div className="stat"><span>זיכרון פנוי</span><b>{ltr(`${perf.ramFreeGB} GB`)}</b></div>
        </div>
        <div className="stats three">
          <div className="stat" title="נקרא דרך שירות הרקע (LibreHardwareMonitor ו-PawnIO)">
            <span><Cpu size={13} /> טמפ׳ מעבד</span>
            {perf.cpuTempC == null ? (<>
              <b className="na">—</b>
              <small>{cpuNoteText(perf.cpuNote)}{perf.cpuNote === 'no service' && <> · <button className="link-btn" onClick={onInstallService} disabled={!!busy}>התקן</button></>}</small>
            </>) : <b className={tempClass(perf.cpuTempC)}>{ltr(`${perf.cpuTempC}°C`)}</b>}
          </div>
          <div className="stat" title="מהבקר של הקירור הנוזלי. ב-Corsair: נקרא מהתשובות ש-iCUE מקבל, בלי לשלוח לבקר כלום">
            <span><Droplets size={13} /> טמפ׳ נוזל קירור</span>
            {perf.liquidTempC == null ? <><b className="na">—</b><small>{liquidNoteText(perf.liquidNote)}</small></> : (<>
              <b className={liquidClass(perf.liquidTempC)}>{ltr(`${perf.liquidTempC}°C`)}</b>
              <small>{perf.pumpRpm ? <>משאבה {rpm(perf.pumpRpm)}</> : perf.liquidSource}</small>
            </>)}
          </div>
          <div className="stat" title={gpu?.name || ''}>
            <span><Monitor size={13} /> טמפ׳ כרטיס מסך</span>
            {gpu ? (<>
              <b className={tempClass(gpu.tempC)}>{ltr(`${gpu.tempC}°C`)}</b>
              <small>{[gpu.hotspotC ? `נקודה חמה ${ltr(`${gpu.hotspotC}°C`)}` : null, gpu.fanRpm ? `מאוורר ${rpm(gpu.fanRpm)}` : null].filter(Boolean).join(' · ') || gpu.name}</small>
            </>) : <><b className="na">—</b><small>הכרטיס לא מדווח ל-Windows</small></>}
          </div>
        </div>
        {findings.map((f) => (
          <div key={f.text} className={`finding ${f.level}`}>
            {f.level === 'ok' ? <Check size={15} /> : <AlertTriangle size={15} />}
            <div><b>{f.text}</b>{f.tips && <div>{f.tips}</div>}</div>
          </div>
        ))}
        <div className="grid2">
          <div className="ocard"><div className="ohead"><span><Cpu size={16} /> הכי מעמיסות על המעבד</span></div>
            {[].concat(perf.topCpu).map((p) => <div key={p.name} className="orow"><span>{p.name}{p.count > 1 ? ` (${p.count})` : ''}</span><span>{p.cpu}%</span></div>)}</div>
          <div className="ocard"><div className="ohead"><span><HardDrive size={16} /> הכי צורכות זיכרון</span></div>
            {[].concat(perf.topRam).map((p) => <div key={p.name} className="orow"><span>{p.name}{p.count > 1 ? ` (${p.count})` : ''}</span><span>{ltr(`${(p.ramMB / 1024).toFixed(1)} GB`)}</span></div>)}</div>
        </div>
      </>)}
    </>
  );
}
function RecsPage({ recs, bios, onApply, onBiosDownload, onGuide, busy, prog }) {
  return (
    <>
      <header className="page-header"><div><h1>הגדרות מומלצות</h1><p className="subtitle">רק שינויים שאפשר להסביר ולבטל. בלי "טריקים" ברג׳יסטרי.</p></div></header>
      <section className="panel">
        {(recs || []).map((r) => {
          // BIOS: checked against the board maker's site, so its status comes from the BIOS check.
          const isBios = r.key === 'bios';
          const ok = isBios ? (bios?.supported ? !bios.newer : null) : r.ok;
          const note = isBios && bios?.supported
            ? (bios.newer ? `גרסה ${bios.latest.version} זמינה באתר ${bios.maker} (${bios.latest.date}). ${r.note}` : `זו הגרסה האחרונה באתר ${bios.maker}.`)
            : r.note;
          return (
            <div key={r.key} className="drow">
              <span className={`dicon ${ok === false ? 'warn' : ''}`}>{ok === false ? <AlertTriangle size={16} /> : <Check size={16} />}</span>
              <div style={{ minWidth: 0 }}>
                <div className="dname">{r.title} · <span style={{ fontWeight: 400 }}>{String(r.value ?? '').replace(/\(?\d[\d.,:/-]*\)?(?:\s?(?:GB|MB))?/g, (m) => ltr(m))}</span></div>
                <div className="dmeta" style={{ whiteSpace: 'normal' }}>{note}</div>
              </div>
              <div className="acts">
                {ok === true && <span className="ok-text">תקין</span>}
                {isBios && bios?.supported && bios.newer && (busy === 'bios' ? <ProgressPill p={prog.bios} fallback="מוריד…" /> : (<>
                  <button className="btn-ghost" onClick={onGuide}><Info size={14} /> איך מתקינים</button>
                  <button className="btn-primary" disabled={!!busy} onClick={onBiosDownload}><Download size={14} /> הורד</button>
                </>))}
                {isBios && !bios && <Loader2 size={15} className="spin" />}
                {isBios && bios && !bios.supported && <button className="btn-ghost" onClick={() => api.openLink(bios.page || r.link)}><ExternalLink size={14} /> חפש באתר היצרן</button>}
                {r.action && !isBios && (busy === r.key ? <ProgressPill p={prog[r.key]} fallback="מחיל…" />
                  : <button className="btn-primary" disabled={!!busy} onClick={() => onApply(r)}>החל</button>)}
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}

function HistoryPage({ busy, onRestorePoint }) {
  const [items, setItems] = useState([]);
  // Skip anything that isn't a Tune entry, so one malformed line can't take the whole page down.
  useEffect(() => { api.getHistory().then((list) => setItems([].concat(list || []).filter((h) => h && h.action && h.detail))); }, [busy]);
  const describe = (h) => {
    const d = h.detail;
    return ({
      drivers: `עודכנו דרייברים: ${(d.items || []).join(', ')}${d.reboot ? ' (נדרשת הפעלה מחדש)' : ''}`,
      gpu: `הורדה תוכנת התקנה רשמית: ${d.file}`,
      bios: `הורד BIOS ${d.version} (קובץ מאומת): ${d.file}`,
      service: d.installed ? `הותקן שירות הרקע${d.pawnio === 'installed' ? ' ו-PawnIO' : ''}` : 'הוסר שירות הרקע',
      enable: `הופעל רכיב: ${d.name}`,
      clean: `נוקו ${fmtGB(d.freed || 0)}: ${(d.cats || []).join(', ')}`,
      startup: `${d.enabled ? 'הופעלה' : 'כובתה'} בהפעלה עם Windows: ${d.name}`,
      setting: `שונתה הגדרה: ${d.title}`,
      restore: 'נוצרה נקודת שחזור',
    })[h.action] || h.action;
  };
  return (
    <>
      <header className="page-header">
        <div><h1>היסטוריה ושחזור</h1><p className="subtitle">כל מה ש-Tune שינה. משהו לא עובד? חוזרים לנקודת שחזור.</p></div>
        <div className="header-actions">
          <button className="btn-ghost" onClick={onRestorePoint} disabled={!!busy}><ShieldCheck size={14} /> צור נקודת שחזור</button>
          <button className="btn-ghost" onClick={() => api.openSystemRestore()}><Undo2 size={14} /> חזור לנקודת שחזור</button>
        </div>
      </header>
      <section className="panel">
        {items.length === 0 && <div className="center-msg">עוד לא בוצעו שינויים.</div>}
        {items.map((h, i) => (
          <div key={i} className="drow">
            <span className="dicon"><RotateCcw size={16} /></span>
            <div style={{ minWidth: 0 }}><div className="dname" style={{ whiteSpace: 'normal' }}>{describe(h)}</div><div className="dmeta">{fmtDate(h.at)}</div></div>
            <span />
          </div>
        ))}
      </section>
    </>
  );
}

function SettingsPage({ version, status, onCheck, settings, onPickDir, service, onInstallService, onRemoveService, busy, prog }) {
  const svcText = !service ? 'בודק…'
    : service.running ? `פועל${service.current ? '' : ' · יש גרסה חדשה לשירות'} · PawnIO ${service.pawnio ? `מותקן (${service.pawnio})` : 'לא מותקן'}`
      : service.installed ? 'מותקן אבל לא פועל' : 'לא מותקן';
  const msg = {
    checking: 'בודק אם יש גרסה חדשה…', none: 'Tune מעודכן לגרסה האחרונה', available: `גרסה ${status?.version} זמינה`,
    downloading: `מוריד… ${status?.percent || 0}%`, ready: 'מוכן להתקנה', error: 'הבדיקה נכשלה', dev: 'בדיקת עדכונים פועלת רק בגרסה המותקנת',
  }[status?.state] || 'Tune בודק עדכונים בכל הפעלה וכל 4 שעות.';
  return (
    <>
      <header className="page-header"><div><h1>הגדרות</h1></div></header>
      <section className="card settings">
        <div className="setting">
          <div><div className="setting-title">עדכוני תוכנה</div><div className="row-meta">גרסה {version || '…'} · {msg}</div></div>
          <button className="btn-ghost" onClick={onCheck}><RefreshCw size={14} /> בדוק עדכונים</button>
        </div>
        <div className="setting">
          <div><div className="setting-title">תיקיית שמירה</div><div className="row-meta" dir="ltr" style={{ textAlign: 'right' }}>{settings?.saveDir || '…'}</div><div className="row-meta">לשם יורדים קבצי BIOS ותוכנות התקנה, ונשמרים ייצואי החומרה.</div></div>
          <button className="btn-ghost" onClick={onPickDir}><FolderOpen size={14} /> שנה</button>
        </div>
        <div className="setting">
          <div>
            <div className="setting-title">שירות רקע · {svcText}</div>
            <div className="row-meta">אישור אחד בהתקנה, ואחר כך דרייברים, ניקוי והגדרות בלי חלונות אישור. גם קורא את טמפ׳ המעבד דרך PawnIO (דרייבר חתום וקוד פתוח). רץ רק פעולות מרשימה קבועה, ורק משתמשים שמחוברים למחשב יכולים לפנות אליו.</div>
            {!service?.running && <div className="row-meta">בלי השירות: אישור אחד ב-Windows מכסה את כל הפעולות ל-10 דקות.</div>}
          </div>
          <div className="header-actions">
            {busy === 'service' ? <ProgressPill p={prog.service} fallback="עובד…" /> : (<>
              {(!service?.running || !service.current) && <button className="btn-primary" onClick={onInstallService} disabled={!!busy}><ShieldCheck size={14} /> {service?.installed ? 'עדכן והפעל' : 'התקן'}</button>}
              {service?.installed && <button className="btn-ghost" onClick={onRemoveService} disabled={!!busy}>הסר</button>}
            </>)}
          </div>
        </div>
        <div className="setting">
          <div><div className="setting-title">מקורות</div><div className="row-meta">Windows Update (דרייברים שהיצרנים מפרסמים, חתומים ע״י Microsoft), אתרי AMD, NVIDIA ו-Intel לכרטיסי מסך, ואתר ASUS ל-BIOS (קובץ נבדק מול החתימה שפורסמה).</div></div>
        </div>
        <div className="setting">
          <div><div className="setting-title">בטיחות</div><div className="row-meta">לפני כל התקנת דרייבר נוצרת נקודת שחזור. כל שינוי נרשם בהיסטוריה.</div></div>
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
  const fullScan = useCallback(async () => {
    const step = (n, label) => setScan((s) => ({ ...s, running: true, step: n, label }));
    step(1, 'רכיבים ודרייברים מותקנים');
    const h = await api.scanHardware();
    if (h.ok) setHw(h.data);
    step(2, 'Windows Update, אתרי היצרנים ו-BIOS');
    const board = h.ok ? { maker: h.data.boardMaker, model: h.data.boardModel, version: h.data.bios.version, date: h.data.bios.date, systemMaker: h.data.systemMaker, systemModel: h.data.systemModel, systemSku: h.data.systemSku } : null;
    const [w, g, b] = await Promise.all([
      api.driverUpdates(),
      h.ok ? api.gpuCheck(h.data.gpus, h.data.amdSoftware) : Promise.resolve({ ok: false }),
      board ? api.biosCheck(board) : Promise.resolve({ ok: false }),
    ]);
    setWu(w.ok ? [].concat(w.data || []) : []);
    if (!w.ok) setMsg({ kind: 'err', text: `Windows Update לא ענה: ${w.error}` });
    setGpu(g.ok ? [].concat(g.data || []) : []);
    setBios(b.ok ? b.data : { supported: false, page: null });
    step(3, 'קבצים מיותרים, הפעלה עם Windows, הגדרות וביצועים');
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
    if (!r?.ok) setMsg({ kind: 'err', text: errText(r?.error) });
    else if (done) setMsg({ kind: 'info', text: done(r.data) });
    return r;
  };

  const installDrivers = (items) => {
    const key = items.length === 1 ? items[0].id : 'all';
    return act(key, () => api.installDrivers(items, key), (d) => {
      const okCount = (d.results || []).filter((x) => x.code === 2 || x.code === 3).length;
      scanDrivers();
      return `הותקנו ${okCount} מתוך ${items.length}. נקודת שחזור: ${d.restore === 'created' ? 'נוצרה' : d.restore === 'recent' ? 'קיימת כבר אחת מהיממה האחרונה' : 'לא נוצרה (' + d.restore + ')'}.${d.reboot ? ' נדרשת הפעלה מחדש כדי להשלים.' : ''}`;
    }, { admin: true });
  };
  const gpuInstall = (g) => act(g.gpu, () => api.gpuInstaller(g.url, g.gpu), () => `תוכנת ההתקנה הרשמית של ${g.vendor} הורדה, החתימה שלה אומתה, והיא נפתחה. ההתקנה ממשיכה בחלון שלה.`);
  const biosDownload = () => act('bios', () => api.biosDownload(bios.latest, 'bios'), () => { setGuide(true); return `BIOS ${bios.latest.version} הורד ואומת מול החתימה של ${bios.maker}. התיקייה נפתחה, וההוראות מוצגות.`; });
  const enable = (p) => act(p.id, () => api.enableDevice(p), () => { scanDrivers(); return `${p.name} הופעל.`; }, { admin: true });
  const clean = (cats) => act('clean', () => api.junkClean(cats), (d) => { loadJunk(); return `פונו ${fmtGB(d.freed)}.${d.skipped ? ` ${d.skipped} קבצים בשימוש דולגו.` : ''}${d.adminError ? ` התיקיות של Windows לא נוקו (${errText(d.adminError)}).` : ''}`; }, { admin: cats.some((c) => c.admin) });
  const toggle = (s, en) => act(s.source + s.key, () => api.startupToggle(s, en), () => { loadStartup(); return `${s.name} ${en ? 'תעלה' : 'לא תעלה'} עם Windows.`; }, { admin: s.admin });
  const apply = (r) => act(r.key, () => api.applyRecommendation(r), (d) => { loadRecs(); return d === 'reboot' ? `${r.title} הופעל. ייכנס לתוקף אחרי הפעלה מחדש.` : `${r.title} עודכן.`; }, { admin: r.key === 'hags' });
  const restorePoint = () => act('restore', () => api.createRestorePoint(), (d) => (d === 'created' ? 'נקודת שחזור נוצרה.' : 'Windows יוצר נקודת שחזור אחת ביממה, וכבר קיימת אחת מהיממה האחרונה. אפשר לחזור אליה.'), { admin: true });
  const exportHw = (format) => act('export', () => api.exportHardware(hw, format), (file) => `נשמר: ${file}`);
  const adminStart = () => act('admin', () => api.adminStart(), () => 'הרשאת מנהל פעילה ל-10 דקות. פעולות שדורשות אותה לא יבקשו אישור נוסף.', { admin: true });
  const adminStop = async () => { await api.adminStop(); setAdminUntil(0); };
  const installService = () => act('service', () => api.installService(), (d) => {
    loadService();
    loadPerf();
    const pawn = { installed: ' ו-PawnIO הותקן: טמפ׳ המעבד מוצגת בעמוד מעבד וזיכרון.', present: '', reboot: ' PawnIO הותקן, וצריך להפעיל מחדש את המחשב כדי שטמפ׳ המעבד תופיע.' }[d.pawnio]
      ?? ` PawnIO לא הותקן (${d.pawnio}), אז טמפ׳ המעבד לא תוצג.`;
    return `שירות הרקע מותקן ופועל: מעכשיו בלי חלונות אישור.${pawn}`;
  }, { admin: true });
  const removeService = () => window.confirm('להסיר את שירות הרקע? פעולות שדורשות הרשאת מנהל יבקשו שוב אישור, וטמפ׳ המעבד לא תוצג. (PawnIO נשאר מותקן ואפשר להסיר אותו מרשימת האפליקציות של Windows.)')
    && act('service', () => api.uninstallService(), () => { loadService(); return 'שירות הרקע הוסר.'; }, { admin: true });

  const updatesCount = (wu?.length || 0) + (gpu || []).filter((g) => g.newer && g.url).length + (bios?.supported && bios.newer ? 1 : 0);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span>Tune</span><SlidersHorizontal size={24} strokeWidth={2.4} className="brand-icon" /></div>
        <nav>
          {PAGES.map((p, i) => (p.group !== undefined
            ? <div key={`g${i}`} className="nav-group">{p.group}</div>
            : (
              <button key={p.id} className={`nav-item ${page === p.id ? 'active' : ''}`} onClick={() => setPage(p.id)}>
                <span>{p.label}</span>
                {p.id === 'updates' && updatesCount > 0 && <span className="nav-badge">{updatesCount}</span>}
                <p.icon size={18} />
              </button>
            )))}
        </nav>
        <div className="sidebar-footer">
          <AdminChip service={service} until={adminUntil} onStart={adminStart} onStop={adminStop} onInstall={installService} busy={busy} />
          <div><span className={`dot ${scan.running ? 'dot-off' : ''}`} /> {scan.running ? 'סורק…' : 'הסריקה הושלמה'}</div>
          <div className="muted">גרסה {version || '…'}</div>
        </div>
      </aside>
      <main className="main">
        <div className="breadcrumbs"><Home size={15} /> <ChevronLeft size={13} /> <span>{pageLabel(page)}</span></div>
        <UpdateBanner status={appUpdate} />
        <Banner msg={msg} onClose={() => setMsg(null)} />
        {page === 'updates' && <UpdatesPage hw={hw} wu={wu} gpu={gpu} bios={bios} scan={scan} onScan={fullScan} onInstall={installDrivers} onGpu={gpuInstall} onBiosDownload={biosDownload} onGuide={() => setGuide(true)} onEnable={enable} busy={busy} prog={prog} />}
        {page === 'hardware' && <HardwarePage hw={hw} onExport={exportHw} />}
        {page === 'overview' && <OverviewPage junk={junk} startup={startup} perf={perf} recs={recs} go={setPage} />}
        {page === 'clean' && <CleanPage junk={junk} onRescan={loadJunk} onClean={clean} busy={busy} />}
        {page === 'startup' && <StartupPage startup={startup} onToggle={toggle} busy={busy} prog={prog} />}
        {page === 'perf' && <PerfPage perf={perf} onRefresh={() => { setPerf(null); loadPerf(); }} onInstallService={installService} busy={busy} />}
        {page === 'recs' && <RecsPage recs={recs} bios={bios} onApply={apply} onBiosDownload={biosDownload} onGuide={() => setGuide(true)} busy={busy} prog={prog} />}
        {page === 'history' && <HistoryPage busy={busy} onRestorePoint={restorePoint} />}
        {page === 'settings' && <SettingsPage version={version} status={appUpdate} settings={settings} service={service} onInstallService={installService} onRemoveService={removeService} busy={busy} prog={prog} onPickDir={async () => setSettings(await api.pickSaveDir())} onCheck={async () => { setAppUpdate({ state: 'checking' }); if (!(await api.checkAppUpdate())) setAppUpdate({ state: 'dev' }); }} />}
      </main>
      {guide && bios?.latest && <BiosGuide bios={bios} onClose={() => setGuide(false)} onDownload={biosDownload} busy={busy === 'bios'} prog={prog.bios} />}
    </div>
  );
}
