// One row of the performance center.
import { AlertTriangle, BookOpen, Check, Download, ExternalLink, Info, Loader2 } from 'lucide-react';
import { api } from '../../api.js';
import { DetailsDisclosure } from '../../components/DetailsDisclosure.jsx';
import { ProgressPill } from '../../components/TaskProgress.jsx';
import { useT } from '../../i18n.js';
import { ltr } from '../../presentation/format.jsx';
import { recIf, recNote, recTitle, recValue } from './recommendationText.js';

export function CenterRow({ r, bios, onApply, onBiosDownload, onBiosGuide, onGuide, go, busy, prog }) {
  const t = useT();
  const isBios = r.key === 'bios';
  const note = isBios && !r.unchecked && bios?.supported
    ? (bios.newer ? `${t('rc.biosNewer', { v: bios.latest.version, maker: bios.maker, date: bios.latest.date })} ${recNote(r, t)}`
      : bios.onBeta ? t('rc.biosOnBeta', { v: bios.installed, stable: bios.latest.version, maker: bios.maker })
        : t('rc.biosLatest', { maker: bios.maker })) + (bios.beta ? t('rc.biosBetaToo', { v: bios.beta.version }) : '')
    : recNote(r, t);
  const value = String(recValue(r, t) ?? '');
  const tip = r.ok == null && !isBios;
  return (
    <div className="drow">
      <span className={`dicon ${r.ok === false ? 'warn' : r.ok === true ? 'good' : ''}`}>{r.ok === false ? <AlertTriangle size={16} /> : r.ok === true ? <Check size={16} /> : <Info size={16} />}</span>
      <div style={{ minWidth: 0 }}>
        <div className="dname">{recTitle(r, t)}{value && <> · <span style={{ fontWeight: 400 }}>{/^0x/.test(value) ? ltr(value) : value.replace(/\(?\d[\d.,:/-]*\)?(?:\s?(?:GB|MB|W|V|GHz|MT\/s))?/g, (m) => ltr(m))}</span></>}</div>
        {/* Missing checks and BIOS information stay visible; background explanations are optional. */}
        {(r.unchecked || isBios) && <div className="dmeta">{note}</div>}
        {r.action && r.key === 'hags' && <div className="dmeta">{t('ui.restartNote')}</div>}
        {!r.unchecked && (!isBios || r.ok === false) && <DetailsDisclosure label={t('ui.recommendationDetails')} context={recTitle(r, t)}>
          {!isBios && <p>{note}</p>}
          {r.ok === false && <p className="if-not">{recIf(r, t)}</p>}
        </DetailsDisclosure>}
      </div>
      <div className="acts">
        {r.ok === true && <span className="ok-text">{t('ok')}</span>}
        {tip && <span className="note">{t(r.unchecked ? 'rec.unchecked' : 'cc.tip')}</span>}
        {r.guide && <button className={r.ok === false ? 'btn-primary' : 'btn-ghost'} onClick={() => onGuide(r)}><BookOpen size={14} /> {t('cc.how')}</button>}
        {r.go && r.ok === false && <button className="btn-primary" onClick={() => go(r.go)}>{t(`cc.go.${r.go}`)}</button>}
        {r.go && r.ok !== false && <button className="btn-ghost" onClick={() => go(r.go)}>{t('cc.open')}</button>}
        {r.key === 'microcode' && r.ok === false && <button className="btn-primary" onClick={onBiosGuide}>{t('cc.toBios')}</button>}
        {isBios && !r.unchecked && bios?.supported && bios.newer && (busy === 'bios' ? <ProgressPill p={prog.bios} fallback={t('prog.downloading')} /> : (<>
          <button className="btn-ghost" onClick={onBiosGuide}><Info size={14} /> {t('up.howInstall')}</button>
          <button className="btn-primary" disabled={!!busy} onClick={onBiosDownload}><Download size={14} /> {t('rc.download')}</button>
        </>))}
        {isBios && !bios && <Loader2 size={15} className="spin" />}
        {isBios && bios && !bios.supported && <button className="btn-ghost" onClick={() => api.openLink(bios.page || r.link)}><ExternalLink size={14} /> {t('rc.searchMaker')}</button>}
        {r.action && !isBios && (busy === r.key ? <ProgressPill p={prog[r.key]} fallback={t('prog.applying')} />
          : <button className="btn-primary" disabled={!!busy} onClick={() => onApply(r)}>{t(r.key === 'power' ? 'rc.applyPlan' : 'rc.apply')}</button>)}
      </div>
    </div>
  );
}
