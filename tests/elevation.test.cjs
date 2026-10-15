// Audit TUN-02 (elevated execution of user-writable scripts) and TUN-12 (recoverable service
// updates): what Windows elevates, and what the elevated code does with files.
// - The elevated PowerShell gets its script inside the command line it is started with
//   (-EncodedCommand), never as a file, so nothing can be swapped between writing and the prompt.
// - It answers over its own pipe (this user only) and writes no files into the user's folders.
// - The service install copies into a new protected folder in Program Files, checks every copy
//   there against the manifest built with this version, and switches only to a version that answers,
//   with a way back. Uninstall reports a failure.
// The scripts themselves run on the Windows CI runner (scripts/ci/installer-check.ps1).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const EL = path.join(__dirname, '..', 'electron', 'privilege');
const { encodedCommand, elevatedArgs, oneShotScript, COMMAND_LINE_MAX } = require(path.join(EL, 'elevated.cjs'));
const { adminHelper } = require(path.join(EL, 'admin-session.cjs'));
const service = require(path.join(EL, 'service.cjs'));
const { buildInfo, manifestOf } = require(path.join(__dirname, '..', 'scripts', 'build-service.cjs'));

// What the elevated PowerShell actually runs: the bootstrap's embedded, gzip-compressed script.
function unwrap(enc) {
  const boot = Buffer.from(enc, 'base64').toString('utf16le');
  const m = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(boot);
  assert.ok(m, 'a bootstrap that carries the script');
  return { boot, script: zlib.gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8') };
}

const sample = { version: '6', id: 'abcdef012345', files: { 'TuneService.exe': 'A'.repeat(64), 'ops.ps1': 'B'.repeat(64), 'LibreHardwareMonitorLib.dll': 'C'.repeat(64) } };
const longSrc = `C:\\Users\\${'u'.repeat(60)}\\AppData\\Local\\Programs\\Tune\\resources\\service`;

test('the elevated script travels in the command line, compressed, and comes back unchanged', () => {
  const helper = adminHelper('TuneAdmin-0123456789abcdef01234567', 4242);
  const { boot, script } = unwrap(encodedCommand(helper));
  assert.equal(script, helper);
  assert.doesNotMatch(boot, /-File|\.ps1|Get-Content|ReadAllText/, 'the bootstrap reads nothing from disk');
  for (const s of [helper, oneShotScript('TuneElevated-x', service.installScript(longSrc, sample)), oneShotScript('TuneElevated-x', service.uninstallScript())]) {
    const args = elevatedArgs(s);
    assert.equal(args.at(-2), '-EncodedCommand');
    assert.ok(!args.includes('-File'));
    assert.ok(args.join(' ').length < COMMAND_LINE_MAX - 1000, `fits a command line with room to spare (${args.join(' ').length})`);
  }
});

test('elevated PowerShell loads modules only from its own folder, never from the user\'s Documents', () => {
  const { ELEVATED_PRELUDE } = require(path.join(EL, 'elevated.cjs'));
  const pin = "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules');";
  assert.ok(ELEVATED_PRELUDE.startsWith(pin));
  for (const s of [adminHelper('TuneAdmin-x', 1), oneShotScript('TuneElevated-x', service.installScript(longSrc, sample)), oneShotScript('TuneElevated-x', service.uninstallScript())]) {
    assert.ok(s.startsWith(pin), 'the script pins it first');
    assert.ok(unwrap(encodedCommand(s)).boot.startsWith(pin), 'and so does the bootstrap, before anything else runs');
  }
});

test('the privileged modules never write a script or a result file for an elevated process', () => {
  for (const f of ['elevated.cjs', 'admin-session.cjs', 'service.cjs', 'pipe.cjs']) {
    const src = fs.readFileSync(path.join(EL, f), 'utf8');
    assert.doesNotMatch(src, /writeFileSync|tempFile\(|'-File'|mkdtemp/, f);
  }
  // and the elevated scripts' own code writes nothing into the user's folders (results go over the
  // pipe); the fixed operations catalog they carry is the audited one (privilege/operations.cjs)
  const { STARTUP, JUNK, OPS_TABLE } = require(path.join(EL, 'operations.cjs'));
  const own = adminHelper('TuneAdmin-x', 1).replace(`${STARTUP}${JUNK}${OPS_TABLE()}`, '');
  assert.ok(own.length < adminHelper('TuneAdmin-x', 1).length, 'the catalog was found and set aside');
  for (const s of [own, oneShotScript('TuneElevated-x', '$result = 1')]) {
    assert.doesNotMatch(s, /WriteAllText|Move-Item|Set-Content|Out-File|\$env:TEMP|tmpdir/i);
  }
});

test("the elevated pipe is the asking account's (plus the elevated one, SYSTEM and administrators), and a silent client can't hold it", () => {
  // with Windows' over-the-shoulder prompt the helper runs as an administrator's account, while Tune
  // (a standard user) is the one that connects: the pipe names Tune's account explicitly
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  for (const s of [adminHelper('TuneAdmin-x', 1, sid), oneShotScript('TuneElevated-x', '$result = 1', sid)]) {
    assert.ok(s.includes(`$tuneUser = '${sid}'`), 'the asking account is named');
    assert.ok(s.indexOf('$tuneUser = ') < s.indexOf('function New-TunePipe'), 'before the pipe is made');
  }
  assert.match(adminHelper('TuneAdmin-x', 1, "S-1-5-21-1'; evil"), /\$tuneUser = \$null/, 'anything but a SID is left out');
  const helper = adminHelper('TuneAdmin-x', 1, sid);
  assert.match(helper, /WindowsIdentity\]::GetCurrent\(\)\.User/);
  assert.match(helper, /'S-1-5-18', 'S-1-5-32-544'/);
  assert.doesNotMatch(helper, /S-1-1-0|S-1-5-11|S-1-5-4'|Everyone|Interactive/i, 'no group of other users');
  assert.match(helper, /Read-TuneLine \$pipe 10000/, 'the request is read with a deadline');
  assert.match(helper, /Tune-Open/, 'the helper stops when Tune closes');
});

test('install: a protected new folder, every copy checked there, switch only to a version that answers, with a way back', () => {
  const s = service.installScript(longSrc, sample);
  const at = (re) => { const m = re.exec(s); assert.ok(m, String(re)); return m.index; };
  const protect = at(/Protect-Folder \$root/);
  const copy = at(/Copy-Item -LiteralPath \(Join-Path \$src \$e\[0\]\) -Destination \$to/);
  const hash = at(/Get-FileHash -LiteralPath \$to -Algorithm SHA256/);
  const switchTo = at(/sc\.exe config TuneService binPath= \$bin/);
  const health = at(/Test-ServiceAnswers '6' 30/);
  const cleanup = at(/Older versions go/);
  assert.ok(protect < copy && copy < hash && hash < switchTo && switchTo < health && health < cleanup, 'protect, copy, check the copy, switch, health check, then clean up');
  assert.match(s, /Join-Path \$env:ProgramFiles 'Tune Service'/);
  assert.match(s, /Assert-Protected \$dst/);
  assert.match(s, /binPath= \$previous/, 'a failed update goes back to the previous version');
  assert.match(s, /does not match this version of Tune; nothing was changed/);
  for (const [name, h] of Object.entries(sample.files)) assert.ok(s.includes(`@('${name}', '${h}')`), name);
});

test('install refuses a missing or malformed manifest before asking for anything', async () => {
  assert.equal(service.validManifest(sample), true);
  for (const bad of [null, { ...sample, version: '6; rm' }, { ...sample, files: {} }, { ...sample, files: { '..\\x.exe': 'A'.repeat(64) } },
    { ...sample, files: { 'TuneService.exe': 'abc' } }, { ...sample, files: { '..': 'A'.repeat(64) } }]) {
    assert.equal(service.validManifest(bad), false, JSON.stringify(bad && bad.files));
  }
  const r = await service.installService(longSrc, undefined, { manifest: { ...sample, files: { 'a/b.exe': 'A'.repeat(64) } } });
  assert.deepEqual(r, { ok: false, error: 'the service manifest is not valid' });
});

test('uninstall says when the service could not be removed', () => {
  const s = service.uninstallScript();
  assert.match(s, /throw "the service could not be removed/);
  assert.match(s, /throw 'the service is still registered'/);
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /--uninstall-service' \$0/);
  assert.match(nsh, /\$\{if\} \$0 != 0/);
});

test('one service version for the app and the service (privilege/service-version.cjs)', () => {
  const v = require(path.join(EL, 'service-version.cjs'));
  assert.match(v, /^\d+$/);
  assert.equal(service.SERVICE_VERSION, v);
  assert.match(buildInfo(v), new RegExp(`Version = "${v}"`));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-service.cjs'), 'utf8'), /require\('\.\.\/electron\/privilege\/service-version\.cjs'\)/);
  const cs = fs.readFileSync(path.join(__dirname, '..', 'service', 'TuneService.cs'), 'utf8');
  assert.match(cs, /public const string Version = BuildInfo\.Version;/);
  assert.doesNotMatch(cs, /const string Version = "\d+"/, 'no second copy of the number');
  assert.throws(() => buildInfo('6"; evil'));
});

test('the build manifest: the SHA-256 of each service file, and an id for the set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-manifest-'));
  fs.writeFileSync(path.join(dir, 'TuneService.exe'), 'exe');
  fs.writeFileSync(path.join(dir, 'ops.ps1'), 'ops');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'not shipped');
  const m = manifestOf(dir, '6');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(Object.keys(m.files), ['TuneService.exe', 'ops.ps1']);
  assert.equal(m.files['TuneService.exe'], crypto.createHash('sha256').update('exe').digest('hex').toUpperCase());
  assert.match(m.id, /^[0-9a-f]{12}$/);
  assert.equal(service.validManifest(m), true);
});

test('a signed build: the service is signed before it is hashed, never re-signed, and the installer requires the signer', () => {
  const pkg = require('../package.json');
  assert.ok((pkg.build.win.signExts || []).includes('!TuneService.exe'), 'electron-builder leaves TuneService.exe as hashed');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-service.cjs'), 'utf8');
  assert.ok(src.indexOf('signService(path.join(out') < src.indexOf('manifestOf(out, version)'), 'signed, then hashed');
  const signer = 'AB'.repeat(20);
  assert.equal(service.validManifest({ ...sample, signer }), true);
  assert.equal(service.validManifest({ ...sample, signer: 'not-a-thumbprint' }), false);
  const signed = service.installScript(longSrc, { ...sample, signer });
  assert.match(signed, new RegExp(`SignerCertificate\\.Thumbprint -ne '${signer}'`));
  assert.ok(signed.indexOf('Get-AuthenticodeSignature -LiteralPath (Join-Path $dst') < signed.indexOf('sc.exe config TuneService binPath= $bin'), 'checked before the switch');
  assert.doesNotMatch(service.installScript(longSrc, sample), /Join-Path \$dst 'TuneService\.exe'\)\s*\nif \(\$sig/, 'an unsigned build has no signer to require');
});
