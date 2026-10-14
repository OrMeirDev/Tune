// The performance center's items, grouped by part of the PC.
import { CircuitBoard, Cpu, HardDrive, MemoryStick, Monitor, Settings2 } from 'lucide-react';
import { median } from '../../presentation/format.jsx';

// Every check, grouped by the part of the PC it is about. Tune's own scans (graphics driver,
// leftover files, startup apps) join the settings checks, so everything is in one place.
export const GROUPS = [
  { id: 'cpu', icon: Cpu }, { id: 'board', icon: CircuitBoard }, { id: 'memory', icon: MemoryStick },
  { id: 'gpu', icon: Monitor }, { id: 'storage', icon: HardDrive }, { id: 'windows', icon: Settings2 },
];

export function centerItems({ recs, bios, gpu, junk, startup, live, history = [] }) {
  const recent = median(history.map((h) => h.cpuTempC).filter((x) => x != null));
  const items = (recs || []).map((r) => {
    // BIOS: checked against the maker's site, so its status comes from the BIOS check.
    if (r.key === 'bios') return { ...r, ok: bios?.supported ? !bios.newer : null };
    // The power-limit tip turns into a finding when the CPU has been very hot for the last half
    // minute (not on one momentary jump).
    // When the processor reports a long-term limit (PL1) below the unlimited ~253 W, the limit is
    // set: the row is fine, and the guide stays for anyone who wants to change it.
    if (r.key === 'powerLimit') {
      const pl = live?.powerLimits;
      const limited = !!(pl && pl.pl1On && pl.pl1W > 0 && pl.pl1W < 250);
      return { ...r, ok: limited ? true : history.length >= 5 && recent >= 90 ? false : null, limits: limited ? pl : null, tempC: recent ?? live?.cpuTempC, powerW: live?.cpuPowerW };
    }
    return r;
  });
  const drivers = (gpu || []).filter((g) => g.vendor !== 'Intel' && g.latest);
  if (drivers.length) {
    const g = drivers.find((x) => x.newer && x.url) || drivers[0];
    items.push({ key: 'gpuDriver', group: 'gpu', ok: !(g.newer && g.url), latest: g.latest, vendor: g.vendor, go: 'updates' });
  }
  if (junk) {
    const bytes = junk.reduce((s, c) => s + c.bytes, 0);
    items.push({ key: 'junk', group: 'storage', bytes, ok: bytes < 5e9, go: 'clean' });
  }
  if (startup) {
    const n = startup.filter((s) => s.enabled).length;
    items.push({ key: 'startup', group: 'windows', n, ok: n <= 12, go: 'startup' });
  }
  return items;
}

export const statusRank = (ok) => (ok === false ? 0 : ok == null ? 1 : 2);
