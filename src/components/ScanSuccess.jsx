// The "all up to date" celebration (shown only after a scan whose checks all answered).
import { useEffect } from 'react';
import { useT } from '../i18n.js';

// ---------------- driver updates ----------------

// The success sound (public/sounds/check-premium.mp3, 0.7 s, loudest about 0.12 s in).
export function playChime() {
  try {
    const a = new Audio('sounds/check-premium.mp3');
    a.volume = 0.8;
    a.play().catch(() => {});
  } catch { /* no audio device: the animation is enough */ }
}

// "Everything is up to date": the ring draws itself, fills green, the check is written in one
// stroke, then a pop, a ripple and a few sparks. The sound plays once per finished scan, timed to
// the check (soundKey is the scan's time, or null for no sound).
let lastChime = null;

export function AllGood({ soundKey }) {
  const t = useT();
  useEffect(() => {
    if (!soundKey || soundKey === lastChime) return undefined;
    lastChime = soundKey;
    const timer = setTimeout(playChime, 900);
    return () => clearTimeout(timer);
  }, [soundKey]);
  return (
    <div className="all-good" role="status">
      <div className="ag-stage">
        <span className="ag-shadow" aria-hidden="true" />
        <span className="ag-wave" />
        <span className="ag-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--a': `${i * 30}deg`, '--d': `${(i % 3) * 50}ms` }} />)}</span>
        {/* a glass bubble: it inflates, the check draws itself, then it keeps floating gently */}
        <div className="ag-float">
          <svg className="ag-mark" viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <radialGradient id="agBody" cx="42%" cy="30%" r="78%">
                <stop offset="0" stopColor="#fbfffd" />
                <stop offset=".45" stopColor="#d9f6ea" />
                <stop offset=".82" stopColor="#a6e6cf" />
                <stop offset="1" stopColor="#7fd6b8" />
              </radialGradient>
              <radialGradient id="agGlow" cx="50%" cy="88%" r="55%">
                <stop offset="0" stopColor="#4fd1a3" stopOpacity=".55" />
                <stop offset="1" stopColor="#4fd1a3" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="agShine" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#fff" stopOpacity=".95" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="agTick" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#22c58f" />
                <stop offset="1" stopColor="#008a67" />
              </linearGradient>
            </defs>
            <circle className="ag-ring" cx="60" cy="60" r="52" fill="url(#agBody)" />
            <circle cx="60" cy="60" r="52" fill="url(#agGlow)" />
            <circle cx="60" cy="60" r="51" fill="none" stroke="#fff" strokeOpacity=".9" strokeWidth="2" />
            <circle cx="60" cy="60" r="52.5" fill="none" stroke="#5fcfa8" strokeOpacity=".35" strokeWidth="1" />
            <ellipse className="ag-shine" cx="52" cy="30" rx="30" ry="15" fill="url(#agShine)" />
            <path className="ag-check" d="M40 61 L54 75 L81 46" stroke="url(#agTick)" />
          </svg>
        </div>
      </div>
      <div className="ag-title">{t('up.allGoodTitle')}</div>
      <div className="ag-sub">{t('up.allGood')}</div>
    </div>
  );
}
