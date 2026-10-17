'use strict';
// The licensing HTTP API (PoC): POST, JSON in, JSON out. This layer parses, checks the admin
// token, picks the client address for rate limiting, and logs one line per request; service.cjs
// decides everything else. Bodies are never logged: a redeem line carries only the code's suffix.
const http = require('node:http');
const crypto = require('node:crypto');
const codes = require('./codes.cjs');

// Clients switch on `result` in the body; the status is for proxies and humans.
const STATUS = {
  ok: 200,
  invalid_request: 400,
  owner_unverified: 401, owner_code_invalid: 401, owner_code_expired: 401, bad_signature: 401, stale_request: 401, unauthorized: 401,
  owner_mismatch: 403,
  invalid_code: 404, not_found: 404,
  method_not_allowed: 405,
  already_redeemed: 409, code_revoked: 409, idempotency_conflict: 409, device_limit: 409, license_inactive: 409,
  device_released: 409, machine_mismatch: 409, license_required: 409, duplicate_payment: 409,
  delivery_unavailable: 410,
  payload_too_large: 413,
  rate_limited: 429, too_many_attempts: 429,
};

const ROUTES = {
  '/v1/owner/challenge': { run: (s, b, c) => s.challenge(b, c) },
  '/v1/owner/verify': { run: (s, b, c) => s.verify(b, c) },
  '/v1/redeem': { run: (s, b, c) => s.redeem(b, c), codeSuffix: true },
  '/v1/recover': { run: (s, b, c) => s.recover(b, c) },
  '/v1/license/refresh': { run: (s, b, c) => s.refresh(b, c) },
  '/v1/device/release': { run: (s, b, c) => s.releaseDevice(b, c) },
  '/v1/admin/orders': { run: (s, b, c) => s.createOrder(b, c), admin: true },
  '/v1/admin/redeliver': { run: (s, b, c) => s.redeliver(b, c), admin: true },
  '/v1/admin/revoke': { run: (s, b, c) => s.revokeUnit(b, c), admin: true },
};

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const stdoutLog = (line) => process.stdout.write(`${line}\n`);

// A body over the limit is drained and answered with 413 (closing mid-upload would look like a
// network failure to the client); one far over it gets its connection cut.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else if (size > 64 * limit) req.destroy();
    });
    req.on('end', () => (size > limit
      ? reject(Object.assign(new Error('too large'), { result: 'payload_too_large' }))
      : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('close', () => { if (!req.complete) reject(Object.assign(new Error('aborted'), { aborted: true })); });
  });
}

// log: called with one JSON line per request (and per unexpected error). Every line goes through
// codes.redact on the way out as a last guard.
function createServer({ service, adminToken, log = stdoutLog, maxBodyBytes = 16 * 1024 }) {
  if (typeof adminToken !== 'string' || adminToken.length < 32) throw new Error('adminToken must be at least 32 characters');
  const adminDigest = digest(adminToken);
  const write = (fields) => log(codes.redact(JSON.stringify(fields)));
  const isAdmin = (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    return !!m && crypto.timingSafeEqual(digest(m[1]), adminDigest);
  };

  return http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const requestId = crypto.randomBytes(6).toString('hex');
    const path = new URL(req.url, 'http://localhost').pathname;
    const address = req.socket.remoteAddress || 'unknown';
    const line = { t: new Date().toISOString(), requestId, address, method: req.method, path };
    const send = (status, body, extraHeaders = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId, ...extraHeaders });
      res.end(JSON.stringify(body));
      write({ ...line, status, result: body.result, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    };

    const route = ROUTES[path];
    if (!route) return send(404, { result: 'not_found' });
    if (req.method !== 'POST') return send(405, { result: 'method_not_allowed' }, { allow: 'POST' });
    if (route.admin && !isAdmin(req)) return send(401, { result: 'unauthorized' });

    let body;
    try {
      const text = await readBody(req, maxBodyBytes);
      body = JSON.parse(text);
    } catch (err) {
      // Never the parser's message: it quotes the body, and the body may hold a code.
      if (err.aborted) return write({ ...line, status: 0, result: 'aborted' });
      if (err.result) return send(413, { result: err.result });
      return send(400, { result: 'invalid_request' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { result: 'invalid_request' });
    if (route.codeSuffix) {
      const code = codes.normalize(body.code);
      line.codeSuffix = code ? codes.suffix(code) : null;
    }

    try {
      const out = route.run(service, body, { address, requestId });
      return send(STATUS[out.result] || 400, out);
    } catch (err) {
      // Only the error's kind is logged: messages can carry data.
      write({ ...line, level: 'error', error: err && (err.code || err.name) });
      return send(500, { result: 'internal_error' });
    }
  });
}

// -> { url, server, close() }. port 0 picks a free port (the tests use that).
function start({ service, adminToken, port = 0, host = '127.0.0.1', log = stdoutLog }) {
  const server = createServer({ service, adminToken, log });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: bound } = server.address();
      resolve({
        server,
        url: `http://${host}:${bound}`,
        close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { createServer, start, STATUS };

// `node licensing/server.cjs`: a development server. TUNE_LICENSING_DB and TUNE_LICENSING_KEYS
// name the database and the key file (a fresh key file is created if missing); PORT (default
// 8787, 0 = any free port) and HOST (default 127.0.0.1) say where to listen.
if (require.main === module) {
  const os = require('node:os');
  const nodePath = require('node:path');
  const { openStore } = require('./store.cjs');
  const { createService } = require('./service.cjs');
  const { loadKeys } = require('./keys.cjs');
  const dbFile = process.env.TUNE_LICENSING_DB || nodePath.join(os.tmpdir(), 'tune-licensing-dev.sqlite');
  const keysFile = process.env.TUNE_LICENSING_KEYS || nodePath.join(os.tmpdir(), 'tune-licensing-dev-keys.json');
  const keys = loadKeys(keysFile, { create: true });
  const store = openStore(dbFile);
  const service = createService({ store, keys });
  start({ service, adminToken: keys.adminToken, port: Number(process.env.PORT ?? 8787), host: process.env.HOST || '127.0.0.1' })
    .then(({ url, close }) => {
      stdoutLog(JSON.stringify({ msg: 'listening', url, db: dbFile, keys: keysFile }));
      const stop = () => close().then(() => { store.close(); process.exit(0); });
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    });
}
