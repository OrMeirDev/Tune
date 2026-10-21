// Renderer summaries must preserve uncertainty and never revive stale readings as healthy ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
const bundle = esbuild.buildSync({
  stdin: { contents: `
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {LangContext,makeT} from './src/i18n.js';
    import {OverviewPage} from './src/features/overview/OverviewPage.jsx';
    export function render(props,lang='en') {
      return renderToStaticMarkup(<LangContext.Provider value={makeT(lang)}><OverviewPage {...props}/></LangContext.Provider>);
    }
  `, loader: 'jsx', resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react-dom/server', 'lucide-react'],
}).outputFiles[0].text;
const compiled = new Module(path.join(root, 'ui-summary-test.cjs'), module);
compiled.filename = path.join(root, 'ui-summary-test.cjs');
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle, compiled.filename);
const { render } = compiled.exports;
const base = { go: () => assert.fail('render must not navigate'), onProblem: () => assert.fail('render must not start a check') };

test('an unknown recommendation is reviewable, not summarized as all OK, in both languages', () => {
  for (const [lang, review, healthy] of [['en', '1 to review', 'All OK'], ['he', '1 לבדיקה', 'הכול תקין']]) {
    const html = render({ ...base, recs: [{ key: 'power', ok: null, unchecked: true }] }, lang);
    assert.ok(html.includes(review));
    assert.ok(!html.includes(healthy));
  }
});

test('a failed current scan keeps the older rows but does not claim a current size or startup count', () => {
  const html = render({ ...base, junk: [{ key: 'userTemp', bytes: 1.6e9 }], startup: [{ name: 'SAMPLE app', source: 'sample', key: 'one', enabled: true }], sources: { junk: 'error', startup: 'error' } });
  const heads = [...html.matchAll(/class="ohead"[^>]*>(.*?)<\/div>/gs)].map(m => m[1]);
  assert.ok(heads[0].includes('—') && !heads[0].includes('GB'));
  assert.ok(heads[1].includes('—') && !heads[1].includes('1 active'));
  assert.ok(html.includes('SAMPLE app'), 'the previous list is still available');
  assert.ok(html.includes('overview-state'), 'its failed-read explanation stays visible');
});

test('stale live sensors do not fall back to an older successful temperature', () => {
  const html = render({ ...base, perf: { cpuLoad: 8, cpuTempC: 48, ramTotalGB: 32, ramFreeGB: 20 }, live: { cpuTempC: null, cpuNote: 'stale' } });
  assert.ok(!html.includes('48°C'));
  assert.match(html, /sensor reading is out of date/i);
});
