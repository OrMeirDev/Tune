# The packaged installer and the background service on a disposable Windows CI runner. Changes the
# machine: it runs only on a throwaway CI runner, never on a real PC.
# 1) silent install: Tune per user, the service as LocalSystem in its own protected folder in Program
#    Files, every file there matching the manifest built with this version, answering version
# 2) a service file changed in the per-user install folder is refused; the running service is untouched
#    (audit TUN-02)
# 1b, 1c) who may ask the service for a change (TUN-01); a standard user reaches the elevated helper
#    that Windows' prompt starts for it as an administrator
# 3) an update installs side by side and keeps the previous version; one whose service never starts
#    is rolled back (audit TUN-12, scripts/ci/service-update-check.cjs)
# 4) silent uninstall removes Tune and the service
# When the service isn't running, Windows' own record of why is printed.
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
function Diagnose {
  Write-Output '--- why: Service Control Manager (latest first)'
  Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager' } -MaxEvents 8 -ErrorAction SilentlyContinue |
    ForEach-Object { "  $($_.TimeCreated.ToString('s')) [$($_.Id)] $(($_.Message -replace '\s+', ' ').Substring(0, [Math]::Min(220, $_.Message.Length)))" }
  Write-Output '--- why: application errors (latest first)'
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 2 } -MaxEvents 4 -ErrorAction SilentlyContinue |
    ForEach-Object { "  $($_.TimeCreated.ToString('s')) $($_.ProviderName): $(($_.Message -replace '\s+', ' ').Substring(0, [Math]::Min(300, $_.Message.Length)))" }
}
# "Tune.exe --install-service", as the installer runs it: its exit code and its result (JSON).
function Install-ViaTune {
  $out = Join-Path $env:RUNNER_TEMP ("install-" + [guid]::NewGuid() + '.json')
  $p = Start-Process -FilePath (Join-Path $inst 'Tune.exe') -ArgumentList '--install-service' -Wait -PassThru -RedirectStandardOutput $out
  $text = (Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue)
  [pscustomobject]@{ code = $p.ExitCode; text = "$text".Trim(); result = $(try { $text | ConvertFrom-Json } catch { $null }) }
}
function ServicePath { [string](Get-CimInstance Win32_Service -Filter "Name='TuneService'").PathName }
function Folders { @(Get-ChildItem -LiteralPath $svcRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object Name | Sort-Object) }
function Version { (node scripts/ci/pipe-call.cjs version) | ConvertFrom-Json }
# Allow entries that let anyone but administrators, SYSTEM or TrustedInstaller change the folder.
function Writers([string]$path) {
  $write = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
  @((Get-Acl -LiteralPath $path).Access | Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $write) } | ForEach-Object {
    try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$_.IdentityReference }
  } | Where-Object { $_ -notin @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') })
}

$setup = Get-ChildItem -LiteralPath release -Filter 'Tune-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw 'no installer in release/' }
$inst = Join-Path $env:LOCALAPPDATA 'Programs\Tune'
$svcRoot = Join-Path $env:ProgramFiles 'Tune Service'
$manifest = Get-Content -LiteralPath electron/privilege/service-manifest.json -Raw | ConvertFrom-Json
$expected = [string]$manifest.version

