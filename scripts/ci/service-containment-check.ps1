# WIN-R02 on a disposable Windows CI runner: an operation of the background service runs only inside its
# job object, and its end is confirmed before another change starts. Against console copies of a test
# build of the service with fault injection (scripts/build-service.cjs --test-faults, never shipped),
# each on its own pipe with a 5 s operation limit, and a test ops.ps1 that records that it ran, at once
# starts a child process (PING) and hangs. Nothing is installed.
# - Windows refusing to create or configure the job, to put the process in it, or to let it run: the
#   change is refused ("containmentFailed"), the operation never ran, and no process of it is left
# - the job assignment delayed 3 s: the process waits suspended, so the child it starts at once is in
#   the job and ends with it at the limit
# - a termination Windows refuses: "timedOut" with stopped false, the processes really still run, the
#   next change hears "busy"; once they are gone the next change runs again
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'runs only on a disposable CI runner' }

$script:failures = 0
function Check([string]$name, [bool]$cond, $got = $null) {
  if ($cond) { Write-Output "PASS $name" } else { Write-Output "FAIL $name $(if ($null -ne $got) { "($got)" })"; $script:failures++ }
}
$dir = Join-Path $env:RUNNER_TEMP 'tune-service-faults'
node scripts/build-service.cjs --test-faults $dir
if ($LASTEXITCODE) { throw 'could not build the fault-injection test copy' }
Set-Content -LiteralPath (Join-Path $dir 'ops.ps1') -Encoding UTF8 -Value @'
param([string]$Request)
# Test stand-in for ops.ps1: records that it ran, at once starts a child process, then hangs.
Add-Content -LiteralPath (Join-Path $PSScriptRoot 'ran.txt') -Value (Get-Date -Format o)
$p = Start-Process -FilePath "$env:SystemRoot\System32\PING.EXE" -ArgumentList '-n', '600', '127.0.0.1' -WindowStyle Hidden -PassThru
Add-Content -LiteralPath (Join-Path $PSScriptRoot 'child.pids') -Value $p.Id
Start-Sleep -Seconds 600
[Console]::Out.WriteLine('RESULT {"ok":true,"data":"finished"}')
'@
$ran = Join-Path $dir 'ran.txt'
$pids = Join-Path $dir 'child.pids'
function Runs { if (Test-Path -LiteralPath $ran) { @(Get-Content -LiteralPath $ran).Count } else { 0 } }
function Children { if (Test-Path -LiteralPath $pids) { @(Get-Content -LiteralPath $pids | ForEach-Object { [int]$_ }) } else { @() } }
function Alive([int[]]$ids) { @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }) }
# the test ops.ps1's own PowerShell processes (started by the service with this folder on the command line)
function OpsShells { @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*$dir*ops.ps1*" } | ForEach-Object { [int]$_.ProcessId }) }
# every process started under these (their console hosts included), deepest first
function Tree([int[]]$roots) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
  $found = @(); $next = @($roots)
  while ($next.Count) { $kids = @($all | Where-Object { $next -contains [int]$_.ParentProcessId -and $found -notcontains [int]$_.ProcessId }); $found += @($kids | ForEach-Object { [int]$_.ProcessId }); $next = @($kids | ForEach-Object { [int]$_.ProcessId }) }
  [array]::Reverse($found); @($found) + @($roots)
}
function Names([int[]]$ids) { (@($ids | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { "$($p.ProcessName)($_)" } }) -join ', ') }
function Probe([string]$mode, [string]$pipe) { (node scripts/ci/service-probe.cjs $mode $pipe) | ConvertFrom-Json }
function Start-Copy([string]$fault) {
  $pipe = "TuneFault-$fault"
  $p = Start-Process -FilePath (Join-Path $dir 'TuneService.exe') -ArgumentList '--console', '--pipe', $pipe, '--op-seconds', '5', '--fault', $fault -WindowStyle Hidden -PassThru
  $end = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $end -and -not (Test-Path -LiteralPath "\\.\pipe\$pipe")) { Start-Sleep -Milliseconds 200 }
  [pscustomobject]@{ process = $p; pipe = $pipe }
}
function Stop-Copy($c) {
  Stop-Process -Id $c.process.Id -Force -ErrorAction SilentlyContinue
  foreach ($id in (Tree (@(OpsShells) + @(Children)))) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $ran, $pids -Force -ErrorAction SilentlyContinue
}

