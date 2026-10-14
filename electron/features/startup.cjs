// Apps that start with Windows: listing them and turning them on or off.
const { runPS } = require('../infra/powershell.cjs');
const { STARTUP } = require('../privilege/operations.cjs');
const { privileged } = require('../privilege/service.cjs');

const startupList = () => runPS(`${STARTUP}
$result = @(foreach ($s in $src) {
  $entries = @()
  if ($s.run -and (Test-Path $s.run)) { $k = Get-Item $s.run; $entries = @($k.GetValueNames() | Where-Object { $_ } | ForEach-Object { @{ name = $_; cmd = [string]$k.GetValue($_) } }) }
  if ($s.folder -and (Test-Path $s.folder)) { $entries = @(Get-ChildItem $s.folder -File | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object { @{ name = $_.Name; cmd = $_.FullName } }) }
  foreach ($e in $entries) {
    $on = $true
    if (Test-Path $s.approved) { $v = (Get-ItemProperty $s.approved -ErrorAction SilentlyContinue).($e.name); if ($v -is [byte[]] -and $v.Length -gt 0) { $on = ($v[0] % 2 -eq 0) } }
    @{ name = ($e.name -replace '\\.lnk$',''); key = $e.name; cmd = $e.cmd; source = $s.hive; enabled = $on; admin = ($s.hive -like 'HKLM*') }
  } })`);

// Per-user entries change without admin rights; machine-wide ones go through the admin session.
const startupToggle = (source, key, enable) => (/^HKLM/.test(source)
  ? privileged({ op: 'startup', hive: String(source), key: String(key), enable: !!enable })
  : runPS(`${STARTUP}
$s = $src | Where-Object { $_.hive -eq '${String(source).replace(/[^A-Za-z0-9-]/g, '')}' } | Select-Object -First 1
if (-not (Test-Path $s.approved)) { New-Item -Path $s.approved -Force | Out-Null }
$bytes = [byte[]](${enable ? '2' : '3'},0,0,0,0,0,0,0,0,0,0,0)
Set-ItemProperty -Path $s.approved -Name '${String(key).replace(/'/g, "''")}' -Value $bytes -Type Binary
$result = '${enable ? 'enabled' : 'disabled'}'`));

module.exports = { startupList, startupToggle };
