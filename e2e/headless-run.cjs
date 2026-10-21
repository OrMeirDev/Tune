// Linux hosts without a desktop or single-instance sockets. Never loaded by the product.
// Pass Chromium's headless flags to Electron, then this runner and one e2e/*.cjs entry point.
const path = require('path');
const { app } = require('electron');
const target = path.resolve(process.argv.at(-1));
if (path.dirname(target) !== __dirname || target === __filename) {
  throw new Error('Pass an e2e entry point after headless-run.cjs');
}
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
require(target);
