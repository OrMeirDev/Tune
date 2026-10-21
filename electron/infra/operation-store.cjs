// Main-owned IDs survive an app restart. Recovery only asks for status; no executable request is stored.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(['drivers', 'enable', 'clean', 'startup', 'hags', 'restore']);
const STATES = new Set(['running', 'completed', 'failed', 'unknown', 'interrupted']);
const uncertain = r => !r || r.code === 'noAnswer' || r.stopped === false;

function createOperationStore({ file, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() }) {
  function read() {
    try {
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('operation index is too large');
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(rows) || rows.length > 500 || rows.some(r => !r || !ID.test(r.id) || !OPS.has(r.op) || !STATES.has(r.state) || !Number.isFinite(Date.parse(r.startedAt)))) throw new Error('invalid operation index');
      return rows;
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  function write(rows) {
    const data = JSON.stringify(rows, null, 2);
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('operation index is too large');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp', fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  function update(id, changes) {
    const rows = read(), found = rows.find(r => r.id === id);
    if (!found) throw new Error('operation is not in the local index');
    Object.assign(found, changes); write(rows);
  }
  return {
    begin(req) {
      if (!OPS.has(req.op)) throw new Error('unknown operation');
      const rows = read(), pending = rows.filter(r => ['running', 'unknown', 'interrupted'].includes(r.state));
      if (pending.length >= 500) throw new Error('too many operations without a confirmed result');
      const record = { id: uuid(), op: req.op, state: 'running', startedAt: now() };
      write([record, ...pending, ...rows.filter(r => !pending.includes(r))].slice(0, 500));
      return record.id;
    },
    settle(id, result) { update(id, { state: uncertain(result) ? 'unknown' : result.ok ? 'completed' : 'failed', result, finishedAt: now() }); },
    async recover(query) {
      const pending = read().filter(r => ['running', 'unknown'].includes(r.state)).slice(0, 16);
      for (let i = 0; i < pending.length; i += 4) await Promise.all(pending.slice(i, i + 4).map(async row => {
        let answer;
        try { answer = await query(row.id); } catch { return; }
        const d = answer?.ok && answer.data;
        if (!d || d.id !== row.id || d.op !== row.op || !STATES.has(d.state)) return;
        const current = read().find(r => r.id === row.id);
        if (!current || !['running', 'unknown'].includes(current.state)) return;
        if (['completed', 'failed'].includes(d.state) && (!d.result || typeof d.result.ok !== 'boolean')) return;
        update(row.id, { state: d.state, ...(d.result ? { result: d.result } : {}), ...(d.finishedAt ? { finishedAt: d.finishedAt } : {}) });
      }));
      return read();
    },
    read,
  };
}
module.exports = { createOperationStore };
