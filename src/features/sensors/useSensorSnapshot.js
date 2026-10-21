// Live CPU readings, polled while a page that shows them is open.
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { freshLive } from '../../domain/live-freshness.mjs';

// ---------------- performance center ----------------

// Live CPU readings from the background service, every 2 seconds while a page shows them, with the
// last 30 seconds kept so findings don't hang on a single momentary reading.
export function useLiveSensors(on) {
  const [live, setLive] = useState(null);
  const [history, setHistory] = useState([]);
  useEffect(() => {
    if (!on || !api?.sensors) return undefined;
    let stop = false;
    let timer;
    setLive(null);
    setHistory([]);
    const expire = setInterval(() => {
      const now = Date.now();
      setLive(v => freshLive(v, now));
      setHistory(h => h.filter(v => now - v.receivedAt <= 30000 && now >= v.receivedAt));
    }, 2000);
    const tick = async () => {
      const r = await api.sensors().catch(() => null);
      if (stop) return;
      if (r?.ok) {
        const sample = { ...r.data, receivedAt: Date.now() };
        setLive(freshLive(sample));
        setHistory(h => [...h.filter(v => sample.receivedAt - v.receivedAt <= 30000), sample].slice(-15));
      }
      timer = setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); clearInterval(expire); };
  }, [on]);
  return [live, history];
}
