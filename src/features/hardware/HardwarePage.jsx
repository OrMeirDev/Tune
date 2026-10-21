// The device list, with search and export.
import { useMemo, useState } from 'react';
import { FileSpreadsheet, FileText, Search } from 'lucide-react';
import { DetailsDisclosure } from '../../components/DetailsDisclosure.jsx';
import { useT } from '../../i18n.js';
import { shownDate } from '../../presentation/format.jsx';
import { classIcon } from './devicePresentation.js';

export function HardwarePage({ hw, onExport }) {
  const t = useT();
  const [q, setQ] = useState('');
  const list = useMemo(() => (hw?.devices || [])
    .filter((d) => !/^(Microsoft|\(Standard)/.test(d.provider || '') || q)
    .filter((d) => !q || `${d.name} ${d.provider} ${d.cls}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.cls || '').localeCompare(b.cls || '')), [hw, q]);
  return (
    <>
      <header className="page-header">
        <div><h1>{t('hw.title')}</h1><p className="subtitle">{hw ? t('hw.subtitle', { computer: hw.computer, v: hw.bios.version, d: hw.bios.date, ram: hw.ramGB }) : t('scanning')}</p></div>
        <div className="header-actions">
          <button className="btn-ghost" disabled={!hw} onClick={() => onExport('csv')} title={t('hw.exportExcelTitle')}><FileSpreadsheet size={14} /> {t('hw.exportExcel')}</button>
          <button className="btn-ghost" disabled={!hw} onClick={() => onExport('txt')} title={t('hw.exportTextTitle')}><FileText size={14} /> {t('hw.exportText')}</button>
        </div>
      </header>
      <label className="search"><Search size={16} /><input placeholder={t('hw.search')} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <section className="panel">
        <div className="panel-title">{q ? t('hw.results', { n: list.length }) : t('hw.count', { n: list.length })}</div>
        {list.map((d) => {
          const Icon = classIcon(d.cls, d.name);
          return (
            <div key={d.id} className="drow">
              <span className="dicon"><Icon size={17} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="dname">{d.name}</div>
                <DetailsDisclosure label={t('ui.driverDetails')} context={d.name}>
                  <p><bdi dir="ltr">{d.version}</bdi> · {shownDate(d.date)} · {d.provider || d.maker}</p>
                </DetailsDisclosure>
              </div>
              <span className="src">{d.cls || t('hw.other')}</span>
            </div>
          );
        })}
      </section>
    </>
  );
}
