// Comparing dotted version numbers (pure).
const cmpVer = (a, b) => {
  const x = String(a || '').split('.').map(Number);
  const y = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};

module.exports = { cmpVer };
