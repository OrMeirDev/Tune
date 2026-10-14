// The shape each request from the window may have. Tiny rule builders (no library): every rule is a
// function that says yes or no to one argument. Pure; tested in tests/ipc.test.cjs.

const str = (max = 200) => (v) => typeof v === 'string' && v.length > 0 && v.length <= max;
const match = (re, max = 200) => (v) => typeof v === 'string' && v.length <= max && re.test(v);
const oneOf = (list) => (v) => list.includes(v);
const bool = () => (v) => typeof v === 'boolean';
const optional = (rule) => (v) => v === undefined || rule(v);
const arrayOf = (rule, max) => (v) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(rule);
// any JSON-able value up to a size (for the scan cache)
const json = (maxChars) => (v) => {
  try { return JSON.stringify(v ?? null).length <= maxChars; } catch { return false; }
};

// A request matches when it has no more arguments than its rules and every rule says yes.
const argsMatch = (rules, args) => args.length <= rules.length && rules.every((rule, i) => rule(args[i]));

module.exports = { str, match, oneOf, bool, optional, arrayOf, json, argsMatch };
