'use strict';
// Fixed-window counters in memory. Enough for one server process (the PoC); several processes or
// servers would keep these in the shared database or a cache instead.
function createLimiter({ max, windowMs, now = Date.now }) {
  const counts = new Map();
  const live = (key) => {
    const e = counts.get(key);
    if (e && now() >= e.resetAt) { counts.delete(key); return null; }
    return e || null;
  };
  // Keeps memory bounded when many addresses each fail once.
  const prune = () => { for (const k of [...counts.keys()]) live(k); };
  return {
    blocked: (key) => { const e = live(key); return !!e && e.count >= max; },
    retryAfterMs: (key) => { const e = live(key); return e ? Math.max(0, e.resetAt - now()) : 0; },
    hit(key) {
      const e = live(key);
      if (e) { e.count += 1; return; }
      if (counts.size >= 50_000) prune();
      counts.set(key, { count: 1, resetAt: now() + windowMs });
    },
  };
}

module.exports = { createLimiter };
