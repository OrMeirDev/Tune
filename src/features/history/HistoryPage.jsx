// What Tune did, with what each change measurably did (plan PF02.3), and restore points.
import { useEffect, useState } from 'react';
import { RotateCcw, ShieldCheck, Undo2 } from 'lucide-react';
import { driverOutcome } from '../../domain/driver-outcome.mjs';
import { api } from '../../api.js';
import { useT } from '../../i18n.js';
import { fmtDate } from '../../presentation/format.jsx';
import { ChangeEffect } from '../diagnose/BeforeAfter.jsx';
import { describeChange } from './describeChange.js';

export function HistoryPage({ busy, onRestorePoint, measured }) {
  const t = useT();
  const [items, setItems] = useState([]);
  const [effects, setEffects] = useState(new Map());
  // Skip anything that isn't a Tune entry, so one malformed line can't take the whole page down.
  useEffect(() => {
    let stopped = false, timer;
    const load = async () => {
      try {
        const list = await api.getHistory();
        if (!stopped) setItems([].concat(list || []).filter(h => h && h.action && h.detail));
      } catch {}
      if (!stopped) timer = setTimeout(load, 5000);
    };
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [busy]);
  // what each change did, matched to its entry by ID (or, for older entries, by kind and time)
  useEffect(() => {
    api.measureList?.().then((r) => {
      if (r?.ok) setEffects(new Map([].concat(r.data.changes || []).map((c) => [c.id || `${c.action}|${c.at}`, c])));
    }).catch(() => {});
  }, [busy, measured]);
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
          <div key={h.id || i} className="drow">
            <span className="dicon"><RotateCcw size={16} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname" style={{ whiteSpace: 'normal' }}>{describeChange(h, t)}</div>
              <div className="dmeta">{fmtDate(h.at, t)}</div>
              {h.detail.operationState && <div className="dmeta">{t(['running', 'unknown', 'interrupted'].includes(h.detail.operationState) ? 'h.unknownHint' : 'h.recordedHint')}</div>}
              {[].concat(h.detail.results || h.detail.result?.data?.results || []).map((r, j) => <div key={r.id || j} className="dmeta">{r.title || r.id}: {t(`h.driver.${driverOutcome(r.code)}`)}</div>)}
              {h.detail.result?.error && <div className="dmeta">{h.detail.result.error}</div>}
              {h.detail.result?.data?.reboot && <div className="dmeta">{t('h.reboot')}</div>}
              <ChangeEffect change={effects.get(h.id || `${h.action}|${h.at}`)} />
            </div>
            <span />
          </div>
        ))}
      </section>
    </>
  );
}
