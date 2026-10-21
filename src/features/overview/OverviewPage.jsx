// The overview: a summary of every area, with links to the pages.
import { Loader2, Rocket, Settings2, Thermometer, Trash2 } from 'lucide-react';
import { useT } from '../../i18n.js';
import { fmtGB, ltr, tempClass } from '../../presentation/format.jsx';
import { statusRank } from '../diagnostics/findingSelectors.js';
import { recTitle } from '../diagnostics/recommendationText.js';
import { PROBLEM_LIST } from '../diagnose/problems.js';

export function OverviewPage({ junk, startup, perf, live, recs, go, onProblem, sources = {} }) {
  const t = useT();
  const junkTotal = (junk || []).reduce((s, c) => s + c.bytes, 0);
  const startOn = (startup || []).filter((s) => s.enabled).length;
  const toImprove = (recs || []).filter((r) => r.ok === false).length;
  const toReview = (recs || []).filter((r) => r.ok == null).length;
  const cpuTemp = live ? live.cpuTempC : perf?.cpuTempC;
  return (
    <>
      <header className="page-header"><div><h1>{t('ov.title')}</h1><p className="subtitle">{t('ov.subtitle')}</p></div></header>
      <div className="problem-strip">
        <span>{t('ov.problem')}</span>
        {PROBLEM_LIST.map((p) => <button key={p.id} className="btn-ghost" onClick={() => onProblem(p.id)}><p.icon size={15} /> {t(`dx.p.${p.id}`)}</button>)}
      </div>
      <div className="grid2">
        <div className="ocard">
          <div className="ohead"><span><Trash2 size={16} /> {t('ov.clean')}</span><b style={{ color: 'var(--accent)' }}>{junk && sources.junk !== 'error' ? fmtGB(junkTotal) : sources.junk === 'error' ? '—' : '…'}</b></div>
          <div className="overview-card-body">
            {sources.junk === 'error' && <p className="overview-state">{t(junk ? 'scan.failedLast' : 'scan.failedNone')}</p>}
            {(junk || []).filter((c) => c.bytes > 1e6).slice(0, 2).map((c) => <div key={c.key} className="orow"><span>{t(`junk.${c.key}`)}</span><span>{fmtGB(c.bytes)}</span></div>)}
          </div>
          <div className="ofoot"><span /><button className="btn-primary" onClick={() => go('clean')}>{t('ov.toClean')}</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Rocket size={16} /> {t('ov.startup')}</span><span className="muted">{startup && sources.startup !== 'error' ? t('ov.activeOf', { n: startOn, total: startup.length }) : sources.startup === 'error' ? '—' : '…'}</span></div>
          <div className="overview-card-body">
            {sources.startup === 'error' && <p className="overview-state">{t(startup ? 'scan.failedLast' : 'scan.failedNone')}</p>}
            {(startup || []).filter((s) => s.enabled).slice(0, 2).map((s) => <div key={s.source + s.key} className="orow"><span>{s.name}</span><span className="ok-text">{t('ov.active')}</span></div>)}
          </div>
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('startup')}>{t('ov.allList')}</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Thermometer size={16} /> {t('ov.perf')}</span>{cpuTemp != null && <b className={tempClass(cpuTemp)} title={t('lv.temp')}>{ltr(`${cpuTemp}°C`)}</b>}</div>
          <div className="overview-card-body">
            {perf ? (<>
              <div className="orow"><span>{t('ov.cpuLoad')}</span><span>{perf.cpuLoad}%</span></div>
              <div className="orow"><span>{t('ov.ramUsed')}</span><span>{ltr(`${(perf.ramTotalGB - perf.ramFreeGB).toFixed(1)} / ${perf.ramTotalGB} GB`)}</span></div>
              {['stale', 'unverified'].includes(live?.cpuNote) && <p className="overview-state">{t(`lv.${live.cpuNote}`)}</p>}
            </>) : <div className="center-msg"><Loader2 size={16} className="spin" /></div>}
          </div>
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('perf')}>{t('ov.details')}</button></div>
        </div>
        <div className="ocard">
          <div className="ohead"><span><Settings2 size={16} /> {t('ov.recs')}</span><span className="muted">{recs ? (toImprove ? (toImprove === 1 ? t('ov.oneToImprove') : t('ov.toImprove', { n: toImprove })) : toReview ? t('ui.reviewCount', { n: toReview }) : t('ov.allOk')) : '…'}</span></div>
          <div className="overview-card-body">
            {[...(recs || [])].sort((a, b) => statusRank(a.ok) - statusRank(b.ok)).slice(0, 2).map((r) => (
              <div key={r.key} className="orow"><span>{recTitle(r, t)}</span>{r.ok === true ? <span className="ok-text">{t('ok')}</span> : r.ok === false ? <span className="warn-text">{t('improve')}</span> : <span className="note">{t(r.guide ? 'cc.tip' : 'toCheck')}</span>}</div>
            ))}
          </div>
          <div className="ofoot"><span /><button className="btn-ghost" onClick={() => go('recs')}>{t('ov.allRecs')}</button></div>
        </div>
      </div>
    </>
  );
}
