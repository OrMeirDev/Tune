// CSV export (audit TUN-17): text that a spreadsheet would run as a formula stays literal text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { csvCell, hardwareReport } = require('../electron/report.cjs');

test('formula-like text gets a leading apostrophe', () => {
  for (const v of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x', '\r=x']) assert.equal(csvCell(v), `"'${v}"`);
});

test('plain values, numbers and Hebrew are unchanged; quotes are doubled', () => {
  assert.equal(csvCell('NVIDIA GeForce'), '"NVIDIA GeForce"');
  assert.equal(csvCell('-5'), '"-5"');
  assert.equal(csvCell('3.14'), '"3.14"');
  assert.equal(csvCell('כרטיס רשת'), '"כרטיס רשת"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '""');
});

test('the exported spreadsheet neutralizes a crafted computer name', () => {
  const hw = { computer: '=HYPERLINK("x")', board: 'B', bios: { version: '1', date: 'd' }, cpu: 'C', ramGB: 32, gpus: [], devices: [], problems: [] };
  const first = hardwareReport(hw, 'csv').split('\r\n')[0];
  assert.equal(first, '"Computer","\'=HYPERLINK(""x"")"');
});
