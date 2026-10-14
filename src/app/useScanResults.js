// Every scan result the pages show, and how they are fetched: the full scan at launch (and on
// "scan now"), the drivers-only rescan after an install, the per-area reloads, and the last
// launch's results shown until this launch's own arrive. Also records whether each check of the
// scan answered (domain/scan-verdict.mjs), so a failed check is never shown as "nothing to update".
// `setMsg` is the shell's banner, used for a Windows Update failure.
import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { sourcesFrom } from '../domain/scan-verdict.mjs';

export function useScanResults({ setMsg }) {
  const [hw, setHw] = useState(null);
  const [wu, setWu] = useState(null);
  const [gpu, setGpu] = useState(null);
  const [bios, setBios] = useState(null);
  // Whether each check of the last scan answered (see domain/scan-verdict.mjs).
  const [sources, setSources] = useState({});
  const [scan, setScan] = useState({ running: true, step: 0, total: 3, label: '', at: null });
  const [junk, setJunk] = useState(null);
  const [startup, setStartup] = useState(null);
  const [perf, setPerf] = useState(null);
  const [recs, setRecs] = useState(null);

  // What the page shows came from the last launch until this launch's own result arrives; actions
  // on that data wait for the fresh result (`stale`). Every fresh result is kept for next time.
  const [fromCache, setFromCache] = useState({});
  const [fresh, setFresh] = useState({});
  const markFresh = useCallback((key, value) => {
    setFresh((f) => ({ ...f, [key]: true }));
    api.cacheSet?.(key, value);
  }, []);
  const stale = (key) => !!fromCache[key] && !fresh[key];

  const loadJunk = useCallback(async () => { const r = await api.junkScan(); const v = r.ok ? [].concat(r.data) : []; setJunk(v); if (r.ok) markFresh('junk', v); }, [markFresh]);
  const loadStartup = useCallback(async () => { const r = await api.startupList(); const v = r.ok ? [].concat(r.data || []) : []; setStartup(v); if (r.ok) markFresh('startup', v); }, [markFresh]);
  const loadPerf = useCallback(async () => { const r = await api.performance(); if (r.ok) setPerf(r.data); }, []);
  const loadRecs = useCallback(async () => { const r = await api.recommendations(); const v = r.ok ? [].concat(r.data) : []; setRecs(v); if (r.ok) markFresh('recs', v); }, [markFresh]);

  // Drivers only: after an install, to refresh what is still offered.
  const scanDrivers = useCallback(async () => {
    const h = await api.scanHardware();
    if (h.ok) { setHw(h.data); markFresh('hw', h.data); }
    const w = await api.driverUpdates();
    // a failed check keeps the last answer on screen, marked as not checked
    if (w.ok) { setWu([].concat(w.data || [])); markFresh('wu', [].concat(w.data || [])); }
    setSources((s) => ({ ...s, hw: h.ok ? 'ok' : 'error', wu: w.ok ? 'ok' : 'error' }));
  }, [markFresh]);

  // Full scan. The optimization pages don't depend on the driver scan, so they load right away,
  // side by side with it, and can be used while Windows Update is still searching.
  // Step labels are dictionary keys, so they follow a language change mid-scan.
  const fullScan = useCallback(async () => {
    const step = (n, label) => setScan((s) => ({ ...s, running: true, step: n, label }));
    const optimize = Promise.all([loadJunk(), loadStartup(), loadRecs(), loadPerf()]);
    step(1, 'scan.s1');
    const h = await api.scanHardware();
    if (h.ok) { setHw(h.data); markFresh('hw', h.data); }
    step(2, 'scan.s2');
    const [w, g, b] = await Promise.all([
      api.driverUpdates(),
      // the GPUs and the board are the ones the main process' own hardware scan found
      h.ok ? api.gpuCheck() : Promise.resolve({ ok: false }),
      h.ok ? api.biosCheck() : Promise.resolve({ ok: false }),
    ]);
    // A failed check keeps the last answer on screen (marked as not checked) instead of turning
    // into "nothing to update".
    if (w.ok) {
      setWu([].concat(w.data || [])); markFresh('wu', [].concat(w.data || []));
      setMsg((m) => (m?.key === 'msg.wuFailed' ? null : m)); // an earlier failure is resolved
    } else setMsg({ kind: 'err', key: 'msg.wuFailed', vars: { e: w.error } });
    if (g.ok) { setGpu([].concat(g.data || [])); markFresh('gpu', [].concat(g.data || [])); }
    if (b.ok) { setBios(b.data); markFresh('bios', b.data); }
    setSources(sourcesFrom({ hw: h, wu: w, gpu: g, bios: b }));
    step(3, 'scan.s3');
    await optimize;
    const at = Date.now();
    setScan((s) => ({ ...s, running: false, at }));
    api.cacheSet?.('scanAt', at);
  }, [loadJunk, loadStartup, loadRecs, loadPerf, markFresh, setMsg]);

  // The last launch's results, shown at once; this launch's scan replaces them as they arrive.
  const showCached = useCallback(async () => {
    const c = (await api.cacheGet?.().catch(() => null)) || {};
    const keys = {};
    const use = (key, set) => { if (c[key] != null) { set(c[key]); keys[key] = true; } };
    use('hw', setHw); use('wu', setWu); use('gpu', setGpu); use('bios', setBios);
    use('junk', setJunk); use('startup', setStartup); use('recs', setRecs);
    setFromCache(keys);
    if (c.scanAt) setScan((s) => ({ ...s, at: c.scanAt }));
  }, []);

  return {
    hw, wu, gpu, bios, sources, scan, junk, startup, perf, recs, fresh, stale,
    setJunk, setPerf, setRecs,
    loadJunk, loadStartup, loadPerf, loadRecs, scanDrivers, fullScan, showCached,
  };
}
