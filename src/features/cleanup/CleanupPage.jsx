// Leftover files, by category.
import { useEffect, useState } from 'react';
import { FolderOpen, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { useT } from '../../i18n.js';
import { fmtGB } from '../../presentation/format.jsx';

export function CleanPage({ junk, failed, onRescan, onClean, busy }) {
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
        {failed && <div className="finding warn scan-failed">{t(junk ? 'scan.failedLast' : 'scan.failedNone')}</div>}
        <div className="panel-title">{junk ? t('cl.found', { size: fmtGB((junk || []).reduce((s, c) => s + c.bytes, 0)) }) : failed ? t('rec.unchecked') : t('scanning')}</div>
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
