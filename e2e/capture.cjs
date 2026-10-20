// Required captures wait for a paint, retry only known compositor failures, and keep diagnostics.
// Exhaustion fails the run while allowing the independent semantic checks after it to finish.
const fs = require('node:fs');
const path = require('node:path');
const transient = e => /UnknownVizError|Current display surface not available for capture/i.test(e?.message || String(e));

function deadline(task, ms) {
  let timer;
  return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`capture timed out after ${ms} ms`)), ms);
  })]).finally(() => clearTimeout(timer));
}
function state(win) {
  if (win.isDestroyed()) return { destroyed: true };
  return { destroyed: false, visible: win.isVisible(), minimized: win.isMinimized(),
    loading: win.webContents.isLoading(), size: win.getContentSize() };
}
async function prepare(win) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('capture window is destroyed');
  if (win.isMinimized()) win.restore();
  win.show();
  win.webContents.invalidate();
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
function createCapture({ win, outDir, run, attempts = 3, timeoutMs = 5000, prepareWindow = prepare }) {
  return async name => {
    if (path.basename(name) !== name || !name.endsWith('.png')) throw new Error('invalid capture filename');
    const diagnostics = [], wc = win.webContents;
    const throttled = !wc.isDestroyed() && wc.getBackgroundThrottling();
    try {
      fs.rmSync(path.join(outDir, name), { force: true }); // never leave an older screenshot as this run's evidence
      if (!wc.isDestroyed()) wc.setBackgroundThrottling(false);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          await deadline(() => prepareWindow(win), timeoutMs);
          const img = await deadline(() => wc.capturePage(undefined, { stayAwake: true }), timeoutMs);
          if (img.isEmpty() || img.getSize().width < 1 || img.getSize().height < 1) throw new Error('capture returned an empty image');
          fs.writeFileSync(path.join(outDir, name), img.toPNG());
          diagnostics.push({ attempt, ok: true, ...state(win), image: img.getSize() });
          return true;
        } catch (e) {
          diagnostics.push({ attempt, ok: false, error: e.message, ...state(win) });
          console.error(`Capture ${name}, attempt ${attempt}: ${e.message}`);
          if (!transient(e) || attempt === attempts) {
            run.fail(`required screenshot ${name}`, e);
            return false;
          }
        }
      }
    } catch (e) {
      run.fail(`required screenshot ${name}`, e);
      return false;
    } finally {
      try {
        if (!wc.isDestroyed()) wc.setBackgroundThrottling(throttled);
        fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(diagnostics, null, 2));
      } catch (e) { run.fail(`screenshot diagnostics ${name}`, e); }
    }
  };
}
module.exports = { createCapture };
