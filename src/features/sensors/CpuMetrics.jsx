// The live CPU tiles.
import { Activity, Gauge, Info, Loader2, Thermometer, Zap } from 'lucide-react';
import { useT } from '../../i18n.js';
import { ltr, tempClass } from '../../presentation/format.jsx';

// Temperature, power, voltage and clock of the CPU as tiles; `extra` adds tiles after them.
// Without the service (or with an older one) it says what to do to see them.
export function LiveCpu({ live, service, onInstallService, busy, extra = [] }) {
  const t = useT();
  const v = live || {};
  const tiles = [
    { key: 'temp', icon: Thermometer, label: t('lv.temp'), value: v.cpuTempC != null ? `${v.cpuTempC}°C` : null, cls: tempClass(v.cpuTempC) },
    { key: 'power', icon: Zap, label: t('lv.power'), value: v.cpuPowerW != null ? `${v.cpuPowerW} W` : null, title: t('lv.powerTitle') },
    { key: 'volt', icon: Activity, label: t(v.cpuVoltageSource === 'vid' ? 'lv.voltVid' : 'lv.volt'), value: v.cpuVoltageV != null ? `${Number(v.cpuVoltageV).toFixed(3)} V` : null, title: t(v.cpuVoltageSource === 'vid' ? 'lv.voltVidTitle' : 'lv.voltTitle') },
    { key: 'clock', icon: Gauge, label: t('lv.clock'), value: v.cpuClockMHz != null ? `${(v.cpuClockMHz / 1000).toFixed(2)} GHz` : null },
  ];
  const noService = live && v.cpuNote === 'no service';
  const outdated = service?.running && !service.current;
  const hint = noService ? t('lv.noService') : outdated ? t('lv.outdated') : ['stale', 'unverified'].includes(v.cpuNote) ? t(`lv.${v.cpuNote}`) : null;
  return (
    <>
      <div className={`stats live n${tiles.length + extra.length}`}>
        {tiles.map((x) => (
          <div key={x.key} className="stat" title={x.title || ''}>
            <span><x.icon size={13} /> {x.label}</span>
            {x.value != null ? <b className={x.cls || ''}>{ltr(x.value)}</b> : <b className="na">{live ? '—' : <Loader2 size={15} className="spin" />}</b>}
          </div>
        ))}
        {extra}
      </div>
      {hint && (
        <div className="finding warn live-hint">
          <Info size={15} />
          <div>{hint} {(noService || outdated) && <button className="link-btn" onClick={onInstallService} disabled={!!busy}>{t(noService ? 'lv.install' : 'lv.update')}</button>}</div>
        </div>
      )}
    </>
  );
}
