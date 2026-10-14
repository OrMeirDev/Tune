// The result of a scan where a check failed.
import { AlertTriangle, ScanSearch } from 'lucide-react';
import { useT } from '../i18n.js';

// A scan where a check failed: nothing to install was found, but that isn't known for sure, so it
// says which check didn't answer instead of celebrating.
export function ScanIncomplete({ list, onScan, busy }) {
  const t = useT();
  return (
    <div className="scan-incomplete" role="status">
      <span className="si-icon"><AlertTriangle size={26} /></span>
      <div className="si-title">{t('up.incompleteTitle')}</div>
      <div className="si-sub">{t('up.incomplete', { list })}</div>
      <button className="btn-primary" onClick={onScan} disabled={!!busy}><ScanSearch size={14} /> {t('up.scanAgain')}</button>
    </div>
  );
}
