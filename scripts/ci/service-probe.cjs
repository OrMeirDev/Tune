// Probes the Tune service's pipe on a disposable Windows CI runner and prints one JSON line.
// Only requests that change nothing are sent:
//   version            the read-only version request
//   noop-change        { op: 'clean', keys: [] }: a change request that cleans no category, so it
//                      changes nothing even when allowed; the answer shows whether it was allowed
//   silent / partial   connect and send nothing, or half a request: how long until the service hangs up
//   hang               { op: 'hags' } only to a console test copy (never TuneService), whose ops.ps1
//                      is a test script that hangs; plus, while it runs, a version request and a
//                      second change (should hear "busy")
// Usage: node service-probe.cjs <mode> [pipe name, default TuneService]
const net = require('node:net');

const [mode, pipe = 'TuneService'] = process.argv.slice(2);
const path = `\\\\.\\pipe\\${pipe}`;
const print = (o) => { console.log(JSON.stringify(o)); };

function ask(req, { raw, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let buf = '';
    let done = false;
    const sock = net.connect(path);
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve({ ...v, ms: Date.now() - started }); } };
    const timer = setTimeout(() => finish({ ok: false, error: 'no answer from the probe deadline' }), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => { if (raw !== undefined) { if (raw) sock.write(raw); } else sock.write(`${JSON.stringify(req)}\n`); });
    sock.on('error', (e) => finish({ ok: false, error: String(e.code || e.message), closed: true }));
    sock.on('close', () => finish({ ok: false, closed: true }));
    sock.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line || line.startsWith('{"progress"')) continue;
        try { finish(JSON.parse(line)); } catch { finish({ ok: false, error: `not JSON: ${line.slice(0, 80)}` }); }
      }
    });
  });
}

(async () => {
  if (mode === 'version') return print(await ask({ op: 'version' }));
  if (mode === 'noop-change') return print(await ask({ op: 'clean', keys: [] }, { timeoutMs: 60000 }));
  if (mode === 'silent') return print(await ask(null, { raw: '', timeoutMs: 20000 }));
  if (mode === 'partial') return print(await ask(null, { raw: '{"op":"vers', timeoutMs: 20000 }));
  if (mode === 'hang') {
    if (pipe === 'TuneService') { print({ ok: false, error: 'hang is only for a console test copy' }); process.exit(2); }
    const long = ask({ op: 'hags' }, { timeoutMs: 60000 });
    await new Promise((r) => setTimeout(r, 1500));
    const during = await ask({ op: 'version' }, { timeoutMs: 10000 });
    const second = await ask({ op: 'clean', keys: [] }, { timeoutMs: 10000 });
    return print({ long: await long, during, second });
  }
  print({ ok: false, error: `unknown mode ${mode}` });
  process.exit(2);
})();
