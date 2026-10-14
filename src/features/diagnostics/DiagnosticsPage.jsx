// The performance center: every check in one place.
import React, { useMemo } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n.js';
import { ltr } from '../../presentation/format.jsx';
import { LiveCpu } from '../sensors/CpuMetrics.jsx';
import { CenterRow } from './FindingRow.jsx';
import { GROUPS, centerItems, statusRank } from './findingSelectors.js';

export function CenterPage({ recs, bios, gpu, junk, startup, live, history, service, onInstallService, onRefresh, onGuide, onBiosGuide, go, ...rowProps }) {
  const t = useT();
  const items = useMemo(() => centerItems({ recs, bios, gpu, junk, startup, live, history }), [recs, bios, gpu, junk, startup, live, history]);
  const judged = items.filter((i) => i.ok != null);
  const good = judged.filter((i) => i.ok).length;
  return (
    <>
      <header className="page-header">
        <div><h1>{t('cc.title')}</h1><p className="subtitle">{t('cc.subtitle')}</p></div>
        <div className="header-actions">
          {recs && <div className={`score ${good === judged.length ? 'all' : ''}`} title={t('cc.scoreTitle')}><b>{ltr(`${good}/${judged.length}`)}</b> {t('cc.okCount')}</div>}
          <button className="btn-ghost" onClick={onRefresh} disabled={!recs}><RefreshCw size={14} /> {t('pf.refresh')}</button>
        </div>
      </header>
      <LiveCpu live={live} service={service} onInstallService={onInstallService} busy={rowProps.busy} />
      <section className="panel">
        {!recs ? <div className="center-msg"><Loader2 size={16} className="spin" /> {t('loading')}</div> : GROUPS.map((g) => {
          const list = items.filter((i) => i.group === g.id).sort((a, b) => statusRank(a.ok) - statusRank(b.ok));
          if (!list.length) return null;
          const bad = list.filter((i) => i.ok === false).length;
          return (
            <React.Fragment key={g.id}>
              <div className="group-title"><g.icon size={14} /> {t(`cc.g.${g.id}`)}{bad > 0 && <span className="warn-text">{bad === 1 ? t('ov.oneToImprove') : t('ov.toImprove', { n: bad })}</span>}</div>
              {list.map((r) => <CenterRow key={r.key} r={r} bios={bios} go={go} onGuide={onGuide} onBiosGuide={onBiosGuide} {...rowProps} />)}
            </React.Fragment>
          );
        })}
      </section>
    </>
  );
}
