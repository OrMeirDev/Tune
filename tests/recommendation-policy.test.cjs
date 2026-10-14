// The recommendation rules as they behave today (characterization tests): the power plan, memory
// channels and memory speed. A change to these rules should change a test here on purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const { advise, memChannel, ratedFromPart } = require('../electron/domain/recommendation-policy.cjs');

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const one = (x) => advise([x]);

test('power plan: Balanced is right for hybrid Intel and Ryzen; High performance only for older Intel', () => {
  assert.equal(one({ key: 'power', cpu: 'Intel(R) Core(TM) i7-14700K', guid: BALANCED, value: 'Balanced' })[0].ok, true);
  assert.equal(one({ key: 'power', cpu: 'Intel(R) Core(TM) i7-14700K', guid: HIGH, value: 'High performance' })[0].ok, false);
  assert.equal(one({ key: 'power', cpu: 'Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz', guid: HIGH, value: 'High performance' })[0].ok, true);
  assert.equal(one({ key: 'power', cpu: 'AMD Ryzen 7 7800X3D 8-Core Processor', guid: HIGH, value: 'High performance' })[0].ok, false);
  // a copied plan is recognized by its name, in Hebrew too
  assert.equal(one({ key: 'power', cpu: 'AMD Ryzen 9 7950X3D', guid: 'aaaaaaaa-0000-0000-0000-000000000000', value: 'ביצועים אולטימטיביים' })[0].plan, 'ultimate');
});

test('desktop chips that boost high get the power-limit tip; laptops do not', () => {
  const desk = one({ key: 'power', cpu: 'Intel(R) Core(TM) i7-14700K', guid: BALANCED, value: 'Balanced' });
  assert.equal(desk[1].key, 'powerLimit');
  assert.equal(desk[1].intel1314, true);
  const lap = one({ key: 'power', cpu: 'Intel(R) Core(TM) i7-13700H', guid: BALANCED, value: 'Balanced', laptop: true });
  assert.equal(lap.length, 1);
});

test('memory channel from the slot names boards report', () => {
  assert.equal(memChannel({ locator: 'Controller0-DIMM1', bank: 'BANK 0' }), '0');
  assert.equal(memChannel({ locator: 'DIMM 1', bank: 'P0 CHANNEL A' }), 'A');
  assert.equal(memChannel({ locator: 'DIMM_B2', bank: '' }), 'B');
  assert.equal(memChannel({ locator: 'A1', bank: '' }), 'A');
  assert.equal(memChannel({ locator: 'XMM1', bank: 'BANK 3' }), null);
});

test('two sticks: two channels is fine, one channel gets the guide, unknown slots stay unknown', () => {
  const stick = (locator) => ({ gb: 16, locator, bank: '', speed: 5600, configured: 5600, part: 'CMK32GX5M2B5600C36', type: 34 });
  const [dual] = one({ key: 'memory', cpu: 'Intel', modules: [stick('DIMM_A2'), stick('DIMM_B2')] });
  assert.deepEqual([dual.channels, dual.ok, dual.guide], [2, true, null]);
  const [single] = one({ key: 'memory', cpu: 'Intel', modules: [stick('DIMM_A1'), stick('DIMM_A2')] });
  assert.deepEqual([single.channels, single.ok, single.guide], [1, false, 'channels']);
  const [unknown] = one({ key: 'memory', cpu: 'Intel', modules: [stick('XMM1'), stick('XMM2')] });
  assert.deepEqual([unknown.channels, unknown.ok], [null, null]);
});

test('rated speed from part numbers', () => {
  assert.equal(ratedFromPart('F5-6000J3038F16G'), 6000);
  assert.equal(ratedFromPart('CMK32GX5M2B6000C36'), 6000);
  assert.equal(ratedFromPart('KF560C36BBEK2-32'), 6000);
  assert.equal(ratedFromPart('TF3D516G6000HC38ADC01'), 6000);
  assert.equal(ratedFromPart('M425R2GA3BB0-CQKOL'), null);
});

test('memory speed: below the kit rating means the XMP/EXPO profile is off', () => {
  const kit = (configured, part) => ({ gb: 16, locator: 'DIMM_A2', bank: '', speed: 4800, configured, part, type: 34 });
  const [, slow] = one({ key: 'memory', cpu: 'Intel', modules: [kit(4800, 'CMK32GX5M2B6000C36')] });
  assert.deepEqual([slow.rated, slow.ok, slow.guide, slow.profile], [6000, false, 'xmp', 'XMP']);
  const [, fast] = one({ key: 'memory', cpu: 'AMD Ryzen 7', modules: [kit(6000, 'CMK32GX5M2B6000C36')] });
  assert.deepEqual([fast.ok, fast.profile], [true, 'EXPO']);
  // Known gap (audit TUN-16): when the part number can't be read, the stick's own reported speed is
  // used as its rating, so the speed is judged fine. To be changed to "unknown" with TUN-16.
  const [, unread] = one({ key: 'memory', cpu: 'Intel', modules: [kit(4800, 'UNKNOWN-PART')] });
  assert.equal(unread.ok, true);
});
