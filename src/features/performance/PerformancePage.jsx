// CPU and memory: live readings and the busiest processes.
import { AlertTriangle, Check, Cpu, HardDrive, Loader2, Monitor, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n.js';
import { cpuNoteKey, ltr, rpm, tempClass } from '../../presentation/format.jsx';
import { LiveCpu } from '../sensors/CpuMetrics.jsx';
import { performanceReadings } from '../../domain/performance-readings.mjs';
import { coolingFindings } from './coolingFindings.js';

export function PerfPage({ perf, live, history = [], service, onRefresh, onInstallService, busy }) {
  const t = useT();
  const findings = coolingFindings(history, t);
  const current = performanceReadings(live, perf);
  const gpu = current.gpu;
  const gb = v => Number.isFinite(v) ? ltr(`${v.toFixed(1)} GB`) : '—';
  const gpuTile = (
    <div key="gpu" className="stat" title={gpu?.name || ''}>
      <span><Monitor size={13} /> {t('pf.gpuTemp')}</span>
      {gpu ? (<>
        <b className={tempClass(gpu.tempC)}>{ltr(`${gpu.tempC}°C`)}</b>
        <small>{[gpu.hotspotC ? t('pf.hotspot', { t: ltr(`${gpu.hotspotC}°C`) }) : null, gpu.fanRpm ? t('pf.fan', { rpm: rpm(gpu.fanRpm, t) }) : null].filter(Boolean).join(' · ') || gpu.name}</small>
      </>) : <><b className="na">—</b><small>{t('pf.gpuNone')}</small></>}
    </div>
  );
  return (
    <>
      <header className="page-header">
        <div><h1>{t('pf.title')}</h1><p className="subtitle">{t('pf.subtitle')}</p></div>
        <button className="btn-ghost" onClick={onRefresh}><RefreshCw size={14} /> {t('pf.refresh')}</button>
      </header>
      {!perf ? <div className="center-msg"><Loader2 size={16} className="spin" /></div> : (<>
        <div className="stats three">
          <div className="stat"><span>{t('pf.cpuLoad')}</span><b>{current.cpuLoad == null ? '—' : `${current.cpuLoad}%`}</b></div>
          <div className="stat"><span>{t('pf.ramUsed')}</span><b>{gb(current.ramUsedGB)}</b></div>
          <div className="stat"><span>{t('pf.ramFree')}</span><b>{gb(current.ramFreeGB)}</b></div>
        </div>
        <LiveCpu live={current.live} service={service} onInstallService={onInstallService} busy={busy} extra={[gpuTile]} />
        {perf.cpuTempC == null && perf.cpuNote && perf.cpuNote !== 'no service' && <div className="dmeta">{t(cpuNoteKey(perf.cpuNote))}</div>}
        {findings.map((f) => (
          <div key={f.text} className={`finding ${f.level}`}>
            {f.level === 'ok' ? <Check size={15} /> : <AlertTriangle size={15} />}
            <div><b>{f.text}</b>{f.tips && <div>{f.tips}</div>}</div>
          </div>
        ))}
        {perf.refreshedAt && <div className="dmeta">{t('pf.snapshot', { at: new Date(perf.refreshedAt).toLocaleTimeString() })}</div>}
        <div className="grid2">
          <div className="ocard"><div className="ohead"><span><Cpu size={16} /> {t('pf.topCpu')}</span></div>
            {[].concat(perf.topCpu || []).map((p) => <div key={p.name} className="orow"><span>{p.name}{p.count > 1 ? ` (${p.count})` : ''}</span><span>{p.cpu}%</span></div>)}</div>
          <div className="ocard"><div className="ohead"><span><HardDrive size={16} /> {t('pf.topRam')}</span></div>
            {[].concat(perf.topRam || []).map((p) => <div key={p.name} className="orow"><span>{p.name}{p.count > 1 ? ` (${p.count})` : ''}</span><span>{ltr(`${(p.ramMB / 1024).toFixed(1)} GB`)}</span></div>)}</div>
        </div>
      </>)}
    </>
  );
}
