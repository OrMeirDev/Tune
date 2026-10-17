# The service's deadlines (audit TUN-06) on a disposable Windows CI runner, against a console copy
# of the freshly built service (--console, its own pipe name, a 5 s operation limit) whose ops.ps1 is
# a test stand-in: every operation hangs and starts a child process. Nothing is installed.
# - a client that connects and says nothing, or sends half a request, is dropped after about 5 s
# - a hung operation is ended after its limit, with the process it started, and answered "timedOut"
# - while it runs, the read-only version request is still answered at once, and a second change
#   hears "busy" after about 2 s instead of waiting
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'runs only on a disposable CI runner' }

$script:failures = 0
function Check([string]$name, [bool]$cond, $got = $null) {
  if ($cond) { Write-Output "PASS $name" } else { Write-Output "FAIL $name $(if ($null -ne $got) { "($got)" })"; $script:failures++ }
}
function Probe([string]$mode) { (node scripts/ci/service-probe.cjs $mode TuneServiceTest) | ConvertFrom-Json }

$dir = Join-Path $env:RUNNER_TEMP 'tune-service-console'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Get-ChildItem -LiteralPath service/bin -File | Where-Object { $_.Name -ne 'ops.ps1' } | Copy-Item -Destination $dir
Set-Content -LiteralPath (Join-Path $dir 'ops.ps1') -Encoding UTF8 -Value @'
param([string]$Request)
# Test stand-in for ops.ps1: every request hangs, after starting a child process that must end too.
$p = Start-Process -FilePath "$env:SystemRoot\System32\PING.EXE" -ArgumentList '-n', '600', '127.0.0.1' -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'child.pid') -Value $p.Id
Start-Sleep -Seconds 600
[Console]::Out.WriteLine('RESULT {"ok":true,"data":"finished"}')
'@
$svc = Start-Process -FilePath (Join-Path $dir 'TuneService.exe') -ArgumentList '--console', '--pipe', 'TuneServiceTest', '--op-seconds', '5' -WindowStyle Hidden -PassThru
try {
  $end = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $end -and -not (Test-Path -LiteralPath '\\.\pipe\TuneServiceTest')) { Start-Sleep -Milliseconds 200 }
  $v = Probe 'version'
  $expected = (Get-Content -LiteralPath electron/privilege/service-manifest.json -Raw | ConvertFrom-Json).version
  Check "the console copy answers version $expected" ($v.ok -and [string]$v.data.version -eq $expected) ($v | ConvertTo-Json -Compress)

  $s = Probe 'silent'
  Check 'a client that says nothing is dropped after about 5 s' ($s.closed -and $s.ms -ge 4000 -and $s.ms -le 9000) ($s | ConvertTo-Json -Compress)
  $p = Probe 'partial'
  Check 'half a request is dropped after about 5 s' ($p.closed -and $p.ms -ge 4000 -and $p.ms -le 9000) ($p | ConvertTo-Json -Compress)

  $h = Probe 'hang'
  Check 'a hung operation is ended at its limit and answered timedOut' ($h.long.code -eq 'timedOut' -and $h.long.ms -ge 4500 -and $h.long.ms -le 15000) ($h.long | ConvertTo-Json -Compress)
  Check 'meanwhile the version request is answered at once' ($h.during.ok -and $h.during.ms -lt 3000) ($h.during | ConvertTo-Json -Compress)
  Check 'meanwhile a second change hears "busy" after about 2 s' ($h.second.code -eq 'busy' -and $h.second.ms -ge 1500 -and $h.second.ms -le 6000) ($h.second | ConvertTo-Json -Compress)
  $childPid = [int](Get-Content -LiteralPath (Join-Path $dir 'child.pid') -ErrorAction SilentlyContinue)
  Start-Sleep -Milliseconds 500
  Check 'the process the operation started was ended with it' ($childPid -gt 0 -and -not (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) $childPid
} finally {
  Stop-Process -Id $svc.Id -Force -ErrorAction SilentlyContinue
}

if ($script:failures) { Write-Output "$script:failures FAILED"; exit 1 }
Write-Output 'ALL PASSED'
