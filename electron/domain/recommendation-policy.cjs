// Judging the raw settings: power plan, memory channels and speed, microcode (pure, no Windows calls).
const { INTEL_1314_DESKTOP, microcodeAdvice } = require('./advice-rules.cjs');

// The power plan each kind of processor's maker recommends. Intel (12th gen and later, with
// performance + efficient cores) and AMD (Ryzen; X3D chips depend on it) both recommend Windows'
// Balanced plan: full speed under load, rest in between. Older Intel desktops do fine with High
// performance too. Laptops: Balanced.
const PLAN_GUIDS = {
  '381b4222-f694-41f0-9685-ff5bb260df2e': 'balanced',
  '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': 'high',
  'e9a42b02-d5df-448d-aa00-03f14749eb61': 'ultimate',
  'a1841308-3541-4fab-bc81-f71556f20b4a': 'saver',
};

// Built-in plans by their fixed ID; copies (Ultimate Performance is usually one) by name, which
// Windows gives in its own language.
const planKind = (guid, name) => PLAN_GUIDS[String(guid).toLowerCase()]
  || (/ultimate|אולטימטיב|מרבי|מקסימלי/i.test(name) ? 'ultimate'
    : /high perf|ביצועים גבוהים/i.test(name) ? 'high'
      : /saver|חיסכון/i.test(name) ? 'saver'
        : /balanced|מאוזן/i.test(name) ? 'balanced' : 'custom');

function cpuKind(cpu) {
  if (/Ryzen\s+9\s+(7900|7950|9900|9950)X3D/i.test(cpu)) return 'amdX3D';
  if (/Ryzen|AMD/i.test(cpu)) return 'amd';
  if (/Core\s*(\(TM\))?\s*Ultra|i[3579]-1[2-4]\d{3}|Core\s*(\(TM\))?\s*[3579]\s+\d{3}/i.test(cpu)) return 'intelHybrid';
  if (/Intel/i.test(cpu)) return 'intel';
  return 'other';
}

function powerAdvice(x) {
  const plan = planKind(x.guid, x.value);
  const kind = x.laptop ? 'laptop' : cpuKind(x.cpu);
  const ok = plan === 'balanced' || (kind === 'intel' && plan === 'high');
  return { ...x, plan, cpuKind: kind, recommended: 'balanced', ok, action: ok ? null : 'power' };
}

// (The 13th–14th gen Intel microcode rule lives in advice-rules.cjs, with its source.)

// Which memory channel a stick sits in, from the slot names the board reports: "Controller0-DIMM1"
// (Intel: one controller per channel), "ChannelA-DIMM0", "P0 CHANNEL A" (AMD), "DIMM_B2", "A1".
function memChannel(m) {
  const s = `${m.locator} ${m.bank}`;
  const ctrl = (s.match(/controller\s*(\d+)/i) || [])[1];
  const ch = (s.match(/channel\s*([a-h])\b/i) || m.locator.match(/DIMM[\s_-]*([a-h])\d/i) || m.locator.match(/^([a-h])\d\b/i) || [])[1];
  if (ctrl == null && ch == null) return null;
  return `${ctrl ?? ''}${(ch || '').toUpperCase()}`;
}

// The speed a kit is sold at, from its part number (G.Skill F5-6000…, Corsair …M2B6000C36,
// Kingston KF560C36…, Crucial …16G60C38…, TeamGroup …16G6000HC38…), when it can be read.
const MEM_SPEEDS = [2133, 2400, 2666, 2933, 3000, 3200, 3466, 3600, 3733, 3866, 4000, 4133, 4266, 4400, 4800, 5200, 5600, 6000, 6200, 6400, 6600, 6800, 7000, 7200, 7600, 8000, 8200, 8400];

function ratedFromPart(part = '') {
  const p = part.toUpperCase();
  const tries = [
    p.match(/^F[345]-(\d{4})/), p.match(/M\dB(\d{4})C/), p.match(/G(\d{4})HC/),
  ].filter(Boolean).map((m) => +m[1]);
  const kf = p.match(/^KF([345])(\d{2})C/); if (kf) tries.push(+kf[2] * 100);
  const cr = p.match(/\d+G(\d{2})C\d{2}/); if (cr) tries.push(+cr[1] * 100);
  return tries.map((v) => (v === 2660 ? 2666 : v === 2930 ? 2933 : v)).find((v) => MEM_SPEEDS.includes(v)) || null;
}

function memoryAdvice(x) {
  const mods = [].concat(x.modules || []).filter((m) => m && m.gb > 0);
  if (!mods.length) return [];
  const amd = /AMD|Ryzen/i.test(x.cpu || '');
  const base = { group: 'memory', boardMaker: x.boardMaker, boardModel: x.boardModel, profile: amd ? 'EXPO' : 'XMP' };
  // Channels: two sticks in the same channel run at half the memory speed of two channels.
  const keys = mods.map(memChannel);
  const channels = keys.every((k) => k != null) ? new Set(keys).size : null;
  const chan = {
    ...base, key: 'memChannels', sticks: mods.length, channels, slots: x.slots, laptop: x.laptop,
    ok: channels == null ? null : channels >= 2 ? true : x.laptop && mods.length === 1 ? null : false,
    guide: channels === 1 && mods.length > 1 ? 'channels' : null,
  };
  // Speed: running below what the kit is sold at means its XMP/EXPO profile is off.
  const configured = Math.min(...mods.map((m) => m.configured || m.speed || 0));
  const rated = Math.max(...mods.map((m) => Math.max(ratedFromPart(m.part) || 0, m.speed || 0)));
  const ddr = mods[0].type === 34 ? 5 : mods[0].type === 26 ? 4 : null;
  const speed = {
    ...base, key: 'memSpeed', configured, rated, ddr,
    ok: !configured || !rated ? null : configured >= rated * 0.97,
    guide: rated && configured && configured < rated * 0.97 ? 'xmp' : null,
  };
  return x.laptop ? [chan] : [chan, speed];
}

function advise(list) {
  const out = [];
  for (const x of list) {
    if (x.key === 'power') {
      const p = powerAdvice(x);
      out.push({ ...p, group: 'cpu' });
      // Desktop CPUs that boost to 150 W and more: lowering the power limit in the BIOS is the
      // most effective way to run cooler. A tip, judged on the page from the live readings.
      if (!x.laptop && ['intelHybrid', 'amd', 'amdX3D'].includes(p.cpuKind)) out.push({ key: 'powerLimit', group: 'cpu', cpuKind: p.cpuKind, intel1314: INTEL_1314_DESKTOP.test(x.cpu || ''), ok: null, guide: 'powerLimit' });
    } else if (x.key === 'microcode') {
      const m = microcodeAdvice(x);
      if (m) out.push(m);
    } else if (x.key === 'memory') {
      out.push(...memoryAdvice(x));
    } else if (x.key === 'trim') {
      if (!x.ssd || x.on == null) continue;
      out.push({ ...x, group: 'storage', ok: !!x.on, action: null });
    } else {
      const group = { gamemode: 'windows', hags: 'gpu', disk: 'storage', bios: 'board' }[x.key] || 'windows';
      out.push({ ...x, group });
    }
  }
  return out;
}

module.exports = { memChannel, ratedFromPart, advise };
