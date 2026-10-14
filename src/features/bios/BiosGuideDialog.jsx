// How to install a BIOS update, per maker.
import { AlertTriangle, Download, ExternalLink, X } from 'lucide-react';
import { api } from '../../api.js';
import { ProgressPill } from '../../components/TaskProgress.jsx';
import { useT } from '../../i18n.js';
import { ltr, rich } from '../../presentation/format.jsx';

// BIOS can't be updated from Windows safely on most boards, so Tune downloads the verified file
// and explains the maker's own update tool.
export function BiosGuide({ bios, onClose, onDownload, busy, prog }) {
  const t = useT();
  if (!bios) return null;
  const l = bios.latest;
  const m = { maker: bios.maker };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal guide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{t('guide.title', { model: bios.model })}</h2>
            <div className="dmeta">{t('guide.installed', { v: bios.installed, d: bios.installedDate })} {t('arrow')} {t('guide.available')} <b>{l.version}</b> ({l.date}) · {ltr(l.size)}</div>
          </div>
          <button className="icon-btn ghost" onClick={onClose} aria-label={t('close')}><X size={16} /></button>
        </div>
        <div className="guide-body">
          {l.notes && <><div className="setting-title">{t('guide.whatsNew', m)}</div><div className="notes" dir="ltr">{l.notes}</div></>}
          {bios.flash === 'windows' ? (<>
            <div className="setting-title">{t('guide.winTitle', m)}</div>
            <ol>{[1, 2, 3, 4, 5].map((i) => <li key={i}>{rich(t(`guide.win${i}`, m))}</li>)}</ol>
          </>) : (<>
            <div className="setting-title">{t('guide.ezTitle')}</div>
            <ol>{[1, 2, 3, 4, 5, 6].map((i) => <li key={i}>{rich(t(`guide.ez${i}`))}</li>)}</ol>
          </>)}
          <div className="warn-box"><AlertTriangle size={14} /> {t('guide.warn')}</div>
        </div>
        <div className="modal-actions">
          {busy ? <ProgressPill p={prog} fallback={t('prog.downloading')} />
            : <button className="btn-primary" onClick={onDownload}><Download size={14} /> {t('guide.download', { size: ltr(l.size) })}</button>}
          <button className="btn-ghost" onClick={() => api.openLink(bios.page)}><ExternalLink size={14} /> {t('guide.page')}</button>
        </div>
      </div>
    </div>
  );
}