# 1) install
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
Check 'install: the installer exits 0' ($p.ExitCode -eq 0) $p.ExitCode
Check 'install: Tune.exe in the per-user folder' (Test-Path -LiteralPath (Join-Path $inst 'Tune.exe'))
$running = Until { $s = Get-Service TuneService -ErrorAction SilentlyContinue; $s -and $s.Status -eq 'Running' } 90
Check 'install: the background service is installed and running' $running ((Get-Service TuneService -ErrorAction SilentlyContinue).Status)
if (-not $running) {
  Diagnose
  $again = Install-ViaTune
  Write-Output "--- why: Tune.exe --install-service exited $($again.code): $($again.text)"
}
$bin = ServicePath
Check "install: it runs from its own version folder in Program Files ($expected)" ($bin -like "*$svcRoot\v$expected-*\TuneService.exe*") $bin
Check 'install: as LocalSystem' ((Get-CimInstance Win32_Service -Filter "Name='TuneService'").StartName -eq 'LocalSystem')
$folder = (Folders) | Where-Object { $bin -like "*\$_\*" } | Select-Object -First 1
$current = if ($folder) { Join-Path $svcRoot $folder } else { $null }
Check 'install: the version folder exists' ([bool]$current) ((Folders) -join ', ')
if ($current) {
  $writers = @(Writers $svcRoot) + @(Writers $current)
  Check 'install: only administrators and SYSTEM can change the service folders' ($writers.Count -eq 0) ($writers -join ', ')
  $mismatch = @($manifest.files.PSObject.Properties | Where-Object { -not (Test-Path -LiteralPath (Join-Path $current $_.Name)) -or (Get-FileHash -LiteralPath (Join-Path $current $_.Name) -Algorithm SHA256).Hash -ne $_.Value } | ForEach-Object Name)
  Check 'install: every file in the service folder matches the manifest built with this version' ($mismatch.Count -eq 0) ($mismatch -join ', ')
}
$v = Version
Check "service: answers the version request with $expected" ($v.ok -and [string]$v.data.version -eq $expected) ($v | ConvertTo-Json -Compress)
if ($env:TUNE_CI_SIGNER -and $current) {
  $sig = Get-AuthenticodeSignature -LiteralPath (Join-Path $current 'TuneService.exe')
  Check 'TUN-09: the installed service carries a valid signature from the build certificate' ($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Thumbprint -eq $env:TUNE_CI_SIGNER) "$($sig.Status) $($sig.SignerCertificate.Thumbprint)"
}

# 1b) who may ask the installed service for a change (TUN-01): an administrator yes, a standard user
#     no ("notAllowed"); both may ask the read-only version. The change asked for cleans no category,
#     so it changes nothing even where it is allowed (scripts/ci/service-probe.cjs).
$admin = (node scripts/ci/service-probe.cjs noop-change) | ConvertFrom-Json
Check 'TUN-01: an administrator may ask for a change' ($admin.ok -and [int64]$admin.data.freed -eq 0) ($admin | ConvertTo-Json -Compress)
$journal = Join-Path $svcRoot 'journal'
Check 'journal: created under the protected service root' (Test-Path -LiteralPath $journal -PathType Container)
if (Test-Path -LiteralPath $journal) {
  $journalWriters = @(Writers $journal)
  Check 'journal: only administrators and SYSTEM can change recorded results' ($journalWriters.Count -eq 0) ($journalWriters -join ', ')
}
$user = 'tunestd'
# 14 characters: net.exe asks for confirmation (and gets none in CI) above that
$pw = 'Tn' + [guid]::NewGuid().ToString('N').Substring(0, 9) + '!a1'
& net.exe user $user $pw /add | Out-Null
if ($LASTEXITCODE) { throw "could not create the standard user (net user exited $LASTEXITCODE)" }
try {
  $probe = 'C:\Users\Public\tune-service-probe.cjs'
  Copy-Item -LiteralPath scripts/ci/service-probe.cjs -Destination $probe -Force
  $cred = New-Object Management.Automation.PSCredential($user, (ConvertTo-SecureString $pw -AsPlainText -Force))
  $node = (Get-Command node).Source
  function As-Standard([string]$mode, [string]$pipe = 'TuneService') {
    $out = "C:\Users\Public\tune-probe-$mode.json"
    Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue
    Start-Process -FilePath $node -ArgumentList $probe, $mode, $pipe -Credential $cred -LoadUserProfile -WorkingDirectory 'C:\Users\Public' -RedirectStandardOutput $out -Wait -WindowStyle Hidden | Out-Null
    (Get-Content -LiteralPath $out -Raw) | ConvertFrom-Json
  }
  $adminsGroup = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
  $isAdmin = @(& net.exe localgroup $adminsGroup) -contains $user
  Check 'TUN-01: the second account is a standard user' (-not $isAdmin)
  $sv = As-Standard 'version'
  Check 'TUN-01: a standard user may ask the read-only version' ($sv.ok -and [string]$sv.data.version -eq $expected) ($sv | ConvertTo-Json -Compress)
  $sc = As-Standard 'noop-change'
  Check 'TUN-01: a standard user may not ask for a change (notAllowed)' ($sc.ok -eq $false -and $sc.code -eq 'notAllowed') ($sc | ConvertTo-Json -Compress)

  # 1c) so a standard user's change goes through Windows' prompt, where an administrator signs in and
  #     the elevated helper runs as that administrator's account: its pipe must admit the standard
  #     user's account, which Tune names (privilege/elevated.cjs). Two helpers started here, elevated
  #     as the runner's administrator: one naming the standard user, one naming nobody.
  $stdSid = (New-Object Security.Principal.NTAccount($user)).Translate([Security.Principal.SecurityIdentifier]).Value
  $named = 'TuneAdmin-ci' + [guid]::NewGuid().ToString('N')
  $plain = 'TuneAdmin-ci' + [guid]::NewGuid().ToString('N')
  try {
    $h1 = (node scripts/ci/admin-helper.cjs start $named $PID $stdSid) | ConvertFrom-Json
    $h2 = (node scripts/ci/admin-helper.cjs start $plain $PID none) | ConvertFrom-Json
    Check 'over the shoulder: two elevated helpers start' ($h1.ok -and $h2.ok) "$($h1 | ConvertTo-Json -Compress) $($h2 | ConvertTo-Json -Compress)"
    $s1 = As-Standard 'status' $named
    Check "over the shoulder: the standard user reaches the helper that names its account" ($s1.ok -and [int64]$s1.data.until -gt 0) ($s1 | ConvertTo-Json -Compress)
    $s2 = As-Standard 'status' $plain
    Check "over the shoulder: and not one that names nobody (the pipe is the administrator's)" ($s2.ok -eq $false -and $s2.error -match 'EPERM|EACCES') ($s2 | ConvertTo-Json -Compress)
  } finally {
    node scripts/ci/admin-helper.cjs stop $named | Out-Null
    node scripts/ci/admin-helper.cjs stop $plain | Out-Null
  }
} finally {
  & net.exe user $user /delete | Out-Null
}

