// The overview: a summary of every area, with links to the pages.
import { Loader2, Rocket, Settings2, Thermometer, Trash2 } from 'lucide-react';
import { useT } from '../../i18n.js';
import { fmtGB, ltr, tempClass } from '../../presentation/format.jsx';
import { statusRank } from '../diagnostics/findingSelectors.js';
import { recTitle } from '../diagnostics/recommendationText.js';

export function OverviewPage({ junk, startup, perf, live, recs, go }) {
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
