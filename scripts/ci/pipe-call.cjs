// Asks the installed Tune service one read-only question (version or sensors) and prints its answer
// as one JSON line. Anything else is refused here: a CI harness never asks the service to change
// the PC. Exit 0 with the answer, 1 when the service didn't answer, 2 when refused here.
const net = require('node:net');

const op = process.argv[2];
if (!['version', 'sensors'].includes(op)) {
  console.log(JSON.stringify({ ok: false, error: 'refused by the harness: only version and sensors' }));
  process.exit(2);
}
const sock = net.connect('\\\\.\\pipe\\TuneService');
let buf = '';
const done = (line, code) => { console.log(line); sock.destroy(); process.exit(code); };
const timer = setTimeout(() => done(JSON.stringify({ ok: false, error: 'no answer within 20 s' }), 1), 20000);
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(`${JSON.stringify({ op })}\n`));
sock.on('error', (e) => { clearTimeout(timer); done(JSON.stringify({ ok: false, error: String(e.code || e.message) }), 1); });
sock.on('data', (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line || line.startsWith('{"progress"')) continue;
    clearTimeout(timer);
    done(line, 0);
  }
});
