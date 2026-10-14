// The pages and their sidebar groups.
import { Cpu, History, RefreshCw, Rocket, Settings, Settings2, Sparkles, Thermometer, Trash2 } from 'lucide-react';

export const PAGES = [
  { group: 'nav.drivers' },
  { id: 'updates', icon: RefreshCw, key: 'nav.updates' },
  { id: 'hardware', icon: Cpu, key: 'nav.hardware' },
  { group: 'nav.optimize' },
  { id: 'overview', icon: Sparkles, key: 'nav.overview' },
  { id: 'clean', icon: Trash2, key: 'nav.clean' },
  { id: 'startup', icon: Rocket, key: 'nav.startup' },
  { id: 'perf', icon: Thermometer, key: 'nav.perf' },
  { id: 'recs', icon: Settings2, key: 'nav.recs' },
  { group: '' },
  { id: 'history', icon: History, key: 'nav.history' },
  { id: 'settings', icon: Settings, key: 'nav.settings' },
];

// The pages in their sidebar groups (each group is one glass panel).
export const NAV_GROUPS = PAGES.reduce((gs, p) => (p.group !== undefined ? [...gs, { group: p.group, pages: [] }] : (gs.at(-1).pages.push(p), gs)), []);
