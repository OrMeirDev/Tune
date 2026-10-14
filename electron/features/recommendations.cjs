// Reading the settings the recommendations are judged on, and applying the ones Tune can change.
const { advise } = require('../domain/recommendation-policy.cjs');
const { runPS } = require('../infra/powershell.cjs');
const { privileged } = require('../privilege/service.cjs');

const recommendations = async () => {
  const r = await runPS(`
$scheme = [string](powercfg /getactivescheme)
$planGuid = ([regex]::Match($scheme, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')).Value
$plan = ([regex]::Match($scheme, '\\(([^)]*)\\)\\s*$')).Groups[1].Value
$laptop = [bool](Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
$gm = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\GameBar' -ErrorAction SilentlyContinue).AutoGameModeEnabled
$hags = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -ErrorAction SilentlyContinue).HwSchMode
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
$bios = Get-CimInstance Win32_BIOS; $bb = Get-CimInstance Win32_BaseBoard
$freeGB = [math]::Round((Get-PSDrive C).Free / 1GB); $sizeGB = [math]::Round(((Get-PSDrive C).Used + (Get-PSDrive C).Free) / 1GB)
# Memory sticks as the board describes them (slot names, rated and current speed, part number).
$mods = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{ locator = [string]$_.DeviceLocator; bank = [string]$_.BankLabel; speed = [int]$_.Speed; configured = [int]$_.ConfiguredClockSpeed; part = ([string]$_.PartNumber).Trim(); type = [int]$_.SMBIOSMemoryType; gb = [math]::Round($_.Capacity / 1GB) } })
$slots = [int](Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object MemoryDevices -Sum).Sum
# The microcode Windows loaded (Intel's fixes arrive in it); 4 or 8 bytes depending on the system.
$ucode = $null
try { $u = (Get-ItemProperty 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0').'Update Revision'; if ($u) { $ucode = if ($u.Length -ge 8) { [BitConverter]::ToUInt32($u, 4) } else { [BitConverter]::ToUInt32($u, 0) } } } catch {}
$ssd = [bool](Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.MediaType -eq 'SSD' })
$trim = $null
$tq = (fsutil behavior query DisableDeleteNotify 2>$null) | Out-String
$tm = [regex]::Match($tq, 'NTFS DisableDeleteNotify\\s*=\\s*(\\d)'); if ($tm.Success) { $trim = ($tm.Groups[1].Value -eq '0') }
# Plain data only; the app words it in the user's language and judges it (advise).
$result = @(
  @{ key = 'power'; value = $plan; guid = $planGuid; cpu = $cpu; laptop = $laptop }
  @{ key = 'microcode'; cpu = $cpu; rev = $ucode; laptop = $laptop }
  @{ key = 'gamemode'; on = ($gm -ne 0); ok = ($gm -ne 0); action = $(if ($gm -eq 0) { 'gamemode' } else { $null }) }
  @{ key = 'hags'; on = ($hags -eq 2); ok = ($hags -eq 2); action = $(if ($hags -eq 2) { $null } else { 'hags' }) }
  @{ key = 'disk'; freeGB = $freeGB; sizeGB = $sizeGB; ok = ($freeGB -gt 0.1 * $sizeGB); action = $null }
  @{ key = 'trim'; ssd = $ssd; on = $trim }
  @{ key = 'memory'; modules = $mods; slots = $slots; cpu = $cpu; laptop = $laptop; boardMaker = [string]$bb.Manufacturer; boardModel = [string]$bb.Product }
  @{ key = 'bios'; version = $bios.SMBIOSBIOSVersion; date = $bios.ReleaseDate.ToString('yyyy-MM-dd'); ok = $null
     intel1314 = ($cpu -match 'i[579]-1[34]\\d{3}')
     action = 'biosPage'; link = "https://www.google.com/search?q=$([uri]::EscapeDataString("$($bb.Manufacturer) $($bb.Product) BIOS"))" }
)`);
  if (r.ok) r.data = advise([].concat(r.data || []));
  return r;
};

const applyRecommendation = (key) => {
  const scripts = {
    // Windows' built-in Balanced plan, by its fixed ID (exists on every Windows).
    power: { body: "powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e; $result = 'ok'" },
    gamemode: { body: "New-Item 'HKCU:\\Software\\Microsoft\\GameBar' -Force | Out-Null; Set-ItemProperty 'HKCU:\\Software\\Microsoft\\GameBar' -Name AutoGameModeEnabled -Value 1 -Type DWord; $result = 'ok'" },
  };
  if (key === 'hags') return privileged({ op: 'hags' });
  const s = scripts[key];
  return s ? runPS(s.body) : Promise.resolve({ ok: false, error: 'unknown' });
};

module.exports = { recommendations, applyRecommendation };
