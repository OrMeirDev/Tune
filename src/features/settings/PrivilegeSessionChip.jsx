// The background service / admin session chip in the sidebar.
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useT } from '../../i18n.js';
import { mmss } from '../../presentation/format.jsx';

// With the background service running nothing asks for approval; otherwise one approval covers
// 10 minutes, with a countdown and a way to end it early.
export function AdminChip({ service, until, onStart, onStop, onInstall, busy }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until <= Date.now()) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (service?.running && service.current) {
    return <div className="admin-chip on" title={t('admin.serviceOnTitle')}><ShieldCheck size={14} /> {t('admin.serviceOn')}</div>;
  }
  if (service?.installed) {
    return <button className="admin-chip" onClick={onInstall} disabled={!!busy}><ShieldCheck size={14} /> {t(service.running ? 'admin.serviceUpdate' : 'admin.serviceStopped')}</button>;
  }
  const left = until - now;
  if (left > 0) {
    return (
      <div className="admin-chip on" title={t('admin.activeTitle')}>
        <ShieldCheck size={14} /> {t('admin.active', { t: mmss(left) })}
        <button onClick={onStop} disabled={!!busy}>{t('admin.end')}</button>
      </div>
    );
  }
  return (
    <>
      <button className="admin-chip" onClick={onStart} disabled={!!busy} title={t('admin.startTitle')}>
        <ShieldCheck size={14} /> {t('admin.start')}
      </button>
      <button className="admin-link" onClick={onInstall} disabled={!!busy} title={t('admin.installTitle')}>{t('admin.install')}</button>
    </>
  );
}
