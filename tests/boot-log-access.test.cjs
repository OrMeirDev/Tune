// B1: the pure classifier and real PowerShell catch/probe path, without modifying the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { BOOT_PS } = require('../electron/features/measurements.cjs');
const { bootTimingStatus } = require('../electron/domain/measurement-policy.cjs');

test('B1: access denial is not an empty start-up log', () => {
  for (const [timingQuery, timingLog, expected] of [
    ['ok', null, 'ok'], ['denied', null, 'needsAdmin'], ['noMatch', 'denied', 'needsAdmin'],
    ['noMatch', 'readable', 'none'], ['noMatch', 'empty', 'none'],
    ['noMatch', 'unavailable', 'unavailable'], ['noMatch', null, 'unavailable'],
    ['unavailable', null, 'unavailable'], ['unexpected', 'readable', 'unavailable'],
  ]) assert.equal(bootTimingStatus({ timingQuery, timingLog }), expected);
});

test('B1: BOOT_PS probes access when the filtered query reports no matches', { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, () => {
  for (const [mode, expected] of [['denied', 'needsAdmin'], ['readable', 'none'], ['empty', 'none'], ['broken', 'unavailable']]) {
    const script = `
$mode = '${mode}'; $script:probes = 0
function Get-WinEvent {
  [CmdletBinding()] param($FilterHashtable, $LogName, $MaxEvents)
  if ($FilterHashtable -and $FilterHashtable.LogName -eq 'System') { return }
  if ($LogName) {
    $script:probes++
    if ($mode -eq 'denied') { throw [UnauthorizedAccessException]::new('denied') }
    if ($mode -eq 'readable') { return [pscustomobject]@{ Id = 101 } }
    if ($mode -eq 'broken') { throw 'unavailable log' }
  }
  $e = [System.Management.Automation.ErrorRecord]::new([Exception]::new('no matching events'), 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand', [System.Management.Automation.ErrorCategory]::ObjectNotFound, $null)
  $PSCmdlet.ThrowTerminatingError($e)
}
${BOOT_PS}
@{ timingQuery = $result.timingQuery; timingLog = $result.timingLog; probes = $script:probes } | ConvertTo-Json -Compress
`;
    const raw = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 }));
    assert.equal(raw.probes, 1, mode);
    assert.equal(raw.timingQuery, 'noMatch', mode);
    assert.equal(bootTimingStatus(raw), expected, mode);
  }
});
