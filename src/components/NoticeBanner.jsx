// The message banner at the top of a page.
import { AlertTriangle, Check } from 'lucide-react';
import { useT } from '../i18n.js';

export function Banner({ msg, onClose }) {
  const t = useT();
  if (!msg) return null;
  return (
    <div className={`banner ${msg.kind || 'info'}`} role={msg.kind === 'err' ? 'alert' : 'status'}>
      {msg.kind === 'err' ? <AlertTriangle size={16} /> : <Check size={16} />}
      <span>{msg.text}</span>
      <button className="btn-ghost" onClick={onClose}>{t('close')}</button>
    </div>
  );
}