# 2) a changed file in the per-user bundle is refused, and the running service is left alone (TUN-02)
$bundle = Join-Path $inst 'resources\service'
$ops = Join-Path $bundle 'ops.ps1'
$original = [IO.File]::ReadAllBytes($ops)
Add-Content -LiteralPath $ops -Value '# changed after the build'
$before = Folders
$r = Install-ViaTune
Check 'tampered bundle: Tune.exe --install-service fails' ($r.code -ne 0) $r.code
Check 'tampered bundle: it says the file does not match and nothing was changed' ($r.text -match 'ops\.ps1 does not match this version of Tune; nothing was changed') $r.text
Check 'tampered bundle: the service still runs the same version folder' ((ServicePath) -eq $bin) (ServicePath)
Check 'tampered bundle: no new folder was left' (((Folders) -join ',') -eq ($before -join ',')) ((Folders) -join ',')
$v = Version
Check 'tampered bundle: the service still answers' ($v.ok -and [string]$v.data.version -eq $expected)
[IO.File]::WriteAllBytes($ops, $original)

# 3) an update: side by side, the previous version kept; then one that never starts is rolled back
$r = Install-ViaTune
Check 'update: Tune.exe --install-service succeeds' ($r.code -eq 0 -and $r.result.ok) $r.text
$newBin = ServicePath
Check 'update: the service moved to a new version folder' ($newBin -ne $bin -and $newBin -like "*$svcRoot\v$expected-*") $newBin
Check 'update: the previous version folder is kept for one more update' (Test-Path -LiteralPath $current)
$v = Version
Check 'update: the new version answers' ($v.ok -and [string]$v.data.version -eq $expected)
node scripts/ci/service-update-check.cjs $bundle
Check 'update: a version that never starts is rolled back (service-update-check)' ($LASTEXITCODE -eq 0) $LASTEXITCODE

# 4) uninstall (the NSIS uninstaller hands over to a copy of itself: wait for its effects)
$p = Start-Process -FilePath (Join-Path $inst 'Uninstall Tune.exe') -ArgumentList '/S' -Wait -PassThru
Check 'uninstall: the uninstaller exits 0' ($p.ExitCode -eq 0) $p.ExitCode
$gone = Until { -not (Get-Service TuneService -ErrorAction SilentlyContinue) } 90
Check 'uninstall: the service is removed' $gone
$files = Until { -not (Test-Path -LiteralPath $svcRoot) -and -not (Test-Path -LiteralPath (Join-Path $inst 'Tune.exe')) } 90
Check 'uninstall: Tune and the service folders are removed' $files

if ($script:failures) { Write-Output "$script:failures FAILED"; exit 1 }
Write-Output 'ALL PASSED'
