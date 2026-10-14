// Apps that start with Windows.
import { Rocket } from 'lucide-react';
import { ProgressPill } from '../../components/TaskProgress.jsx';
import { useT } from '../../i18n.js';

export function StartupPage({ startup, onToggle, busy, prog }) {
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
                : <button className={`toggle ${s.enabled ? 'on' : ''}`} role="switch" aria-checked={!!s.enabled} aria-label={`${s.name}: ${t(s.enabled ? 'st.turnOff' : 'st.turnOn')}`} disabled={!!busy} onClick={() => onToggle(s, !s.enabled)} />}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
