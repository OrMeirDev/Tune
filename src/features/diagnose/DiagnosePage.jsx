// Fix a problem (plan PF01): the user picks what bothers them, Tune runs the checks that fit, and
// shows what it found ranked by likely impact, with the measurement, how sure it is and one next
// step each. "Check again" re-runs them after a change; the before/after panel shows what the
// change measurably did (PF02).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Check, HelpCircle, Info, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../../api.js';
import { ProgressPill } from '../../components/TaskProgress.jsx';
import { diagnose } from '../../domain/diagnosis.mjs';
import { useT } from '../../i18n.js';
import { fmtDate } from '../../presentation/format.jsx';
import { BeforeAfter } from './BeforeAfter.jsx';
import { bootKind } from './measureText.js';
import { PROBLEM_LIST } from './problems.js';

// The words for a finding: its numbers, the date of the start it measured, the kind of start; the
// check's own wording, or the shared one for why a check couldn't run (dx.say.*).
const varsOf = (f, t) => ({ ...f.vars, at: f.vars.at ? fmtDate(f.vars.at, t) : '', kind: f.vars.kind ? bootKind(f.vars.kind, t) : '' });
function sayText(f, t) {
  const key = `dx.${f.key}.${f.say}`;
  const s = t(key, varsOf(f, t));
  return s === key ? t(`dx.say.${f.say}`, varsOf(f, t)) : s;
}

function FindingRow({ f, recs, onAction, busy, prog }) {
  const t = useT();
  const icon = f.certainty === 'pending' ? <Loader2 size={16} className="spin" /> : f.ok === false ? <AlertTriangle size={16} /> : f.ok === true ? <Check size={16} /> : <HelpCircle size={16} />;
  const a = f.action;
  const rec = a?.rec && (recs || []).find((r) => r.key === a.rec);
  const primary = f.ok === false;
  let button = null;
  if (a?.kind === 'apply' && rec) {
    button = busy === rec.key ? <ProgressPill p={prog[rec.key]} fallback={t('prog.applying')} />
      : <button className={primary ? 'btn-primary small' : 'btn-ghost'} disabled={!!busy} onClick={() => onAction(a, rec)}>{t('dx.do.apply')}</button>;
  } else if (a?.kind === 'guide' && rec) {
    button = <button className={primary ? 'btn-primary small' : 'btn-ghost'} onClick={() => onAction(a, rec)}><BookOpen size={14} /> {t('cc.how')}</button>;
  } else if (a?.kind === 'go') {
    button = <button className={primary ? 'btn-primary small' : 'btn-ghost'} onClick={() => onAction(a)}>{t(`dx.go.${a.page}`)}</button>;
  } else if (a?.kind === 'installService') {
    button = <button className="btn-ghost" disabled={!!busy} onClick={() => onAction(a)}>{t('dx.do.installService')}</button>;
  } else if (a?.kind === 'recheck') {
    button = <button className="btn-ghost" disabled={!!busy} onClick={() => onAction(a)}><RefreshCw size={14} /> {t('dx.recheck')}</button>;
  }
  return (
    <div className="drow dx-row">
      <span className={`dicon ${f.ok === false ? 'warn' : f.ok === true ? 'good' : ''}`}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div className="dname">
          {t(`dx.${f.key}.title`)}
          {f.certainty !== 'pending' && <span className={`tag c-${f.ok === true ? 'ok' : f.certainty}`}>{t(`dx.c.${f.ok === true ? 'ok' : f.certainty}`)}</span>}
          {f.ok === false && <span className={`tag i-${f.impact}`}>{t(`dx.i.${f.impact}`)}</span>}
        </div>
        <div className="dmeta" style={{ whiteSpace: 'normal' }}>{f.certainty === 'pending' ? t('dx.checking') : sayText(f, t)}</div>
      </div>
      <div className="acts">{button}</div>
    </div>
  );
}

function verdictText(d, t) {
  if (d.state === 'found') return d.problems === 1 ? t('dx.v.foundOne') : t('dx.v.found', { n: d.problems });
  if (d.state === 'checking') return t('dx.v.checking');
  if (d.state === 'incomplete') return t('dx.v.incomplete', { n: d.unchecked });
  return t('dx.v.nothing', { n: d.findings.length });
}

