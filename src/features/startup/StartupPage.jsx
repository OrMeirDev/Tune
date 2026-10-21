// Apps that start with Windows.
import { Rocket } from 'lucide-react';
import { DetailsDisclosure } from '../../components/DetailsDisclosure.jsx';
import { ProgressPill } from '../../components/TaskProgress.jsx';
import { useT } from '../../i18n.js';

export function StartupPage({ startup, failed, onToggle, busy, prog }) {
  const t = useT();
  return (
    <>
      <header className="page-header"><div><h1>{t('st.title')}</h1><p className="subtitle">{t('st.subtitle')}</p></div></header>
      <section className="panel">
        {failed && <div className="finding warn scan-failed">{t(startup ? 'scan.failedLast' : 'scan.failedNone')}</div>}
        <div className="panel-title">{startup ? t('ov.activeOf', { n: startup.filter((s) => s.enabled).length, total: startup.length }) : failed ? t('rec.unchecked') : t('loading')}</div>
        {(startup || []).map((s) => (
          <div key={s.source + s.key} className="drow">
            <span className="dicon"><Rocket size={16} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="dname">{s.name}</div>
              <DetailsDisclosure context={s.name}>
                <p className="path-text" dir="ltr">{s.cmd}</p>
              </DetailsDisclosure>
            </div>
            <div className="acts">
              {s.admin && <span className="src">{t('st.admin')}</span>}
              {busy === s.source + s.key ? <ProgressPill p={prog[busy]} fallback={t('prog.changing')} />
                : <button className={`toggle ${s.enabled ? 'on' : ''}`} role="switch" aria-checked={!!s.enabled} aria-label={`${s.name}: ${t(s.enabled ? 'st.turnOff' : 'st.turnOn')}`} disabled={!!busy} onClick={() => onToggle(s, !s.enabled)} />}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
