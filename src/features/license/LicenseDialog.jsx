// Activation and recovery (plan L02): verify the owner by email, then activate a Serial or recover
// the owner's licence on this PC. Every step is a form (Enter submits), the dialog keeps focus inside
// and closes on Escape, and each answer is said plainly, with a retry when the server didn't answer.
// The main process does the work (electron/licensing/client.cjs); this only shows its summaries.
import { useId, useState } from 'react';
import { CheckCircle2, Info, Loader2, RefreshCw, X } from 'lucide-react';
import { api } from '../../api.js';
import { DialogFrame } from '../../components/DialogFrame.jsx';
import { useT } from '../../i18n.js';
import { GOOD, licenseLines, outcomeText } from './licenseText.js';

export function LicenseDialog({ lic, working, call, onClose }) {
  const t = useT();
  const titleId = useId();
  const [email, setEmail] = useState(lic?.flow?.email || '');
  const [code, setCode] = useState('');
  const [serial, setSerial] = useState('');
  const [choice, setChoice] = useState(null);
  // only what was done in this dialog is reported in it (an earlier success doesn't greet a new visit)
  const [acted, setActed] = useState(false);
  const run = (fn) => { setActed(true); call(fn); };
  const flow = lic?.flow || { step: 'email' };
  const o = acted ? lic?.outcome : null;
  const good = o && GOOD.includes(o.result);
  const done = o && ['activated', 'recovered'].includes(o.result) && lic.license.state === 'active';

  const submit = (fn) => (e) => { e.preventDefault(); if (!working) run(fn); };
  const startOver = () => { setCode(''); setSerial(''); setChoice(null); run(() => api.licenseReset()); };

  return (
    <DialogFrame onClose={onClose} labelledBy={titleId} className="license-dialog">
      <div className="modal-head">
        <div>
          <h2 id={titleId}>{t('lic.dialogTitle')}</h2>
          <div className="dmeta" style={{ whiteSpace: 'normal' }}>{t('lic.dialogIntro')}</div>
        </div>
      </div>
      <div className="license-body">
        {done ? (
          <div className="lic-done">
            <CheckCircle2 size={22} />
            <div><b>{outcomeText(o, t)}</b>{licenseLines(lic.license, t).map((l) => <div key={l} className="dmeta">{l}</div>)}</div>
          </div>
        ) : (<>
          {flow.step === 'email' && (
            <form className="lic-form" onSubmit={submit(() => api.licenseOwnerStart(email.trim()))}>
              <label htmlFor="lic-email">{t('lic.email')}</label>
              <div className="lic-row">
                <input id="lic-email" autoFocus type="email" dir="ltr" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
                <button type="submit" className="btn-primary small" disabled={working || !email.trim()}>{t('lic.sendCode')}</button>
              </div>
              <div className="dmeta">{t('lic.emailNote')}</div>
            </form>
          )}
          {flow.step === 'code' && (
            <form className="lic-form" onSubmit={submit(() => api.licenseOwnerConfirm(code))}>
              <label htmlFor="lic-code">{t('lic.code', { email: flow.email || '' })}</label>
              <div className="lic-row">
                <input id="lic-code" autoFocus dir="ltr" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                <button type="submit" className="btn-primary small" disabled={working || code.length !== 6}>{t('lic.verify')}</button>
              </div>
            </form>
          )}
          {flow.step === 'ready' && (<>
            <div className="dmeta lic-verified"><CheckCircle2 size={14} /> {t('lic.verifiedAs', { email: flow.email || '' })}</div>
            <form className="lic-form" onSubmit={submit(() => api.licenseActivate(serial))}>
              <label htmlFor="lic-serial">{t('lic.serial')}</label>
              <div className="lic-row">
                <input id="lic-serial" autoFocus dir="ltr" autoComplete="off" spellCheck={false} maxLength={64} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" value={serial} onChange={(e) => setSerial(e.target.value.replace(/[^0-9A-Za-z -]/g, ''))} />
                <button type="submit" className="btn-primary small" disabled={working || !serial.trim()}>{t('lic.activate')}</button>
              </div>
            </form>
            <div className="lic-or"><span>{t('lic.or')}</span></div>
            <div className="lic-recover">
              <div className="dmeta">{t('lic.recoverNote')}</div>
              <button type="button" className="btn-ghost" disabled={working} onClick={() => run(() => api.licenseRecover())}>{t('lic.recover')}</button>
            </div>
            {flow.choices?.length > 0 && (
              <fieldset className="lic-choices">
                <legend>{t('lic.choose')}</legend>
                {flow.choices.map((c) => (
                  <label key={c.licenseId}>
                    <input type="radio" name="lic-choice" value={c.licenseId} checked={choice === c.licenseId} onChange={() => setChoice(c.licenseId)} />
                    <span dir="ltr">{c.planId}{c.codeSuffix ? ` ···${c.codeSuffix}` : ''}</span> · {t(`lic.choiceStatus.${c.status || 'active'}`)}
                  </label>
                ))}
                <button type="button" className="btn-primary small" disabled={working || !choice} onClick={() => run(() => api.licenseRecover(choice))}>{t('lic.recoverThis')}</button>
              </fieldset>
            )}
          </>)}
          {((working && acted) || o) && (
            <div className={`finding ${working ? '' : good ? 'ok' : 'warn'} lic-outcome`} role={good || working ? 'status' : 'alert'} aria-live="polite">
              {working ? <Loader2 size={15} className="spin" /> : good ? <CheckCircle2 size={15} /> : <Info size={15} />}
              <div>
                {working ? t('lic.working') : outcomeText(o, t)}
                {!working && lic?.canRetry && o?.retryable && <div><button type="button" className="link-btn" onClick={() => run(() => api.licenseRetry())}><RefreshCw size={12} /> {t('lic.retry')}</button></div>}
                {!working && o?.result === 'alreadyYours' && <div><button type="button" className="link-btn" onClick={() => run(() => api.licenseRecover())}>{t('lic.recover')}</button></div>}
              </div>
            </div>
          )}
        </>)}
      </div>
      <div className="modal-actions">
        <button type="button" className={done ? 'btn-primary' : 'btn-ghost'} onClick={onClose}><X size={14} /> {t(done ? 'lic.done' : 'close')}</button>
        {!done && flow.step !== 'email' && <button type="button" className="btn-ghost" disabled={working} onClick={startOver}>{t('lic.startOver')}</button>}
      </div>
    </DialogFrame>
  );
}
