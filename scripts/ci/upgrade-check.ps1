# Upgrading from the published 1.3.1 on a disposable Windows CI runner (audit TUN-12). Its installer
# sets up the old service (version 6, its files directly in Program Files\Tune Service). Two ways on:
# A) an automatic update (the installer run with --updated, as the app's updater runs it) leaves the
#    service as it is, without asking for approval; updating it afterwards (what Settings offers,
#    "Tune.exe --install-service") moves it to this version's own folder and removes the old layout;
# B) running this build's installer over 1.3.1 by hand sets up this version's service directly.
# Either way Tune's data is kept. (Check writes to the output, so the functions here return nothing.) Changes the machine: it runs only on a throwaway CI runner.
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'upgrade-check changes the machine: it runs only on a disposable CI runner' }

$script:failures = 0
function Check([string]$name, [bool]$cond, $got = $null) {
  if ($cond) { Write-Output "PASS $name" } else { Write-Output "FAIL $name $(if ($null -ne $got) { "($got)" })"; $script:failures++ }
}
function Until([scriptblock]$cond, [int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  return [bool](& $cond)
}
function ServicePath { [string](Get-CimInstance Win32_Service -Filter "Name='TuneService'").PathName }

$old = Get-ChildItem -LiteralPath old -Filter 'Tune-Setup-*.exe' | Select-Object -First 1
$new = Get-ChildItem -LiteralPath release -Filter 'Tune-Setup-*.exe' | Select-Object -First 1
if (-not $old -or -not $new) { throw 'both installers are needed (old/ and release/)' }
$svcRoot = Join-Path $env:ProgramFiles 'Tune Service'
$inst = Join-Path $env:LOCALAPPDATA 'Programs\Tune'
$expected = (Get-Content -LiteralPath electron/privilege/service-manifest.json -Raw | ConvertFrom-Json).version

function Install-Old {
  $p = Start-Process -FilePath $old.FullName -ArgumentList '/S' -Wait -PassThru
  Check "1.3.1 installs ($($old.Name))" ($p.ExitCode -eq 0) $p.ExitCode
  $registered = Until { [bool](Get-Service TuneService -ErrorAction SilentlyContinue) } 60
  $script:oldBin = ServicePath
  Check '1.3.1 set up its service the old way (files directly in the folder)' ($registered -and $script:oldBin -like "*$svcRoot\TuneService.exe*") $script:oldBin
  Write-Output "  (the old service is $((Get-Service TuneService -ErrorAction SilentlyContinue).Status))"
}
function Assert-New([string]$how) {
  $running = Until { $s = Get-Service TuneService -ErrorAction SilentlyContinue; $s -and $s.Status -eq 'Running' } 120
  Check "${how}: the service runs" $running ((Get-Service TuneService -ErrorAction SilentlyContinue).Status)
  $bin = ServicePath
  Check "${how}: it runs version $expected from its own version folder" ($bin -like "*$svcRoot\v$expected-*\TuneService.exe*") $bin
  $v = (node scripts/ci/pipe-call.cjs version) | ConvertFrom-Json
  Check "${how}: it answers version $expected" ($v.ok -and [string]$v.data.version -eq $expected) ($v | ConvertTo-Json -Compress)
  $leftover = @(Get-ChildItem -LiteralPath $svcRoot -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'PawnIO_setup.exe' } | ForEach-Object Name)
  Check "${how}: the old layout's files are gone" ($leftover.Count -eq 0) ($leftover -join ', ')
  Check "${how}: Tune's data is kept" (Test-Path -LiteralPath (Join-Path $data 'ci-upgrade-mark.txt'))
}
function Uninstall([string]$how) {
  $p = Start-Process -FilePath (Join-Path $inst 'Uninstall Tune.exe') -ArgumentList '/S' -Wait -PassThru
  Check "${how}: uninstall exits 0" ($p.ExitCode -eq 0) $p.ExitCode
  Check "${how}: the service and its folder are removed" (Until { -not (Get-Service TuneService -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $svcRoot) } 90)
}
$data = Join-Path $env:APPDATA 'Tune'
New-Item -ItemType Directory -Path $data -Force | Out-Null
Set-Content -LiteralPath (Join-Path $data 'ci-upgrade-mark.txt') -Value 'kept'

# A) an automatic update, then the service update Settings offers
Install-Old
$p = Start-Process -FilePath $new.FullName -ArgumentList '/S', '--updated' -Wait -PassThru
Check 'automatic update: the installer exits 0' ($p.ExitCode -eq 0) $p.ExitCode
Check 'automatic update: the service is left as it was (no approval asked)' ((ServicePath) -eq $script:oldBin -and (Test-Path -LiteralPath (Join-Path $svcRoot 'TuneService.exe'))) (ServicePath)
$out = Join-Path $env:RUNNER_TEMP 'upgrade-install.json'
$p = Start-Process -FilePath (Join-Path $inst 'Tune.exe') -ArgumentList '--install-service' -Wait -PassThru -RedirectStandardOutput $out
Check 'automatic update: then Tune.exe --install-service succeeds' ($p.ExitCode -eq 0) "$($p.ExitCode) $(Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue)"
Assert-New 'automatic update'
Uninstall 'automatic update'

# B) this build's installer run over 1.3.1 by hand
Install-Old
$p = Start-Process -FilePath $new.FullName -ArgumentList '/S' -Wait -PassThru
Check 'by hand: this build installs over 1.3.1' ($p.ExitCode -eq 0) $p.ExitCode
Assert-New 'by hand'
Uninstall 'by hand'

if ($script:failures) { Write-Output "$script:failures FAILED"; exit 1 }
Write-Output 'ALL PASSED'
