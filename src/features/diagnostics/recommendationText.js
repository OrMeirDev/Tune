// The words for each recommendation (title, value, why, what if not).
import { fmtGB } from '../../presentation/format.jsx';

// ---------------- optimization ----------------

// Recommendations arrive as data; their wording lives in the dictionary.
export const recTitle = (r, t) => t(`rec.${r.key}.title`);

const planName = (r, t) => (['balanced', 'high', 'ultimate', 'saver'].includes(r.plan) ? t(`plan.${r.plan}`) : r.value);

export const recValue = (r, t) => ({
  // Off the recommended plan, say which one is recommended right next to the current one.
  power: planName(r, t) + (r.ok === false ? ` · ${t('rec.power.recommended', { plan: t('plan.balanced') })}` : ''),
  gamemode: t(r.on ? 'on' : 'off'),
  hags: t(r.on ? 'on' : 'off'),
  disk: t('rec.disk.value', { free: r.freeGB, size: r.sizeGB }),
  bios: `${r.version} (${r.date})`,
  microcode: r.hex,
  powerLimit: [r.limits && t('rec.powerLimit.set', { pl1: r.limits.pl1W, pl2: r.limits.pl2W }), r.powerW != null && t('rec.powerLimit.value', { w: r.powerW, t: r.tempC ?? '—' })].filter(Boolean).join(' · '),
  memChannels: r.channels == null ? t('rec.memChannels.unknown') : t(r.channels >= 2 ? 'rec.memChannels.dual' : r.sticks > 1 ? 'rec.memChannels.sameOne' : 'rec.memChannels.one', { n: r.sticks }),
  memSpeed: r.rated ? t('rec.memSpeed.value', { now: r.configured, rated: r.rated }) : `${r.configured} MT/s`,
  trim: t(r.on ? 'on' : 'off'),
  gpuDriver: t(r.ok ? 'rec.gpuDriver.latest' : 'rec.gpuDriver.newer', { v: r.latest }),
  junk: fmtGB(r.bytes),
  startup: t('rec.startup.value', { n: r.n }),
}[r.key] ?? '');

// A short "why" for every recommendation...
export const recNote = (r, t) => (r.key === 'bios' ? t(r.intel1314 ? 'rec.bios.note1314' : 'rec.bios.note')
  : r.key === 'power' ? t(`rec.power.why.${r.cpuKind || 'other'}`)
    : r.key === 'powerLimit' ? t(r.cpuKind === 'intelHybrid' ? 'rec.powerLimit.noteIntel' : 'rec.powerLimit.noteAmd')
      : r.key === 'memSpeed' ? t('rec.memSpeed.note', { profile: r.profile })
        : r.key === 'memChannels' && r.sticks === 1 ? t('rec.memChannels.noteOne') : t(`rec.${r.key}.note`));

// ...and, when it isn't met, what happens if it stays that way.
export function recIf(r, t) {
  if (r.key === 'bios') return t(r.intel1314 ? 'rec.bios.if1314' : 'rec.bios.if');
  if (r.key === 'powerLimit') return t('rec.powerLimit.if', { t: r.tempC });
  if (r.key === 'memChannels' && r.sticks === 1) return t('rec.memChannels.ifOne');
  if (r.key === 'memSpeed') return t('rec.memSpeed.if', { now: r.configured, rated: r.rated, profile: r.profile });
  if (r.key !== 'power') return t(`rec.${r.key}.if`);
  if (r.plan === 'saver') return t('rec.power.if.saver');
  if (r.plan === 'custom') return t('rec.power.if.custom');
  return t('rec.power.if.fast') + (r.cpuKind === 'intelHybrid' ? t('rec.power.if.hybrid') : r.cpuKind === 'amdX3D' ? t('rec.power.if.x3d') : '');
}
