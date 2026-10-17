'use strict';
// The licensing database (SQLite via node:sqlite for the PoC). Everything the service reads or
// writes goes through the methods below, so a Postgres adapter can replace this file: same
// methods, same row shapes (camelCase), `transaction(fn)` mapped to a Postgres transaction.
//
// The guarantees that matter are in the schema itself, not only in the service:
// - one code per order unit and one license per code (UNIQUE), so no bug can mint two licenses;
// - a code leaves 'ready' once and never returns (trigger), and codes/licenses are never deleted;
// - one active device per machine per license (partial UNIQUE index).
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  features TEXT NOT NULL,                 -- JSON array of feature names
  device_limit INTEGER NOT NULL CHECK (device_limit >= 1),
  policy_version INTEGER NOT NULL,
  license_days INTEGER                    -- NULL: no end date
);

CREATE TABLE owners (                     -- a verified email address
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE owner_challenges (           -- one-time 6-digit codes; only their HMAC is kept
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE owner_tokens (               -- short-lived owner sessions; only their hash is kept
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE outbox (                     -- stand-in for the email provider (owner codes only)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('direct', 'reseller')),
  purchaser_email TEXT,                   -- direct sale: only this verified owner may redeem
  payment_id TEXT UNIQUE,                 -- the provider's payment id: a replayed payment can't issue twice
  plan_id TEXT NOT NULL REFERENCES plans(id),
  created_at INTEGER NOT NULL,
  CHECK (channel = 'reseller' OR purchaser_email IS NOT NULL)
);

CREATE TABLE order_units (                -- one paid unit = one code = at most one license
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('paid', 'refunded')),
  refunded_at INTEGER,
  UNIQUE (order_id, seq)
);

CREATE TABLE codes (
  id TEXT PRIMARY KEY,
  order_unit_id TEXT NOT NULL UNIQUE REFERENCES order_units(id),
  hmac TEXT NOT NULL UNIQUE,              -- HMAC-SHA256(server secret, normalized code)
  suffix TEXT NOT NULL,                   -- last 4 characters, for support
  state TEXT NOT NULL CHECK (state IN ('ready', 'redeemed', 'revoked')),
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE delivery_boxes (             -- the code encrypted (AES-256-GCM) for re-sending, until redeemed or expired
  code_id TEXT PRIMARY KEY REFERENCES codes(id),
  iv BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL UNIQUE REFERENCES codes(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),   -- 'expired' is derived from expires_at
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE devices (                    -- one install's key on one machine, bound to a license
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  machine_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT,
  last_request_ts INTEGER NOT NULL DEFAULT 0,  -- newest signed request seen: older ones are replays
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX devices_one_active_per_machine ON devices (license_id, machine_id) WHERE state = 'active';
CREATE INDEX devices_by_license ON devices (license_id, state);

CREATE TABLE idempotency_keys (           -- a redemption's key, for answering its retries
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  request_hash TEXT NOT NULL,             -- what was asked (code HMAC, machine, device key)
  license_id TEXT NOT NULL REFERENCES licenses(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE events (                     -- audit log: ids and state changes, never a code
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  request_id TEXT,
  payment_id TEXT,
  order_id TEXT,
  unit_id TEXT,
  code_id TEXT,
  license_id TEXT,
  device_id TEXT,
  owner_id TEXT,
  detail TEXT                             -- JSON
);

CREATE TRIGGER codes_state_once BEFORE UPDATE OF state ON codes
  WHEN NOT (OLD.state = 'ready' AND NEW.state IN ('redeemed', 'revoked'))
  BEGIN SELECT RAISE(ABORT, 'a code leaves ready once and never returns'); END;
CREATE TRIGGER codes_identity_fixed BEFORE UPDATE OF hmac, order_unit_id ON codes
  BEGIN SELECT RAISE(ABORT, 'a code''s identity never changes'); END;
CREATE TRIGGER codes_kept BEFORE DELETE ON codes
  BEGIN SELECT RAISE(ABORT, 'codes are never deleted'); END;
CREATE TRIGGER licenses_state_once BEFORE UPDATE OF state ON licenses
  WHEN NOT (OLD.state = 'active' AND NEW.state = 'revoked')
  BEGIN SELECT RAISE(ABORT, 'a revoked license stays revoked'); END;
CREATE TRIGGER licenses_code_fixed BEFORE UPDATE OF code_id ON licenses
  BEGIN SELECT RAISE(ABORT, 'a license''s code never changes'); END;
CREATE TRIGGER licenses_kept BEFORE DELETE ON licenses
  BEGIN SELECT RAISE(ABORT, 'licenses are never deleted'); END;
CREATE TRIGGER devices_state_once BEFORE UPDATE OF state ON devices
  WHEN NOT (OLD.state = 'active' AND NEW.state = 'released')
  BEGIN SELECT RAISE(ABORT, 'a released device stays released'); END;
`;

const camelKey = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const camel = (row) => {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v instanceof Uint8Array ? Buffer.from(v) : v;
  return out;
};
const nul = (v) => (v === undefined ? null : v);

function migrate(db) {
  const version = () => db.prepare('PRAGMA user_version').get().user_version;
  if (version() >= SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have migrated while this one waited for the lock.
    if (version() < SCHEMA_VERSION) {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// One connection per process. WAL lets readers run beside the single writer; busy_timeout makes a
// writer from another process wait for the lock instead of failing.
function openStore(file, { busyTimeoutMs = 5000 } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const one = (sql, ...args) => camel(stmt(sql).get(...args));
  const all = (sql, ...args) => stmt(sql).all(...args).map(camel);
  const run = (sql, ...args) => stmt(sql).run(...args).changes;

  const plan = (row) => row && { ...row, features: JSON.parse(row.features) };

  return {
    // BEGIN IMMEDIATE takes the write lock up front, so two processes redeeming the same code queue
    // here instead of both reading 'ready'. Any throw rolls the whole transaction back. `fn` must
    // be synchronous: nothing else may run on this connection while the transaction is open.
    transaction(fn) {
      if (db.isTransaction) throw new Error('nested transaction');
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),

    upsertPlan: (p) => run(`INSERT INTO plans (id, features, device_limit, policy_version, license_days) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET features = excluded.features, device_limit = excluded.device_limit,
        policy_version = excluded.policy_version, license_days = excluded.license_days`,
    p.id, JSON.stringify(p.features), p.deviceLimit, p.policyVersion, nul(p.licenseDays)),
    getPlan: (id) => plan(one('SELECT * FROM plans WHERE id = ?', id)),

    getOwnerByEmail: (email) => one('SELECT * FROM owners WHERE email = ?', email),
    getOwner: (id) => one('SELECT * FROM owners WHERE id = ?', id),
    insertOwner: (o) => run('INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)', o.id, o.email, o.createdAt),

    insertChallenge: (c) => run('INSERT INTO owner_challenges (id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      c.id, c.email, c.codeHash, c.expiresAt, c.createdAt),
    getChallenge: (id) => one('SELECT * FROM owner_challenges WHERE id = ?', id),
    countChallengeAttempt: (id) => run('UPDATE owner_challenges SET attempts = attempts + 1 WHERE id = ?', id),
    // Conditional: of two correct answers racing, only one gets a token.
    useChallenge: (id, at) => run('UPDATE owner_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL', at, id) === 1,

    insertOwnerToken: (t) => run('INSERT INTO owner_tokens (token_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      t.tokenHash, t.ownerId, t.expiresAt, t.createdAt),
    getOwnerToken: (hash) => one('SELECT * FROM owner_tokens WHERE token_hash = ?', hash),

    insertOutbox: (m) => run('INSERT INTO outbox (to_email, kind, body, created_at) VALUES (?, ?, ?, ?)', m.to, m.kind, m.body, m.createdAt),
    readOutbox: (to) => all('SELECT * FROM outbox WHERE to_email = ? ORDER BY id', to),

    insertOrder: (o) => run('INSERT INTO orders (id, channel, purchaser_email, payment_id, plan_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      o.id, o.channel, nul(o.purchaserEmail), nul(o.paymentId), o.planId, o.createdAt),
    getOrder: (id) => one('SELECT * FROM orders WHERE id = ?', id),
    getOrderByPayment: (paymentId) => one('SELECT * FROM orders WHERE payment_id = ?', paymentId),
    insertUnit: (u) => run("INSERT INTO order_units (id, order_id, seq, state) VALUES (?, ?, ?, 'paid')", u.id, u.orderId, u.seq),
    getUnit: (id) => one('SELECT * FROM order_units WHERE id = ?', id),
    refundUnit: (id, at) => run("UPDATE order_units SET state = 'refunded', refunded_at = ? WHERE id = ? AND state = 'paid'", at, id) === 1,

    insertCode: (c) => run("INSERT INTO codes (id, order_unit_id, hmac, suffix, state, created_at) VALUES (?, ?, ?, ?, 'ready', ?)",
      c.id, c.unitId, c.hmac, c.suffix, c.createdAt),
    getCodeByHmac: (hmac) => one('SELECT * FROM codes WHERE hmac = ?', hmac),
    getCodeByUnit: (unitId) => one('SELECT * FROM codes WHERE order_unit_id = ?', unitId),
    getCode: (id) => one('SELECT * FROM codes WHERE id = ?', id),
    // The conditional update: true only for the one caller that moved this code out of 'ready'.
    redeemCode: (id, at) => run("UPDATE codes SET state = 'redeemed', redeemed_at = ? WHERE id = ? AND state = 'ready'", at, id) === 1,
    revokeCode: (id, at) => run("UPDATE codes SET state = 'revoked', revoked_at = ? WHERE id = ? AND state = 'ready'", at, id) === 1,

    insertBox: (b) => run('INSERT INTO delivery_boxes (code_id, iv, ciphertext, tag, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      b.codeId, b.iv, b.ciphertext, b.tag, b.expiresAt, b.createdAt),
    getBox: (codeId) => one('SELECT * FROM delivery_boxes WHERE code_id = ?', codeId),
    deleteBox: (codeId) => run('DELETE FROM delivery_boxes WHERE code_id = ?', codeId),

    insertLicense: (l) => run("INSERT INTO licenses (id, code_id, owner_id, plan_id, state, created_at, expires_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      l.id, l.codeId, l.ownerId, l.planId, l.createdAt, nul(l.expiresAt)),
    getLicense: (id) => one('SELECT * FROM licenses WHERE id = ?', id),
    getLicenseByCode: (codeId) => one('SELECT * FROM licenses WHERE code_id = ?', codeId),
    licensesOfOwner: (ownerId) => all(`SELECT l.*, c.suffix AS code_suffix FROM licenses l JOIN codes c ON c.id = l.code_id
      WHERE l.owner_id = ? ORDER BY l.created_at, l.id`, ownerId),
    revokeLicense: (id, at) => run("UPDATE licenses SET state = 'revoked', revoked_at = ? WHERE id = ? AND state = 'active'", at, id) === 1,

    insertDevice: (d) => run("INSERT INTO devices (id, license_id, machine_id, public_key, state, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      d.id, d.licenseId, d.machineId, d.publicKey, d.createdAt, d.createdAt),
    getDevice: (id) => one('SELECT * FROM devices WHERE id = ?', id),
    activeDevices: (licenseId) => all("SELECT * FROM devices WHERE license_id = ? AND state = 'active' ORDER BY created_at, id", licenseId),
    activeDeviceOn: (licenseId, machineId) => one("SELECT * FROM devices WHERE license_id = ? AND machine_id = ? AND state = 'active'", licenseId, machineId),
    releaseDevice: (id, at, reason) => run("UPDATE devices SET state = 'released', released_at = ?, release_reason = ? WHERE id = ? AND state = 'active'", at, reason, id) === 1,
    // Conditional on the timestamp moving forward, so a replayed signed request loses even if two
    // copies arrive at once.
    touchDevice: (id, ts, at) => run('UPDATE devices SET last_request_ts = ?, last_seen_at = ? WHERE id = ? AND last_request_ts < ?', ts, at, id, ts) === 1,

    getIdempotency: (key) => one('SELECT * FROM idempotency_keys WHERE key = ?', key),
    insertIdempotency: (k) => run('INSERT INTO idempotency_keys (key, owner_id, request_hash, license_id, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      k.key, k.ownerId, k.requestHash, k.licenseId, k.deviceId, k.createdAt),

    insertEvent: (e) => run(`INSERT INTO events (at, type, request_id, payment_id, order_id, unit_id, code_id, license_id, device_id, owner_id, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.at, e.type, nul(e.requestId), nul(e.paymentId), nul(e.orderId), nul(e.unitId), nul(e.codeId), nul(e.licenseId),
    nul(e.deviceId), nul(e.ownerId), e.detail === undefined ? null : JSON.stringify(e.detail)),
    events: (type) => all('SELECT * FROM events WHERE type = ? ORDER BY id', type),

    // Housekeeping: boxes past their expiry, challenges and owner tokens past theirs.
    purgeExpired: (at) => run('DELETE FROM delivery_boxes WHERE expires_at <= ?', at)
      + run('DELETE FROM owner_challenges WHERE expires_at <= ?', at)
      + run('DELETE FROM owner_tokens WHERE expires_at <= ?', at),
  };
}

module.exports = { openStore, SCHEMA_VERSION };
