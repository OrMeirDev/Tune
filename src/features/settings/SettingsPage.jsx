// Settings.
import { FolderOpen, Globe, RefreshCw, ShieldCheck } from 'lucide-react';
import { DetailsDisclosure } from '../../components/DetailsDisclosure.jsx';
import { playChime } from '../../components/ScanSuccess.jsx';
import { ProgressPill } from '../../components/TaskProgress.jsx';
import { useT } from '../../i18n.js';
import { LicenseSection } from '../license/LicenseSection.jsx';

export function SettingsPage({ version, status, onCheck, settings, onPickDir, onLang, onSound, service, serviceAttempt, onInstallService, onRemoveService, busy, prog }) {
  const t = useT();
  const svcText = !service ? t('se.svc.checking')
    : service.running ? `${t('se.svc.running')}${service.current ? '' : t('se.svc.outdated')} · ${service.pawnio ? t('se.svc.pawnOk', { v: service.pawnio }) : t('se.svc.pawnMissing')}`
      : t(service.installed ? 'se.svc.stopped' : 'se.svc.none');
  const known = ['checking', 'none', 'available', 'downloading', 'ready', 'error', 'dev'];
  const msg = known.includes(status?.state) ? t(`se.upd.${status.state}`, { v: status.version, p: status.percent || 0 }) : t('se.upd.idle');
  return (
    <>
      <header className="page-header"><div><h1>{t('se.title')}</h1></div></header>
      <section className="card settings">
        <h2 className="settings-group-title">{t('ui.appearance')}</h2>
        <div className="setting">
          <div><div className="setting-title"><Globe size={15} style={{ verticalAlign: -2 }} /> {t('se.language')}</div><DetailsDisclosure context={t('se.language')}><p>{t('se.languageNote')}</p></DetailsDisclosure></div>
          {/* Each language is named in itself, so it can be found from either one. */}
          <div className="segmented">
            <button className={t.lang === 'en' ? 'on' : ''} onClick={() => onLang('en')}>English</button>
            <button className={t.lang === 'he' ? 'on' : ''} onClick={() => onLang('he')}>עברית</button>
          </div>
        </div>
        <div className="setting">
          <div><div className="setting-title">{t('se.sound')}</div><DetailsDisclosure context={t('se.sound')}><p>{t('se.soundNote')}</p></DetailsDisclosure></div>
          <div className="acts">
            <button className="btn-ghost" onClick={playChime}>{t('se.soundTry')}</button>
            <button className={`toggle ${settings?.sound !== false ? 'on' : ''}`} role="switch" aria-checked={settings?.sound !== false} aria-label={t('se.sound')} onClick={() => onSound(settings?.sound === false)} />
          </div>
        </div>
        <h2 className="settings-group-title">{t('ui.application')}</h2>
        <div className="setting">
          <div><div className="setting-title">{t('se.updates')}</div><div className="row-meta">{t('se.versionLine', { v: version || '…', msg })}</div></div>
          <button className="btn-ghost" onClick={onCheck}><RefreshCw size={14} /> {t('se.check')}</button>
        </div>
        <div className="setting">
          <div><div className="setting-title">{t('se.saveDir')}</div><div className="row-meta path-text" dir="ltr">{settings?.saveDir || '…'}</div><DetailsDisclosure context={t('se.saveDir')}><p>{t('se.saveDirNote')}</p></DetailsDisclosure></div>
          <button className="btn-ghost" onClick={onPickDir}><FolderOpen size={14} /> {t('se.change')}</button>
        </div>
        <h2 className="settings-group-title">{t('ui.system')}</h2>
        <div className="setting">
          <div>
            <div className="setting-title">{t('se.service', { status: svcText })}</div>
            <DetailsDisclosure context={t('ui.system')}><p>{t('se.serviceNote')}</p></DetailsDisclosure>
            {!service?.running && <div className="row-meta">{t('se.noService')}</div>}
            {/* until the main process has seen this version answer (WIN-R03) */}
            {service?.needsUpdate && (
              <div className="row-meta warn-text svc-reminder" role="status">
                {service.compat === 'outdated' ? t('se.svc.reminder', { installed: service.version, bundled: service.bundled })
                  : service.compat === 'unverifiable' ? t('se.svc.reminderUnknown', { bundled: service.bundled })
                    : t('se.svc.reminderStopped', { bundled: service.bundled })}
              </div>
            )}
            {serviceAttempt && !service?.current && (
              <div className="row-meta warn-text" role="status">
                {serviceAttempt.error === 'cancelled' ? t('se.svc.lastCancelled') : t('se.svc.lastFailed', { e: serviceAttempt.error })}
              </div>
            )}
          </div>
          <div className="header-actions">
            {busy === 'service' ? <ProgressPill p={prog.service} fallback={t('prog.working')} /> : (<>
              {(!service?.running || !service.current) && <button className="btn-primary" onClick={onInstallService} disabled={!!busy}><ShieldCheck size={14} /> {t(service?.installed ? 'se.installUpdate' : 'se.install')}</button>}
              {service?.installed && <button className="btn-ghost" onClick={onRemoveService} disabled={!!busy}>{t('se.remove')}</button>}
            </>)}
          </div>
        </div>
        <h2 className="settings-group-title">{t('lic.title')}</h2>
        <LicenseSection />
        <h2 className="settings-group-title">{t('ui.about')}</h2>
        <div className="setting">
          <DetailsDisclosure label={t('se.sources')}><p>{t('se.sourcesNote')}</p></DetailsDisclosure>
        </div>
        <div className="setting">
          <DetailsDisclosure label={t('se.safety')}><p>{t('se.safetyNote')}</p></DetailsDisclosure>
        </div>
      </section>
    </>
  );
}
