// The notice shown when Tune finds an older (or unverifiable) background service running, typically
// after Tune itself was updated (WIN-R03). Windows' approval prompt appears only after "Update" is
// clicked; "Later" (or closing) hides the notice for this pair of versions, while Settings keeps
// reminding until the main process has seen the new version answer. Changes are never sent to such a
// service meanwhile (electron/privilege/service.cjs), whatever is chosen here.
import { useId } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { DialogFrame } from '../../components/DialogFrame.jsx';
import { useT } from '../../i18n.js';

export function ServiceUpdateNotice({ service, onUpdate, onLater, busy }) {
  const t = useT();
  const titleId = useId();
  const known = !!service.version;
  return (
    <DialogFrame onClose={onLater} labelledBy={titleId} className="service-notice">
      <div className="modal-head">
        <div>
          <h2 id={titleId}><ShieldAlert size={18} style={{ verticalAlign: -3 }} /> {t('svcNotice.title')}</h2>
        </div>
      </div>
      <div className="service-notice-body">
        <p>{known ? t('svcNotice.outdated', { installed: service.version, bundled: service.bundled }) : t('svcNotice.unverifiable', { bundled: service.bundled })}</p>
        <p>{t('svcNotice.meanwhile')}</p>
        <p className="row-meta">{t('svcNotice.approval')}</p>
      </div>
      <div className="modal-actions">
        <button className="btn-primary" onClick={onUpdate} disabled={!!busy}><ShieldCheck size={14} /> {t('svcNotice.update')}</button>
        <button className="btn-ghost" onClick={onLater}>{t('svcNotice.later')}</button>
      </div>
    </DialogFrame>
  );
}