export function DiagnosePage({ problem, onProblem, recs, gpu, startup, perf, history, sources, service, scanning, go, onApply, onGuide, onInstallService, onRecheck, onMeasure, onExport, measured, busy, prog }) {
  const t = useT();
  const [view, setView] = useState(null);
  const [facts, setFacts] = useState(null);
  const [bootBusy, setBootBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  const loadView = useCallback(async () => {
    const r = await api.measureList().catch(() => null);
    if (r?.ok) setView(r.data);
  }, []);
  // Windows' start-up records are read when the start-up problem is picked (and on "check again").
  const readBoot = useCallback(async () => {
    setBootBusy(true);
    const r = await api.measureTake('boot').catch(() => null);
    setBootBusy(false);
    // a failed read is "couldn't read", shown as not checked
    setFacts(r?.ok ? r.data : { timings: r?.error === 'busy' ? 'busy' : 'unavailable', systemMedia: 'unknown', fastStartup: null });
    loadView();
  }, [loadView]);

  useEffect(() => { loadView(); }, [loadView, measured]);
  useEffect(() => { if (problem === 'slowBoot' && !facts && !bootBusy) readBoot(); }, [problem, facts, bootBusy, readBoot]);

  const boot = useMemo(() => (facts && view ? { facts, latest: view.latest || {} } : null), [facts, view]);
  const d = useMemo(() => (problem ? diagnose(problem, { recs, gpu, startup, perf, samples: history, sources, service, scanning, boot }) : null),
    [problem, recs, gpu, startup, perf, history, sources, service, scanning, boot]);

  const recheck = async () => {
    setRechecking(true);
    await Promise.all([onRecheck(), problem === 'slowBoot' ? readBoot() : null]).catch(() => {});
    setRechecking(false);
  };
  const onAction = (a, rec) => {
    if (a.kind === 'go') go(a.page);
    else if (a.kind === 'apply') onApply(rec);
    else if (a.kind === 'guide') onGuide(rec);
    else if (a.kind === 'installService') onInstallService();
    else if (a.kind === 'recheck') recheck();
  };

  return (
    <>
      <header className="page-header">
        <div><h1>{t('dx.title')}</h1><p className="subtitle">{t('dx.subtitle')}</p></div>
        <div className="header-actions">
          <button className="btn-ghost" onClick={recheck} disabled={!problem || !!busy || rechecking}>{rechecking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {t('dx.recheck')}</button>
        </div>
      </header>
      <div className="problem-picker" role="radiogroup" aria-label={t('dx.pick')}>
        {PROBLEM_LIST.map((p) => (
          <button key={p.id} role="radio" aria-checked={problem === p.id} className={`problem ${problem === p.id ? 'active' : ''}`} onClick={() => onProblem(p.id)}>
            <p.icon size={20} />
            <span><b>{t(`dx.p.${p.id}`)}</b><small>{t(`dx.p.${p.id}.hint`)}</small></span>
          </button>
        ))}
      </div>
      <div className="dx-body">
        <section className="panel" aria-live="polite">
          {!d ? <div className="center-msg">{t('dx.pickFirst')}</div> : (<>
            <div className="panel-title">
              <span>{verdictText(d, t)}</span>
              {d.state === 'found' && d.waiting > 0 && <span className="note"><Loader2 size={12} className="spin" /> {t('dx.stillChecking', { n: d.waiting })}</span>}
            </div>
            {d.state === 'nothingFound' && <div className="finding ok dx-verdict"><Info size={15} /><div>{t('dx.v.nothingNote')}</div></div>}
            {d.findings.map((f) => <FindingRow key={f.key} f={f} recs={recs} onAction={onAction} busy={busy} prog={prog} />)}
            {d.limits.map((l) => <div key={l} className="dmeta dx-limit"><Info size={13} /> {t(`dx.limit.${l}`)}</div>)}
          </>)}
        </section>
        <BeforeAfter view={view} onMeasure={onMeasure} onExport={onExport} busy={busy} prog={prog} scanning={scanning} />
      </div>
    </>
  );
}
