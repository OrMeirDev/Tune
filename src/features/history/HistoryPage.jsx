// What Tune did, and restore points.
import { useEffect, useState } from 'react';
import { RotateCcw, ShieldCheck, Undo2 } from 'lucide-react';
import { api } from '../../api.js';
import { useT } from '../../i18n.js';
import { fmtDate, fmtGB, tOr } from '../../presentation/format.jsx';

export function HistoryPage({ busy, onRestorePoint }) {
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
