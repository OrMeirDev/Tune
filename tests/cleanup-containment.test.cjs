// Cleanup stays inside its folders (audit TUN-15), checked by running the real cleanup operation
// (Windows only) on a throwaway folder this test creates: old files go, recent files stay, and a
// junction inside the folder that points outside it is never followed. Nothing outside the test's
// own temporary folder is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JUNK, CLEAN_OP } = require('../electron/privilege/operations.cjs');

test('cleanup never follows a junction out of its folder', { skip: process.platform !== 'win32' && 'needs Windows' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-clean-test-'));
  try {
    const root = path.join(base, 'temp');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.mkdirSync(outside);
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    for (const f of [path.join(root, 'old.txt'), path.join(root, 'sub', 'old2.txt'), path.join(outside, 'precious.txt')]) {
      fs.writeFileSync(f, 'x'.repeat(100));
      fs.utimesSync(f, old, old);
    }
    fs.writeFileSync(path.join(root, 'recent.txt'), 'still in use');
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(root, 'link'), outside], { stdio: 'ignore' });
    assert.ok(fs.existsSync(path.join(root, 'link', 'precious.txt')), 'the junction leads outside');

    const script = `$ErrorActionPreference = 'Stop'\n${JUNK}\n$cats = @(@{ key = 't'; paths = @('${root.replace(/'/g, "''")}'); admin = $false; minAgeHours = 24 })\n$req = @{ keys = @('t') }\n${CLEAN_OP}\n$result | ConvertTo-Json -Compress`;
    const file = path.join(base, 'run.ps1');
    fs.writeFileSync(file, '﻿' + script, 'utf8');
    const r = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' }));

    assert.equal(fs.existsSync(path.join(root, 'old.txt')), false, 'old file cleaned');
    assert.equal(fs.existsSync(path.join(root, 'sub', 'old2.txt')), false, 'old file in a subfolder cleaned');
    assert.equal(fs.existsSync(path.join(root, 'recent.txt')), true, 'recent file kept');
    assert.equal(fs.existsSync(path.join(outside, 'precious.txt')), true, 'the file behind the junction is untouched');
    assert.equal(fs.existsSync(path.join(root, 'link')), true, 'the junction itself is left alone');
    assert.equal(r.freed, 200);
    assert.deepEqual([].concat(r.busy || []), []);
  } finally {
    try { fs.rmdirSync(path.join(base, 'temp', 'link')); } catch { /* removes only the junction */ }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
