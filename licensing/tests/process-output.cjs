// 'exit' can precede the last stdout chunk on Windows. 'close' is the point at which all
// output streams have drained. Retain that output instead of declaring a successful child mute.
const { spawn } = require('node:child_process');
function observeChild(child, isReady, timeoutMs = 60000) {
  child.lines = []; child.outputClosed = false; child.outputError = '';
  child.stderr.on('data', d => { child.outputError += String(d); });
  child.exited = new Promise(resolve => child.once('close', resolve));
  return new Promise((resolve, reject) => {
    let buf = '', ready = false;
    const timer = setTimeout(() => { reject(new Error('child did not become ready before deadline')); child.kill(); }, timeoutMs);
    child.stdout.on('data', d => {
      buf += d;
      for (let at; (at = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, at).replace(/\r$/, ''); buf = buf.slice(at + 1);
        if (!ready && isReady(line)) { ready = true; child.readyLine = line; clearTimeout(timer); resolve(child); }
        else { child.lines.push(line); child.emit('tune-output'); }
      }
    });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); child.outputClosed = true; child.outputExit = { code, signal };
      if (!ready) reject(new Error('child closed before ready: ' + code + ' ' + child.outputError));
      child.emit('tune-output');
    });
  });
}
function startChild(file, env, isReady) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, NODE_NO_WARNINGS: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  return observeChild(child, isReady);
}
function nextLine(child) {
  const timeoutMs = 60000; // safe as Array.map callback: its index is not a timeout
  return new Promise((resolve, reject) => {
    const finish = (err, line) => { clearTimeout(timer); child.removeListener('tune-output', read); err ? reject(err) : resolve(line); };
    const read = () => {
      if (child.lines.length) return finish(null, child.lines.shift());
      if (child.outputClosed) finish(new Error('child closed without answering: ' + JSON.stringify(child.outputExit) + ' ' + child.outputError.slice(0, 2000)));
    };
    const timer = setTimeout(() => finish(new Error('child output deadline')), timeoutMs);
    child.on('tune-output', read); read();
  });
}
module.exports = { startChild, nextLine, observeChild };
