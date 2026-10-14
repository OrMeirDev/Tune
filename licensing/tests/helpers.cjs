'use strict';
// Shared set-up for the licensing tests: a fresh database in a temp folder, a service on it with a
// clock the test moves by hand, and the steps a customer takes (verify an email, redeem on a PC).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../store.cjs');
const { createService } = require('../service.cjs');
const { generateKeys, parseKeys } = require('../keys.cjs');
const { createDeviceKey, machineId } = require('../device.cjs');

const T0 = Date.parse('2026-10-14T09:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

// A PC: its machine identity (as Tune would compute it) and a fresh install's device key.
function pc(name) {
  const h = crypto.createHash('sha256').update(name).digest('hex');
  const guid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  return { name, machineId: machineId({ machineGuid: guid, smbiosUuid: guid.toUpperCase() }), ...createDeviceKey() };
}
// The same PC after a reinstall: same machine, new device key.
const reinstall = (machine) => ({ ...machine, ...createDeviceKey() });

const idemKey = () => crypto.randomBytes(16).toString('base64url');

// options: anything createService takes; `now` replaces the hand-moved clock (child processes
// run on real time, so the race tests pass Date.now).
function setup(t, { now = clock(), ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-licensing-'));
  const file = path.join(dir, 'licensing.sqlite');
  const rawKeys = generateKeys();
  const keys = parseKeys(rawKeys);
  const store = openStore(file);
  const service = createService({ store, keys, now, ...options });
  // Run last-registered first, then close the database and remove the folder.
  const deferred = [];
  t.after(async () => {
    for (const fn of deferred.reverse()) await fn();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The email flow, reading the code from the outbox like a customer reads their mail.
  function owner(email, ctx = { address: '198.51.100.1' }) {
    const c = service.challenge({ email }, ctx);
    if (c.result !== 'ok') throw new Error(`challenge: ${c.result}`);
    const mail = store.readOutbox(email.trim().toLowerCase()).at(-1);
    const code = /\b(\d{6})\b/.exec(mail.body)[1];
    const v = service.verify({ challengeId: c.challengeId, code }, ctx);
    if (v.result !== 'ok') throw new Error(`verify: ${v.result}`);
    return v.ownerToken;
  }

  function order({ channel = 'reseller', planId = 'tune-pro', quantity = 1, ...rest } = {}) {
    const o = service.createOrder({ channel, planId, quantity, ...rest });
    if (o.result !== 'ok') throw new Error(`order: ${o.result}`);
    return o;
  }

  const redeem = (ownerToken, code, machine, { key = idemKey(), address = '198.51.100.1' } = {}) =>
    service.redeem({ code, ownerToken, machineId: machine.machineId, devicePublicKey: machine.publicKey, idempotencyKey: key }, { address });

  const recover = (ownerToken, machine, extra = {}) =>
    service.recover({ ownerToken, machineId: machine.machineId, devicePublicKey: machine.publicKey, ...extra }, { address: '198.51.100.1' });

  // A separate connection, for the checks a test makes straight on the tables.
  function sql() {
    const db = new DatabaseSync(file);
    deferred.push(() => db.close());
    return db;
  }
  const count = (table, where = '1 = 1', ...args) => {
    const db = new DatabaseSync(file);
    try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n; } finally { db.close(); }
  };

  return { dir, file, rawKeys, keys, now, store, service, defer: (fn) => deferred.push(fn), owner, order, redeem, recover, sql, count };
}

module.exports = { T0, MINUTE, DAY, clock, pc, reinstall, idemKey, setup };
