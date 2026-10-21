// Secondary information stays one keyboard-accessible step away, without another dialog.
import { ChevronDown } from 'lucide-react';
import { useT } from '../i18n.js';

export function DetailsDisclosure({ label, context, className = '', children }) {
  const t = useT();
  const title = label || t('ui.details');
  return (
    <details className={`details-disclosure ${className}`}>
      <summary aria-label={context ? `${title}: ${context}` : undefined}>
        <span>{title}</span><ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="details-content">{children}</div>
    </details>
  );
}
