// Before and after (plan PF02): what each change measurably did, the latest measurements, and a rest
// measurement on request. A result is credited only when both sides were measured the same way;
// otherwise both values are shown and nothing is claimed.
import { Download, Gauge, Info, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { ProgressPill } from '../../components/TaskProgress.jsx';
import { useT } from '../../i18n.js';
import { fmtDate } from '../../presentation/format.jsx';
import { describeChange } from '../history/describeChange.js';
import { bootKind, fmtDelta, fmtMeasure, metricName } from './measureText.js';

const STATE_ICON = { better: TrendingUp, worse: TrendingDown, same: Minus };
// what a change is waiting for before its effect can be measured
const WAITING_FOR = { bootAfterLogonMs: 'boot', bootToDesktopMs: 'boot', restCpuTempC: 'rest', restCpuLoad: 'rest' };

// One measured effect of one change.
function ResultLine({ r }) {
  const t = useT();
  const what = metricName(r.metric, t);
  const unit = r.before?.unit || r.after?.unit;
  if (r.state === 'waiting') {
    return <div className="ba-line muted">{t(`ba.waiting.${WAITING_FOR[r.metric] || 'rest'}`, { what })}{r.before ? ` · ${t('ba.lastBefore', { v: fmtMeasure(r.before.value, unit, t) })}` : ''}</div>;
  }
  if (r.state === 'missing') return <div className="ba-line muted">{t('ba.missing', { what })} · {t(`ba.why.${r.reason || 'notRecorded'}`)}</div>;
  const Icon = STATE_ICON[r.state] || Info;
  // before, then after, in reading order (the arrow points the other way in Hebrew)
  const values = `${fmtMeasure(r.before?.value, unit, t)} ${t('arrow')} ${fmtMeasure(r.after?.value, unit, t)}`;
  return (
    <div className={`ba-line ba-${r.state}`}>
      <Icon size={13} /> <span>{what}: {values}</span>
      {['better', 'worse'].includes(r.state) && <b>{fmtDelta(r.delta, unit, t)}</b>}
      <span className={`tag s-${r.state}`}>{t(`ba.s.${r.state}`)}</span>
      {r.state === 'notComparable' && <span className="ba-why">{t(`ba.why.${r.reason}`)}</span>}
      {r.before?.count > 1 && <span className="ba-why">{t(r.metric.startsWith('boot') ? 'ba.medianBoots' : 'ba.median', { n: r.before.count })}</span>}
      {r.metric.startsWith('boot') && r.after?.conditions?.bootType && <span className="ba-why">{bootKind(r.after.conditions.bootType, t)}</span>}
      {r.confounded && <span className="ba-why warn-text">{t('ba.confounded')}</span>}
    </div>
  );
}

// What one change did, under its description (also used on the history page).
export function ChangeEffect({ change }) {
  const t = useT();
  if (!change) return null;
  if (change.note) return <div className="ba-line muted">{t(`ba.note.${change.note}`)}</div>;
  return <>{change.results.map((r) => <ResultLine key={r.metric} r={r} />)}</>;
}

// The latest measurements: at rest, and the last start of Windows.
function Latest({ latest }) {
  const t = useT();
  const load = latest.restCpuLoad;
  const desk = latest.bootToDesktopMs;
  const after = latest.bootAfterLogonMs;
  const restParts = load ? [
    t('ba.rest.load', { v: fmtMeasure(load.value, '%') }),
    latest.restCpuTempC?.value != null && latest.restCpuTempC.at === load.at ? t('ba.rest.temp', { v: fmtMeasure(latest.restCpuTempC.value, '°C') }) : null,
    latest.restRamUsedBytes?.value != null && latest.restRamUsedBytes.at === load.at ? t('ba.rest.ram', { v: fmtMeasure(latest.restRamUsedBytes.value, 'bytes') }) : null,
  ].filter(Boolean) : [];
  return (
    <div className="ba-latest">
      <div><b>{t('ba.atRest')}</b> {load ? <>{restParts.join(' · ')} <span className="muted">· {fmtDate(load.at, t)}{load.conditions?.loadBand === 'busy' ? ` · ${t('ba.wasBusy')}` : ''}</span></> : <span className="muted">{t('ba.notYet')}</span>}</div>
      <div><b>{t('ba.lastStart')}</b> {desk || after
        ? <>{[desk && t('ba.start.desk', { v: fmtMeasure(desk.value, 'ms', t) }), after && t('ba.start.after', { v: fmtMeasure(after.value, 'ms', t) })].filter(Boolean).join(' · ')} <span className="muted">· {fmtDate((desk || after).conditions?.startedAt || (desk || after).at, t)} · {bootKind((desk || after).conditions?.bootType, t)}</span></>
        : <span className="muted">{t('ba.notYet')}</span>}</div>
    </div>
  );
}

export function BeforeAfter({ view, onMeasure, onExport, busy, prog, scanning }) {
  const t = useT();
  const changes = (view?.changes || []).slice(0, 6);
  return (
    <section className="panel ba-panel" aria-label={t('ba.title')}>
      <div className="panel-title">
        <span>{t('ba.title')}</span>
        <span className="acts">
          {busy === 'measure' ? <ProgressPill p={prog.measure} fallback={t('prog.measure')} />
            : <button className="btn-ghost small" onClick={onMeasure} disabled={!!busy || scanning} title={t(scanning ? 'ba.waitScan' : 'ba.measureTitle')}><Gauge size={14} /> {t('ba.measure')}</button>}
          <button className="icon-btn ghost" onClick={onExport} disabled={!!busy || !view?.records?.length} title={t('ba.export')} aria-label={t('ba.export')}><Download size={15} /></button>
        </span>
      </div>
      <div className="ba-body">
        <div className="dmeta ba-intro">{t('ba.intro')}</div>
        {view && <Latest latest={view.latest || {}} />}
        {view && !changes.length && <div className="dmeta">{t('ba.noChanges')}</div>}
        {changes.map((c, i) => (
          <div key={c.id || i} className="ba-change">
            <div className="dname" style={{ whiteSpace: 'normal' }}>{describeChange(c, t)} <span className="muted ba-when">{fmtDate(c.at, t)}</span></div>
            <ChangeEffect change={c} />
          </div>
        ))}
      </div>
    </section>
  );
}
