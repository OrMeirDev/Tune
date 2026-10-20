// Everything Tune asks of Windows goes through PowerShell scripts that print JSON.
// Read-only work runs as the user; anything that needs admin rights goes through the admin
// session further down (one UAC prompt covers the next 10 minutes; never at startup).
// The work is split by responsibility under infra/, domain/, features/ and privilege/ (see AGENTS.md);
// this file keeps the one interface main.cjs uses, so callers (and test harnesses that replace
// `sys.*`) see the same object as before.
const { memChannel, ratedFromPart, advise } = require('./domain/recommendation-policy.cjs');
const { biosCheck, downloadBios } = require('./features/bios.cjs');
const { junkScan, junkClean } = require('./features/cleanup.cjs');
const { driverUpdates, installDrivers, enableDevice } = require('./features/drivers.cjs');
const { gpuVendorCheck, downloadGpuInstaller } = require('./features/gpu-drivers.cjs');
const { scanHardware } = require('./features/hardware.cjs');
const { diskFree, restMeasure, bootInfo } = require('./features/measurements.cjs');
const { recommendations, applyRecommendation } = require('./features/recommendations.cjs');
const { createRestorePoint, openSystemRestore } = require('./features/restore.cjs');
const { performance, sensors } = require('./features/sensors.cjs');
const { startupList, startupToggle } = require('./features/startup.cjs');
const { adminStatus, adminStart, adminStop } = require('./privilege/admin-session.cjs');
const { setOperationStore, operationHistory, operationHistoryView, serviceStatus, installService, uninstallService, serviceOpsScript, SERVICE_VERSION } = require('./privilege/service.cjs');

module.exports = {
  scanHardware, driverUpdates, gpuVendorCheck, downloadGpuInstaller, installDrivers, enableDevice,
  biosCheck, downloadBios,
  junkScan, junkClean, startupList, startupToggle, performance, sensors, recommendations, applyRecommendation,
  diskFree, restMeasure, bootInfo,
  memChannel, ratedFromPart, advise,
  createRestorePoint, openSystemRestore, adminStatus, adminStart, adminStop,
  setOperationStore, operationHistory, operationHistoryView, serviceStatus, installService, uninstallService, serviceOpsScript, SERVICE_VERSION,
};
