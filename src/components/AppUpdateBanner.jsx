// Tune's own update status banner.
import { Download, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { useT } from '../i18n.js';

export function UpdateBanner({ status }) {
  const t = useT();
  if (!status || !['available', 'downloading', 'ready'].includes(status.state)) return null;
  return (
    <div className="banner info">
      <Sparkles size={16} />
      <span>
        {status.state === 'available' && <>{t('upd.available')} <b>{status.version}</b></>}
        {status.state === 'downloading' && t('upd.downloading', { p: status.percent || 0 })}
        {status.state === 'ready' && t('upd.ready', { v: status.version })}
      </span>
      {status.state === 'available' && <button className="btn-primary" onClick={() => api.downloadAppUpdate()}><Download size={14} /> {t('upd.now')}</button>}
      {status.state === 'ready' && <button className="btn-primary" onClick={() => api.installAppUpdate()}><RefreshCw size={14} /> {t('upd.restart')}</button>}
    </div>
  );
}
