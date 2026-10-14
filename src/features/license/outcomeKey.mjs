// Which message an outcome gets (lic.o.*). An answer that didn't arrive is "not confirmed", and what
// trying again does depends on the action, so each action has its own message. Pure; tested in
// tests/licensing-repairs.test.cjs.
const UNCONFIRMED = ['activate', 'recover', 'refresh', 'ownerStart', 'ownerConfirm'];

export function outcomeKey(o) {
  if (!o) return null;
  if (o.result === 'unavailable') return UNCONFIRMED.includes(o.action) ? `lic.o.unavailable.${o.action}` : 'lic.o.unavailable';
  return `lic.o.${o.result}`;
}
