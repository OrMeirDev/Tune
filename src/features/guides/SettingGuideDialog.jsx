// Step-by-step guides for settings changed in the BIOS.
import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { api } from '../../api.js';
import { useT } from '../../i18n.js';
import { rich } from '../../presentation/format.jsx';
import { biosHint } from '../bios/biosGuides.js';

const GUIDE_STEPS = { channels: 5, xmp: 4, powerLimitIntel: 5, powerLimitAmd: 3 };

// Step-by-step for the changes Tune can't make from Windows (inside the PC or in the BIOS).
export function SettingGuide({ item, boardMaker, onClose }) {
  const t = useT();
  const kind = item.guide === 'powerLimit' ? (item.cpuKind === 'intelHybrid' ? 'powerLimitIntel' : 'powerLimitAmd') : item.guide;
  const h = biosHint(item.boardMaker || boardMaker);
  const profile = item.profile || 'XMP';
  const vars = { key: h.key, adv: h.adv, power: h.power, profile, option: h.xmp.replace('{profile}', profile), maker: h.name || t('g2.yourBoard') };
  const manual = item.boardModel ? `https://www.google.com/search?q=${encodeURIComponent(`${item.boardMaker || ''} ${item.boardModel} manual`)}` : null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal guide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><h2>{t(`g2.${kind}.title`, vars)}</h2><div className="dmeta" style={{ whiteSpace: 'normal' }}>{t(`g2.${kind}.why`, vars)}</div></div>
          <button className="icon-btn ghost" onClick={onClose} aria-label={t('close')}><X size={16} /></button>
        </div>
        <div className="guide-body">
          <ol>{Array.from({ length: GUIDE_STEPS[kind] }, (_, i) => <li key={i}>{rich(t(`g2.${kind}.${i + 1}`, vars))}</li>)}</ol>
          <div className="warn-box"><AlertTriangle size={14} /> {t(`g2.${kind}.warn`, vars)}</div>
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>{t('g2.done')}</button>
          {manual && kind === 'channels' && <button className="btn-ghost" onClick={() => api.openLink(manual)}><ExternalLink size={14} /> {t('g2.manual')}</button>}
        </div>
      </div>
    </div>
  );
}
