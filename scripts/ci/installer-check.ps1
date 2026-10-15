# The packaged installer on a disposable Windows CI runner: silent install (which sets up the
# background service with the runner's administrator rights), the service answering the read-only
# version request from Program Files, then silent uninstall removing Tune and the service.
# This changes the machine: it runs only on a throwaway CI runner, never on a real PC.
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'installer-check changes the machine: it runs only on a disposable CI runner' }

$script:failures = 0
function Check([string]$name, [bool]$cond, $got = $null) {
  if ($cond) { Write-Output "PASS $name" } else { Write-Output "FAIL $name $(if ($null -ne $got) { "($got)" })"; $script:failures++ }
}
function Until([scriptblock]$cond, [int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  return [bool](& $cond)
}

$setup = Get-ChildItem -LiteralPath release -Filter 'Tune-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw 'no installer in release/' }
$inst = Join-Path $env:LOCALAPPDATA 'Programs\Tune'
$svcDir = Join-Path $env:ProgramFiles 'Tune Service'

# 1) install
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
Check 'install: the installer exits 0' ($p.ExitCode -eq 0) $p.ExitCode
Check 'install: Tune.exe in the per-user folder' (Test-Path -LiteralPath (Join-Path $inst 'Tune.exe'))
$running = Until { $s = Get-Service TuneService -ErrorAction SilentlyContinue; $s -and $s.Status -eq 'Running' } 60
Check 'install: the background service is installed and running' $running ((Get-Service TuneService -ErrorAction SilentlyContinue).Status)
Check 'install: the service runs from Program Files' (Test-Path -LiteralPath (Join-Path $svcDir 'TuneService.exe'))
$bin = (Get-CimInstance Win32_Service -Filter "Name='TuneService'").PathName
Check 'install: the registered service path is the Program Files copy' ($bin -like "*$svcDir*") $bin
$acct = (Get-CimInstance Win32_Service -Filter "Name='TuneService'").StartName
Check 'install: it runs as LocalSystem' ($acct -eq 'LocalSystem') $acct

# 2) the service answers (read-only request)
$answer = node scripts/ci/pipe-call.cjs version
$v = $answer | ConvertFrom-Json
Check 'service: answers the version request' ($v.ok -and $v.data.version) $answer
$expected = (Select-String -LiteralPath electron/privilege/service.cjs -Pattern "SERVICE_VERSION = '(\d+)'").Matches[0].Groups[1].Value
Check "service: version $expected, the one the app expects" ($v.data.version -eq $expected) $v.data.version

# 3) uninstall (the NSIS uninstaller hands over to a copy of itself: wait for its effects)
$p = Start-Process -FilePath (Join-Path $inst 'Uninstall Tune.exe') -ArgumentList '/S' -Wait -PassThru
Check 'uninstall: the uninstaller exits 0' ($p.ExitCode -eq 0) $p.ExitCode
$gone = Until { -not (Get-Service TuneService -ErrorAction SilentlyContinue) } 90
Check 'uninstall: the service is removed' $gone
$files = Until { -not (Test-Path -LiteralPath $svcDir) -and -not (Test-Path -LiteralPath (Join-Path $inst 'Tune.exe')) } 90
Check 'uninstall: Tune and the service folder are removed' $files

if ($script:failures) { Write-Output "$script:failures FAILED"; exit 1 }
Write-Output 'ALL PASSED'
