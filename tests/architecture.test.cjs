// The renderer's dependency rules (see AGENTS.md), checked on every `npm test`:
// - nothing imports App.jsx except the entry point;
// - domain/ is pure: no React, no icons, no Electron, no UI modules;
// - components/ and presentation/ don't reach into features/ or the app shell;
// - a feature never imports another feature's page;
// - the renderer never imports Node or Electron modules (only the preload bridge, via api.js);
// - no import cycles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(f)) files.push(p);
  }
})(SRC);

const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
const importsOf = (file) => {
  const code = fs.readFileSync(file, 'utf8');
  return [...code.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
};
const resolve = (from, spec) => (spec.startsWith('.') ? rel(path.resolve(path.dirname(from), spec)) : spec);
const graph = new Map(files.map((f) => [rel(f), importsOf(f).map((s) => resolve(f, s))]));

test('only the entry point imports App.jsx', () => {
  for (const [f, deps] of graph) if (deps.includes('App.jsx')) assert.equal(f, 'main.jsx', `${f} imports App.jsx`);
});

test('domain modules are pure', () => {
  for (const [f, deps] of graph) {
    if (!f.startsWith('domain/')) continue;
    for (const d of deps) assert.ok(d.startsWith('domain/'), `${f} imports ${d}`);
  }
});

test('shared components and presentation helpers stay out of features and the shell', () => {
  for (const [f, deps] of graph) {
    if (!/^(components|presentation)\//.test(f)) continue;
    for (const d of deps) assert.ok(!/^(features|app)\//.test(d) && d !== 'App.jsx', `${f} imports ${d}`);
  }
});

test("a feature doesn't import another feature's page", () => {
  for (const [f, deps] of graph) {
    const own = f.match(/^features\/([^/]+)\//)?.[1];
    if (!own) continue;
    for (const d of deps) {
      const m = d.match(/^features\/([^/]+)\/[^/]*Page\.jsx$/);
      assert.ok(!m || m[1] === own, `${f} imports ${d}`);
    }
  }
});

test('the renderer never imports Node or Electron modules', () => {
  const banned = /^(electron|fs|path|os|net|child_process|crypto|node:)/;
  for (const [f, deps] of graph) for (const d of deps) assert.ok(!banned.test(d), `${f} imports ${d}`);
});

test('no import cycles', () => {
  const state = new Map();
  const visit = (f, trail) => {
    if (state.get(f) === 'done') return;
    assert.notEqual(state.get(f), 'open', `cycle: ${[...trail, f].join(' -> ')}`);
    state.set(f, 'open');
    for (const d of graph.get(f) || []) if (graph.has(d)) visit(d, [...trail, f]);
    state.set(f, 'done');
  };
  for (const f of graph.keys()) visit(f, []);
});

// ---- the main process (electron/) ----
// - domain/ is pure: requires only other domain modules (no Node, Electron or Windows calls);
// - infra/ (PowerShell, downloads) knows nothing of features or privileges;
// - privilege/ (service, admin session, the fixed operations) never requires features;
// - no require cycles.
const EL = path.join(__dirname, '..', 'electron');
const elFiles = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.cjs')) elFiles.push(p);
  }
})(EL);
const elRel = (p) => path.relative(EL, p).split(path.sep).join('/');
const elGraph = new Map(elFiles.map((f) => {
  const specs = [...fs.readFileSync(f, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  return [elRel(f), specs.map((s) => (s.startsWith('.') ? elRel(path.resolve(path.dirname(f), s)) : s))];
}));

test('main-process domain modules are pure', () => {
  for (const [f, deps] of elGraph) if (f.startsWith('domain/')) for (const d of deps) assert.ok(d.startsWith('domain/'), `${f} requires ${d}`);
});

test('infra and privilege layers never require features', () => {
  for (const [f, deps] of elGraph) {
    if (!/^(infra|privilege)\//.test(f)) continue;
    for (const d of deps) assert.ok(!d.startsWith('features/'), `${f} requires ${d}`);
    if (f.startsWith('infra/')) for (const d of deps) assert.ok(!d.startsWith('privilege/'), `${f} requires ${d}`);
  }
});

test('no require cycles in the main process', () => {
  const state = new Map();
  const visit = (f, trail) => {
    if (state.get(f) === 'done') return;
    assert.notEqual(state.get(f), 'open', `cycle: ${[...trail, f].join(' -> ')}`);
    state.set(f, 'open');
    for (const d of elGraph.get(f) || []) if (elGraph.has(d)) visit(d, [...trail, f]);
    state.set(f, 'done');
  };
  for (const f of elGraph.keys()) visit(f, []);
});

test('the request layer (ipc/) gets the Windows operations injected, never requires them', () => {
  for (const [f, deps] of elGraph) {
    if (!f.startsWith('ipc/')) continue;
    for (const d of deps) assert.ok(!/^(features|privilege|infra)\//.test(d) && d !== 'system.cjs', `${f} requires ${d}`);
  }
});
