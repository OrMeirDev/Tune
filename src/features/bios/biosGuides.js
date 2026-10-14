// BIOS keys and menu names per board maker.
// BIOS menus differ by board maker; these are the names each maker uses.
const BIOS_HINTS = {
  asus: { name: 'ASUS', key: 'Del', adv: 'F7', xmp: 'Ai Tweaker → Ai Overclock Tuner → {profile} I', power: 'Ai Tweaker' },
  msi: { name: 'MSI', key: 'Del', adv: 'F7', xmp: 'OC → Extreme Memory Profile ({profile})', power: 'OC' },
  gigabyte: { name: 'Gigabyte', key: 'Del', adv: 'F2', xmp: 'Tweaker → Extreme Memory Profile ({profile})', power: 'Tweaker' },
  asrock: { name: 'ASRock', key: 'F2', adv: 'F6', xmp: 'OC Tweaker → DRAM Configuration → {profile}', power: 'OC Tweaker' },
  other: { name: '', key: 'Del / F2', adv: 'F7', xmp: '{profile}', power: 'Advanced' },
};

export const biosHint = (maker = '') => BIOS_HINTS[/asus/i.test(maker) ? 'asus' : /micro-star|msi/i.test(maker) ? 'msi' : /gigabyte/i.test(maker) ? 'gigabyte' : /asrock/i.test(maker) ? 'asrock' : 'other'];
