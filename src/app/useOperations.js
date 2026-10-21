// Running an action that changes the system: one at a time, progress on its row (from the main
// process' progress events), the result in the shell's banner. Actions that need admin rights show
// "waiting for approval" until Windows' prompt is answered, unless the background service or a
// recent admin session covers them.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { errText } from '../presentation/format.jsx';

export function useOperations({ t, service, adminUntil, setAdminUntil, setMsg }) {
  const [busy, setBusy] = useState(null);
  const [prog, setProg] = useState({});
  const inFlight = useRef(false);

  useEffect(() => api?.onProgress((p) => setProg((m) => ({ ...m, [p.key]: p }))), []);

  // While a page still shows the last launch's data its action buttons wait: 'stale' counts as busy
  // (it matches no row, so no row shows progress).
  const lockWhile = (cond) => busy || (cond ? 'stale' : null);

  const act = async (key, fn, done, { admin = false } = {}) => {
    if (inFlight.current) return { ok: false, error: 'busy' };
    inFlight.current = true;
    setBusy(key);
    setMsg(null);
    const prompt = admin && !(service?.running && service.current) && adminUntil - Date.now() < 4000;
    setProg((m) => ({ ...m, [key]: prompt ? { phase: 'auth' } : null }));
    let r;
    try { r = await fn(); }
    catch { r = { ok: false, error: 'no answer in time', code: 'noAnswer' }; }
    finally {
      inFlight.current = false;
      setBusy(null);
      setProg((m) => ({ ...m, [key]: null }));
    }
    if (admin || r?.adminUntil) Promise.resolve().then(() => api.adminStatus()).then(setAdminUntil).catch(() => {});
    if (!r?.ok) setMsg({ kind: 'err', text: r?.code === 'noAnswer' ? t('err.noAnswer') : errText(r?.error, t) });
    else if (done) setMsg({ kind: 'info', text: done(r.data) });
    return r;
  };

  return { busy, prog, act, lockWhile };
}
