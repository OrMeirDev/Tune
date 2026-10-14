// The hardware scan: the PC, its parts and every device with its driver.
const { runPS } = require('../infra/powershell.cjs');

const scanHardware = () => runPS(`
$cs = Get-CimInstance Win32_ComputerSystem; $bb = Get-CimInstance Win32_BaseBoard; $bios = Get-CimInstance Win32_BIOS
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; driverVersion = $_.DriverVersion; pnp = $_.PNPDeviceID } })
$devices = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -and $_.DriverVersion } | ForEach-Object {
  @{ name = $_.DeviceName; cls = $_.DeviceClass; maker = $_.Manufacturer; provider = $_.DriverProviderName; version = $_.DriverVersion;
     date = $(if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null }); hwid = $_.HardWareID; id = $_.DeviceID } })
$problems = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -ne 0 } | ForEach-Object { @{ name = $_.Name; code = [int]$_.ConfigManagerErrorCode; id = $_.PNPDeviceID } })
# AMD's site names releases by the "AMD Software" package version (26.8.1), not the driver's 32.0.x number.
$amdSw = (Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match '^AMD Software' } | Select-Object -First 1).DisplayVersion
$result = @{
  amdSoftware = $amdSw
  systemMaker = $cs.Manufacturer; systemModel = $cs.Model; systemSku = $cs.SystemSKUNumber
  computer = "$($cs.Manufacturer) $($cs.Model)".Trim(); board = "$($bb.Manufacturer) $($bb.Product)".Trim(); boardMaker = $bb.Manufacturer; boardModel = $bb.Product
  bios = @{ version = $bios.SMBIOSBIOSVersion; date = $bios.ReleaseDate.ToString('yyyy-MM-dd') }
  cpu = $cpu.Name.Trim(); ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB); gpus = $gpus; devices = $devices; problems = $problems
}`);

module.exports = { scanHardware };
