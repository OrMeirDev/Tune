// Live CPU readings, polled while a page that shows them is open.
import { useEffect, useState } from 'react';
import { api } from '../../api.js';

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
    const tick = async () => {
      const r = await api.sensors().catch(() => null);
      if (stop) return;
      if (r?.ok) {
        setLive(r.data);
        setHistory((h) => [...h, r.data].slice(-15));
      }
      timer = setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [on]);
  return [live, history];
}
