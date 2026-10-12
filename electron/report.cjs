// Hardware list as a spreadsheet (CSV, opens in Excel) or a plain-text report, in English so it
// can be pasted into a support ticket or forum as is. `hw` is the result of scanHardware().
function hardwareReport(hw, format) {
  const bad = new Map((hw.problems || []).map((p) => [p.id, p.code]));
  const summary = [
    ['Computer', hw.computer], ['Motherboard', hw.board], ['BIOS', `${hw.bios.version} (${hw.bios.date})`], ['CPU', hw.cpu],
    ['RAM', `${hw.ramGB} GB`], ...(hw.gpus || []).map((g) => ['GPU', `${g.name} (driver ${g.driverVersion})`]),
  ];
  const devices = [...(hw.devices || [])].sort((a, b) => `${a.cls}${a.name}`.localeCompare(`${b.cls}${b.name}`));
  if (format === 'csv') {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [
      ...summary.map((r) => r.map(esc).join(',')), '',
      ['Device', 'Class', 'Manufacturer', 'Driver provider', 'Driver version', 'Driver date', 'Status', 'Hardware ID', 'Device ID'].map(esc).join(','),
      ...devices.map((d) => [d.name, d.cls, d.maker, d.provider, d.version, d.date, bad.has(d.id) ? `Problem (code ${bad.get(d.id)})` : 'OK', d.hwid, d.id].map(esc).join(',')),
      // A device with a problem often has no driver at all, so it isn't in the list above.
      ...(hw.problems || []).filter((p) => !devices.some((d) => d.id === p.id))
        .map((p) => [p.name, '', '', '', '', '', `Problem (code ${p.code})`, '', p.id].map(esc).join(',')),
    ].join('\r\n');
  }
  const lines = [`Tune hardware report - ${new Date().toLocaleString('en-GB')}`, '', ...summary.map(([k, v]) => `${k}: ${v}`), ''];
  if (hw.problems?.length) lines.push('Devices with problems:', ...hw.problems.map((p) => `  ${p.name} (Device Manager code ${p.code})`), '');
  lines.push(`Devices (${devices.length}):`);
  let cls;
  for (const d of devices) {
    if (d.cls !== cls) { cls = d.cls; lines.push('', `[${cls || 'Other'}]`); }
    lines.push(`  ${d.name} | driver ${d.version}${d.date ? ` (${d.date})` : ''} | ${d.provider || d.maker || ''}`);
  }
  return lines.join('\r\n');
}

module.exports = { hardwareReport };
