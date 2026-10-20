# Real Electron safeStorage and the real protected store, across two Windows users.
# Synthetic data only; runs only on a disposable runner, never a user's profile.
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'DPAPI user check runs only on a disposable CI runner' }
$root = Join-Path 'C:\Users\Public' ('TuneDpapi-' + [guid]::NewGuid().ToString('N'))
$user = 'tunedpapi'
$pw = 'Tn' + [guid]::NewGuid().ToString('N').Substring(0, 9) + '!a1'
New-Item -ItemType Directory -Path $root | Out-Null
& icacls.exe $root /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE) { throw 'could not grant the test account access to synthetic evidence' }
$created = $false
try {
  & net.exe user $user $pw /add | Out-Null
  if ($LASTEXITCODE) { throw 'could not create disposable DPAPI account' }
  $created = $true
  $cred = New-Object Management.Automation.PSCredential($user, (ConvertTo-SecureString $pw -AsPlainText -Force))
  $exe = (Resolve-Path node_modules/electron/dist/electron.exe).Path
  $probe = (Resolve-Path scripts/ci/dpapi-user-probe.cjs).Path
  $file = Join-Path $root 'license.bin'
  function Probe([string]$mode, $credential) {
    $out = Join-Path $root "$mode.json"
    $options = @{ FilePath = $exe; ArgumentList = @('"' + $probe + '"', $mode, '"' + $file + '"'); WorkingDirectory = $root; RedirectStandardOutput = $out; RedirectStandardError = (Join-Path $root "$mode.stderr"); PassThru = $true; WindowStyle = 'Hidden' }
    if ($credential) { $options.Credential = $credential; $options.LoadUserProfile = $true }
    $p = Start-Process @options
    if (-not $p.WaitForExit(45000)) { $p.Kill(); throw "$mode probe exceeded its deadline" }
    $p.Refresh()
    if ($p.ExitCode -ne 0) { throw "$mode probe failed ($($p.ExitCode)): $(Get-Content (Join-Path $root "$mode.stderr") -Raw -ErrorAction SilentlyContinue)" }
    $r = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
    if (-not $r.ok -or $r.storage -ne 'dpapi') { throw "$mode did not pass with real DPAPI" }
    $r
  }
  $owner = Probe 'owner' $null
  Write-Output 'PASS original Windows user reads a genuinely DPAPI-encrypted synthetic licence'
  $before = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  $other = Probe 'other' $cred
  if (-not $other.unchanged -or $other.reason -ne 'unreadable') { throw 'other account did not preserve unreadable evidence' }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $before) { throw 'licence evidence changed' }
  Write-Output 'PASS a real second Windows user cannot decrypt it; original bytes preserved'
  Write-Output 'ALL PASSED'
} finally {
  if ($created) { & net.exe user $user /delete | Out-Null }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
