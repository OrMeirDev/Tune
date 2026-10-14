// Driver updates offered by Windows Update, installing them, and enabling a disabled device.
const { runPS } = require('../infra/powershell.cjs');
const { privileged } = require('../privilege/service.cjs');

// Windows Update's driver catalog: drivers manufacturers publish to Microsoft, already matched to
// this PC's exact hardware IDs by Windows itself.
const driverUpdates = () => runPS(`
$s = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher(); $s.ServerSelection = 2
$r = $s.Search("IsInstalled=0 and Type='Driver'")
$result = @(foreach ($u in $r.Updates) { @{
  id = $u.Identity.UpdateID; title = $u.Title; model = $u.DriverModel; maker = $u.DriverManufacturer; cls = $u.DriverClass
  hwid = $u.DriverHardwareID; date = $(if ($u.DriverVerDate) { $u.DriverVerDate.ToString('yyyy-MM-dd') } else { $null })
  size = [int64]$u.MaxDownloadSize; reboot = [bool]$u.InstallationBehavior.RebootBehavior } })`, { timeoutMs: 5 * 60 * 1000 });

const installDrivers = (ids, onProgress) => privileged({ op: 'drivers', ids }, { timeoutMs: 30 * 60 * 1000, onProgress });

const enableDevice = (id) => privileged({ op: 'enable', id: String(id) });

module.exports = { driverUpdates, installDrivers, enableDevice };
