// A running task's progress, as a small pill.
import { Loader2 } from 'lucide-react';
import { useT } from '../i18n.js';

// What a long job is doing right now: approval, restore point, download %, install %.
export function ProgressPill({ p, fallback }) {
  const t = useT();
  const label = ['auth', 'restore', 'prepare', 'download', 'install', 'service', 'pawnio', 'start'].includes(p?.phase) ? t(`prog.${p.phase}`) : fallback;
  const pct = p && ['download', 'install'].includes(p.phase) && p.percent != null ? p.percent : null;
  return (
    <span className="pill prog-pill">
      <Loader2 size={13} className="spin" />
      {label}{pct != null ? ` ${pct}%` : p && ['download', 'install'].includes(p.phase) ? '…' : ''}
      {p?.count > 1 && p.index ? t('prog.ofN', { i: p.index, n: p.count }) : ''}
      {pct != null && <span className="mini-bar"><i style={{ width: `${pct}%` }} /></span>}
    </span>
  );
}