# 1) containment can't be established: nothing of the operation runs
foreach ($fault in 'create-job', 'configure-job', 'assign', 'resume') {
  $c = Start-Copy $fault
  try {
    $r = Probe 'change' $c.pipe
    Start-Sleep -Milliseconds 1500
    Check "${fault}: the change is refused (containmentFailed), saying why" ($r.ok -eq $false -and $r.code -eq 'containmentFailed' -and $r.error -match 'not started') ($r | ConvertTo-Json -Compress)
    Check "${fault}: the operation never ran (nothing recorded, no child)" ((Runs) -eq 0 -and (Children).Count -eq 0) "runs $(Runs), children $((Children).Count)"
    Check "${fault}: no process of it is left" ((OpsShells).Count -eq 0) ((OpsShells) -join ',')
    $v = Probe 'version' $c.pipe
    Check "${fault}: the service still answers" ($v.ok) ($v | ConvertTo-Json -Compress)
  } finally { Stop-Copy $c }
}

# 2) a child started at once is in the job: the assignment is delayed 3 s while the process waits
#    suspended (without suspension it would have started its child outside the job by then)
$c = Start-Copy 'delay-assign'
try {
  $r = Probe 'change' $c.pipe
  $kids = Children
  Start-Sleep -Milliseconds 500
  Check 'delayed assignment: the operation ran, past its limit, and was stopped (timedOut)' ($r.code -eq 'timedOut' -and $r.stopped -ne $false -and (Runs) -eq 1) ($r | ConvertTo-Json -Compress)
  Check 'delayed assignment: the child it started at once ended with it' ($kids.Count -eq 1 -and (Alive $kids).Count -eq 0) ($kids -join ',')
  Check 'delayed assignment: no process of it is left' ((OpsShells).Count -eq 0) ((OpsShells) -join ',')
} finally { Stop-Copy $c }

# 3) Windows refuses to end it: not claimed as stopped, and no other change starts until it is gone
$c = Start-Copy 'terminate'
try {
  $r = Probe 'change' $c.pipe
  $kids = Children
  $shells = OpsShells
  Check 'refused termination: answered timedOut with stopped false' ($r.code -eq 'timedOut' -and $r.stopped -eq $false) ($r | ConvertTo-Json -Compress)
  Check 'refused termination: its processes really still run (nothing was claimed)' ((Alive $kids).Count -eq 1 -and $shells.Count -eq 1) "children $((Alive $kids).Count), shells $($shells.Count)"
  $b = Probe 'change' $c.pipe
  Check 'refused termination: the next change hears busy, and does not run' ($b.code -eq 'busy' -and $b.error -match 'not been confirmed' -and (Runs) -eq 1) ($b | ConvertTo-Json -Compress)
  $v = Probe 'version' $c.pipe
  Check 'refused termination: read-only requests are still answered' ($v.ok -and $v.ms -lt 3000) ($v | ConvertTo-Json -Compress)
  # what Windows refused to end is ended here instead: every process of the operation, console hosts too
  $tree = Tree ($shells + $kids)
  foreach ($id in $tree) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  $end = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $end -and (Alive $tree).Count) { Start-Sleep -Milliseconds 200 }
  Check 'refused termination: the test ended every process of it itself' ((Alive $tree).Count -eq 0) (Names (Alive $tree))
  $again = Probe 'change' $c.pipe
  Check 'once its processes are gone, the next change runs again' ((Runs) -eq 2 -and $again.code -eq 'timedOut') "$($again | ConvertTo-Json -Compress) left: $(Names (Alive $tree))"
} finally { Stop-Copy $c }

if ($script:failures) { Write-Output "$script:failures FAILED"; exit 1 }
Write-Output 'ALL PASSED'
