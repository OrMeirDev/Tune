// System restore points.
const { spawn } = require('child_process');
const path = require('path');
const { privileged } = require('../privilege/service.cjs');

// Restore points are system-wide, so Windows only lets an administrator make one. Inside an open
// admin session (for example right after startup switches) it doesn't ask again.
const createRestorePoint = () => privileged({ op: 'restore' }, { timeoutMs: 5 * 60 * 1000 });

function openSystemRestore() {
  spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rstrui.exe'), [], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { createRestorePoint, openSystemRestore };
