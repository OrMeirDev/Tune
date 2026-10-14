// The licence in Settings: its state, package, dates and the last successful check, and the way to
// activate it or bring it back on this PC. Licensing never blocks anything else on the page, and a
// failed request only leaves a message: every action here clears its busy state when it returns.
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import { api } from '../../api.js';
import { useT } from '../../i18n.js';
import { LicenseDialog } from './LicenseDialog.jsx';
import { GOOD, licenseLines, outcomeText } from './licenseText.js';

export function LicenseSection() {
  const t = useT();
  const [lic, setLic] = useState(null);
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState(false);
  // what "Check now" came to, shown in the row itself (a released PC is never left looking active)
  const [checked, setChecked] = useState(null);

  // Runs one licensing request; whatever happens, `working` is cleared and the page stays usable.
  const call = useCallback(async (fn) => {
    setWorking(true);
    try {
      const r = await fn();
      if (r?.ok && r.data) setLic(r.data);
    } catch {
      setLic((l) => (l ? { ...l, outcome: { result: 'failed' } } : l));
    } finally {
      setWorking(false);
    }
  }, []);
  useEffect(() => { if (api?.licenseStatus) call(() => api.licenseStatus()); }, [call]);
  // a background renewal (or a release it found) updates the row without a click
  useEffect(() => api?.onLicenseChange?.(() => {
    api.licenseStatus().then((r) => { if (r?.ok && r.data) setLic(r.data); }).catch(() => {});
  }), []);
  const checkNow = () => call(async () => {
    const r = await api.licenseRefresh();
    setChecked(r?.ok ? r.data?.outcome || null : { result: 'failed' });
    return r;
  });

  const state = lic?.license?.state || 'none';
  const has = state !== 'none';
  // storage matters only where a licence can be kept (not while licensing is off)
  const storageNote = lic?.available && ['unavailable', 'unreadable', 'failed', 'test'].includes(lic.storage) ? t(`lic.storage.${lic.storage}`) : null;
  return (
    <div className="setting license-setting">
      <div>
        <div className="setting-title"><KeyRound size={15} style={{ verticalAlign: -2 }} /> {t('lic.title')}
          {lic?.available && lic.development && <span className="src">{t('lic.devServer')}</span>}</div>
        {!lic ? <div className="row-meta">{t('loading')}</div>
          : !lic.available ? <div className="row-meta">{t(lic.problem === 'misconfigured' ? 'lic.misconfigured' : 'lic.notOpen')}</div>
            : licenseLines(lic.license, t).map((l) => <div key={l} className="row-meta">{l}</div>)}
        {storageNote && <div className="row-meta warn-text">{storageNote}</div>}
        {checked && !open && <div className={`row-meta lic-checked ${GOOD.includes(checked.result) ? 'ok-text' : 'warn-text'}`} role="status">{outcomeText(checked, t)}</div>}
      </div>
      {lic?.available && (
        <div className="header-actions">
          {has && <button className="btn-ghost" disabled={working} onClick={checkNow}><RefreshCw size={14} /> {t('lic.checkNow')}</button>}
          <button className={has ? 'btn-ghost' : 'btn-primary'} disabled={working} onClick={() => { setChecked(null); setOpen(true); }}>{t(has ? 'lic.manage' : 'lic.activateOrRecover')}</button>
        </div>
      )}
      {open && <LicenseDialog lic={lic} working={working} call={call} onClose={() => setOpen(false)} />}
    </div>
  );
}
