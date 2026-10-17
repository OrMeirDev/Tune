'use strict';
// Licensing rules (PoC): owner verification by email, issuing codes, one-time redemption,
// recovery on the same PC, moving to another PC, certificate refresh, refunds and re-delivery.
// Every call returns { result: 'ok', ... } or { result: '<reason>', ... } and never throws for a
// refusal; server.cjs maps results to HTTP statuses. The database stays behind store.cjs.
const crypto = require('node:crypto');
const codes = require('./codes.cjs');
const certificate = require('./certificate.cjs');
const { verifyRequest } = require('./device.cjs');
const { createLimiter } = require('./rate-limit.cjs');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const DEFAULTS = {
  // How long a certificate works without the server. An open business decision: longer means
  // fewer refreshes offline, but also longer that a released or refunded PC keeps working.
  certTtlMs: 7 * DAY,
  ownerCodeTtlMs: 10 * MINUTE,
  ownerCodeAttempts: 5,
  ownerTokenTtlMs: 30 * MINUTE,
  deliveryTtlMs: 30 * DAY,
  requestSkewMs: 5 * MINUTE,
  maxUnitsPerOrder: 100,
  limits: {
    redeemPerAddress: { max: 20, windowMs: 15 * MINUTE },
    redeemPerOwner: { max: 10, windowMs: 15 * MINUTE },
    challengePerEmail: { max: 5, windowMs: 15 * MINUTE },
    challengePerAddress: { max: 30, windowMs: 15 * MINUTE },
  },
};

// Packages live in data, not in the code format: a code only points at an order unit, and the
// order says which plan. Illustrative values.
const DEFAULT_PLANS = [
  { id: 'tune-pro', features: ['drivers', 'bios', 'cleanup', 'startup', 'sensors'], deviceLimit: 1, policyVersion: 1, licenseDays: 365 },
  { id: 'tune-pro-3', features: ['drivers', 'bios', 'cleanup', 'startup', 'sensors'], deviceLimit: 3, policyVersion: 1, licenseDays: 365 },
];

const ID = /^[a-z]{3,4}_[0-9a-f]{24}$/;
const MACHINE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PLAN = /^[a-z0-9-]{1,40}$/;
const PAYMENT = /^[A-Za-z0-9_.:-]{1,128}$/;
const REASON = /^[a-z_]{1,32}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

const isStr = (v, re) => typeof v === 'string' && re.test(v);
const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const emailOf = (v) => {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
};
const keyOf = (v) => (typeof v === 'string' && v.length <= 200 ? certificate.publicKeyString(v) : null);
const isUnique = (err) => !!err && (err.errcode === 2067 || err.errcode === 1555);

// Refusals that look like guessing or someone else's code: these count towards the rate limit.
const REDEEM_FAILURES = new Set(['invalid_code', 'code_revoked', 'already_redeemed', 'owner_mismatch', 'idempotency_conflict']);

function createService({ store, keys, now = Date.now, plans = DEFAULT_PLANS, ...options }) {
  const opts = { ...DEFAULTS, ...options, limits: { ...DEFAULTS.limits, ...options.limits } };
  const limiter = Object.fromEntries(Object.entries(opts.limits).map(([k, v]) => [k, createLimiter({ ...v, now })]));
  // The 6-digit owner codes are hashed with a key derived from the server secret: a plain hash of
  // a 6-digit number would be reversed in a second by anyone holding a copy of the database.
  const ownerCodeKey = Buffer.from(crypto.hkdfSync('sha256', keys.codeSecret, Buffer.alloc(0), 'tune owner codes', 32));
  const ownerCodeHash = (challengeId, code) => crypto.createHmac('sha256', ownerCodeKey).update(`${challengeId}:${code}`).digest('hex');
  const publicKey = crypto.createPublicKey(keys.signingKey).export({ type: 'spki', format: 'pem' });

  store.transaction(() => { for (const p of plans) store.upsertPlan(p); });

  const event = (type, ids, detail) => store.insertEvent({ at: now(), type, ...ids, detail });
  const rateLimited = (name, key) => ({ result: 'rate_limited', retryAfterSeconds: Math.ceil(limiter[name].retryAfterMs(key) / 1000) });
  const statusOf = (license, at) => {
    if (license.state === 'revoked') return 'revoked';
    return license.expiresAt !== null && at >= license.expiresAt ? 'expired' : 'active';
  };

  // A token is 32 random bytes, so a plain SHA-256 of it is enough to keep it out of the database.
  function ownerOf(token, at) {
    if (!isStr(token, TOKEN)) return null;
    const t = store.getOwnerToken(sha256(token));
    return t && at < t.expiresAt ? store.getOwner(t.ownerId) : null;
  }

  // The delivery box: the code under AES-256-GCM. The code id and expiry are the additional data,
  // so a box can't be moved to another code or have its expiry stretched in the database.
  const boxAad = (codeId, expiresAt) => Buffer.from(`${codeId}|${expiresAt}`);
  function seal(code, codeId, expiresAt) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keys.deliveryKey, iv);
    c.setAAD(boxAad(codeId, expiresAt));
    const ciphertext = Buffer.concat([c.update(code, 'ascii'), c.final()]);
    return { iv, ciphertext, tag: c.getAuthTag() };
  }
  function unseal(box) {
    const d = crypto.createDecipheriv('aes-256-gcm', keys.deliveryKey, box.iv);
    d.setAAD(boxAad(box.codeId, box.expiresAt));
    d.setAuthTag(box.tag);
    return Buffer.concat([d.update(box.ciphertext), d.final()]).toString('ascii');
  }

  // The certificate never outlives the license itself.
  function issue(license, device, at) {
    const plan = store.getPlan(license.planId);
    return certificate.sign({
      licenseId: license.id, deviceId: device.id, machineId: device.machineId, devicePublicKey: device.publicKey,
      planId: plan.id, features: plan.features, issuedAt: at,
      expiresAt: Math.min(at + opts.certTtlMs, license.expiresAt ?? Infinity), policyVersion: plan.policyVersion,
    }, keys.signingKey);
  }
  const granted = (license, device, at, extra = {}) => ({
    result: 'ok', licenseId: license.id, deviceId: device.id, planId: license.planId,
    licenseExpiresAt: license.expiresAt, certificate: issue(license, device, at), ...extra,
  });

  // ---- owner verification (stand-in for a real email provider: the outbox table) ----

  function challenge(input, ctx = {}) {
    const at = now();
    const email = emailOf(input && input.email);
    if (!email) return { result: 'invalid_request' };
    const keysHit = [['challengePerEmail', `email:${email}`], ['challengePerAddress', `addr:${ctx.address || 'unknown'}`]];
    for (const [name, key] of keysHit) if (limiter[name].blocked(key)) return rateLimited(name, key);
    for (const [name, key] of keysHit) limiter[name].hit(key);
    const id = newId('chl');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = at + opts.ownerCodeTtlMs;
    store.transaction(() => {
      store.insertChallenge({ id, email, codeHash: ownerCodeHash(id, code), expiresAt, createdAt: at });
      store.insertOutbox({ to: email, kind: 'owner_code', body: `Your Tune verification code is ${code}. It expires in ${Math.round(opts.ownerCodeTtlMs / MINUTE)} minutes.`, createdAt: at });
    });
    return { result: 'ok', challengeId: id, expiresAt };
  }

  function verify(input, ctx = {}) {
    const at = now();
    const { challengeId, code } = input || {};
    if (!isStr(challengeId, ID) || !isStr(code, /^\d{6}$/)) return { result: 'invalid_request' };
    return store.transaction(() => {
      const ch = store.getChallenge(challengeId);
      if (!ch || ch.usedAt !== null) return { result: 'owner_code_invalid' };
      if (at >= ch.expiresAt) return { result: 'owner_code_expired' };
      if (ch.attempts >= opts.ownerCodeAttempts) return { result: 'too_many_attempts' };
      const good = crypto.timingSafeEqual(Buffer.from(ch.codeHash, 'hex'), Buffer.from(ownerCodeHash(ch.id, code), 'hex'));
      if (!good) {
        store.countChallengeAttempt(ch.id);
        return { result: 'owner_code_invalid', attemptsLeft: Math.max(0, opts.ownerCodeAttempts - ch.attempts - 1) };
      }
      if (!store.useChallenge(ch.id, at)) return { result: 'owner_code_invalid' };
      let owner = store.getOwnerByEmail(ch.email);
      if (!owner) { owner = { id: newId('own'), email: ch.email, createdAt: at }; store.insertOwner(owner); }
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = at + opts.ownerTokenTtlMs;
      store.insertOwnerToken({ tokenHash: sha256(token), ownerId: owner.id, expiresAt, createdAt: at });
      event('owner.verified', { requestId: ctx.requestId, ownerId: owner.id });
      return { result: 'ok', ownerToken: token, expiresAt };
    });
  }

  // ---- redemption (LC05-LC07) ----

  // The one transaction: redeem the code (conditional on 'ready'), create the license, bind the
  // device, remember the idempotency key, drop the delivery box. All of it or none of it.
  function redeemOnce({ code, owner, machineId, publicKey, key, at, requestId }) {
    const codeHmac = codes.hmac(keys.codeSecret, code);
    const requestHash = sha256(certificate.canonical({ codeHmac, machineId, publicKey }));
    try {
      return store.transaction(() => {
        // A retry after a lost response. The key only finds the earlier answer; the owner and the
        // request must still be the same, or the key is worth nothing.
        const prior = store.getIdempotency(key);
        if (prior) {
          if (prior.ownerId !== owner.id || prior.requestHash !== requestHash) return { result: 'idempotency_conflict' };
          const license = store.getLicense(prior.licenseId);
          const device = store.getDevice(prior.deviceId);
          if (statusOf(license, at) !== 'active') return { result: 'license_inactive', status: statusOf(license, at) };
          if (device.state !== 'active') return { result: 'device_released' };
          return { result: 'ok', license, device, replayed: true };
        }
        const row = store.getCodeByHmac(codeHmac);
        if (!row) return { result: 'invalid_code' };
        const unit = store.getUnit(row.orderUnitId);
        if (row.state === 'revoked' || unit.state !== 'paid') return { result: 'code_revoked', codeId: row.id };
        if (row.state === 'redeemed') {
          const license = store.getLicenseByCode(row.id);
          // Only the license's own owner hears which license it is, so they can recover it.
          if (license.ownerId === owner.id) return { result: 'already_redeemed', yours: true, licenseId: license.id };
          return { result: 'already_redeemed', codeId: row.id };
        }
        const order = store.getOrder(unit.orderId);
        // LC01: a direct sale belongs to the verified purchaser; a reseller's code to whoever redeems first.
        if (order.channel === 'direct' && order.purchaserEmail !== owner.email) return { result: 'owner_mismatch', codeId: row.id };
        if (!store.redeemCode(row.id, at)) return { result: 'already_redeemed', codeId: row.id };

        const plan = store.getPlan(order.planId);
        const license = { id: newId('lic'), codeId: row.id, ownerId: owner.id, planId: plan.id, createdAt: at, expiresAt: plan.licenseDays ? at + plan.licenseDays * DAY : null };
        const device = { id: newId('dev'), licenseId: license.id, machineId, publicKey, createdAt: at };
        store.insertLicense(license);
        store.insertDevice(device);
        store.insertIdempotency({ key, ownerId: owner.id, requestHash, licenseId: license.id, deviceId: device.id, createdAt: at });
        store.deleteBox(row.id);
        const ids = { requestId, paymentId: order.paymentId, orderId: order.id, unitId: unit.id, codeId: row.id, licenseId: license.id, ownerId: owner.id };
        event('code.redeemed', ids, { suffix: row.suffix });
        event('license.created', ids, { planId: plan.id });
        event('device.bound', { ...ids, deviceId: device.id }, { via: 'redeem' });
        return { result: 'ok', license: store.getLicense(license.id), device: store.getDevice(device.id) };
      });
    } catch (err) {
      // A UNIQUE constraint caught what the checks above should already have: someone else's
      // request got there first. The transaction was rolled back.
      if (isUnique(err)) return { result: 'already_redeemed' };
      throw err;
    }
  }

  function redeem(input, ctx = {}) {
    const at = now();
    const byAddress = `addr:${ctx.address || 'unknown'}`;
    if (limiter.redeemPerAddress.blocked(byAddress)) return rateLimited('redeemPerAddress', byAddress);
    const owner = ownerOf(input && input.ownerToken, at);
    if (!owner) { limiter.redeemPerAddress.hit(byAddress); return { result: 'owner_unverified' }; }
    const byOwner = `owner:${owner.id}`;
    if (limiter.redeemPerOwner.blocked(byOwner)) return rateLimited('redeemPerOwner', byOwner);

    const { machineId, idempotencyKey: key } = input;
    const publicKey = keyOf(input.devicePublicKey);
    if (!isStr(machineId, MACHINE) || !publicKey || !isStr(key, IDEMPOTENCY)) return { result: 'invalid_request' };

    const code = codes.normalize(input.code);
    const outcome = code
      ? redeemOnce({ code, owner, machineId, publicKey, key, at, requestId: ctx.requestId })
      : { result: 'invalid_code' };

    if (outcome.result === 'ok') return granted(outcome.license, outcome.device, at, outcome.replayed ? { replayed: true } : {});
    if (REDEEM_FAILURES.has(outcome.result) && !outcome.yours) {
      limiter.redeemPerAddress.hit(byAddress);
      limiter.redeemPerOwner.hit(byOwner);
      event('redeem.refused', { requestId: ctx.requestId, ownerId: owner.id, codeId: outcome.codeId }, { reason: outcome.result });
    }
    // Answer only with the reason: no ids of whoever holds the code.
    if (outcome.yours) return { result: 'already_redeemed', yours: true, licenseId: outcome.licenseId };
    return outcome.status ? { result: outcome.result, status: outcome.status } : { result: outcome.result };
  }

  // ---- after redemption: the license, without the code (recovery, devices, refresh) ----

  const licenseSummary = (l, at) => ({ licenseId: l.id, planId: l.planId, codeSuffix: l.codeSuffix, status: statusOf(l, at), expiresAt: l.expiresAt });
  const deviceSummary = (d) => ({ deviceId: d.id, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt });

  // Reinstall on the same PC (same machine, new device key) gets the same license and a
  // certificate for the new key. Another PC gets a seat only while the plan has one free.
  function recover(input, ctx = {}) {
    const at = now();
    const owner = ownerOf(input && input.ownerToken, at);
    if (!owner) return { result: 'owner_unverified' };
    const { machineId, licenseId } = input;
    const publicKey = keyOf(input.devicePublicKey);
    if (!isStr(machineId, MACHINE) || !publicKey || (licenseId !== undefined && !isStr(licenseId, ID))) return { result: 'invalid_request' };

    const outcome = store.transaction(() => {
      const mine = store.licensesOfOwner(owner.id);
      // Without a license id: the one this PC already holds, else the owner's only license.
      const license = licenseId
        ? mine.find((l) => l.id === licenseId)
        : mine.find((l) => store.activeDeviceOn(l.id, machineId)) || (mine.length === 1 ? mine[0] : null);
      if (!license) {
        return licenseId || mine.length === 0 ? { result: 'not_found' } : { result: 'license_required', licenses: mine.map((l) => licenseSummary(l, at)) };
      }
      const status = statusOf(license, at);
      if (status !== 'active') return { result: 'license_inactive', status };

      const here = store.activeDeviceOn(license.id, machineId);
      if (here && here.publicKey === publicKey) return { result: 'ok', license, device: here };
      const ids = { requestId: ctx.requestId, licenseId: license.id, ownerId: owner.id };
      if (here) {
        // Same PC, new install: the old install's key stops working, the new one takes its seat.
        store.releaseDevice(here.id, at, 'replaced');
        event('device.released', { ...ids, deviceId: here.id }, { reason: 'replaced' });
      } else {
        const plan = store.getPlan(license.planId);
        const active = store.activeDevices(license.id);
        if (active.length >= plan.deviceLimit) return { result: 'device_limit', deviceLimit: plan.deviceLimit, devices: active.map(deviceSummary) };
      }
      const device = { id: newId('dev'), licenseId: license.id, machineId, publicKey, createdAt: at };
      store.insertDevice(device);
      event('device.bound', { ...ids, deviceId: device.id }, { via: 'recover' });
      return { result: 'ok', license, device: store.getDevice(device.id) };
    });
    return outcome.result === 'ok' ? granted(outcome.license, outcome.device, at) : outcome;
  }

  // Signed by the device's private key: a copied certificate (or a copied license id) alone
  // gets nothing. The timestamp must be recent and newer than the last one seen (no replays).
  function refresh(input, ctx = {}) {
    const at = now();
    const { licenseId, deviceId, machineId, ts, signature } = input || {};
    if (!isStr(licenseId, ID) || !isStr(deviceId, ID) || !isStr(machineId, MACHINE)) return { result: 'invalid_request' };
    if (!Number.isSafeInteger(ts) || typeof signature !== 'string') return { result: 'bad_signature' };
    const device = store.getDevice(deviceId);
    // An unknown device answers like a bad signature, so ids can't be probed.
    if (!device || device.licenseId !== licenseId) return { result: 'bad_signature' };
    if (!verifyRequest('refresh', { licenseId, deviceId, machineId }, ts, signature, device.publicKey)) return { result: 'bad_signature' };
    if (Math.abs(at - ts) > opts.requestSkewMs || ts <= device.lastRequestTs) return { result: 'stale_request' };
    if (device.machineId !== machineId) return { result: 'machine_mismatch' };
    if (device.state !== 'active') return { result: 'device_released' };
    const license = store.getLicense(licenseId);
    const status = statusOf(license, at);
    if (status !== 'active') return { result: 'license_inactive', status };
    if (!store.transaction(() => store.touchDevice(device.id, ts, at))) return { result: 'stale_request' };
    return granted(license, store.getDevice(device.id), at);
  }

  // The verified owner frees a seat (moving to another PC). A certificate already on the old PC
  // keeps working offline until it expires: that is what the certificate TTL trades off.
  function releaseDevice(input, ctx = {}) {
    const at = now();
    const owner = ownerOf(input && input.ownerToken, at);
    if (!owner) return { result: 'owner_unverified' };
    const { deviceId } = input;
    if (!isStr(deviceId, ID)) return { result: 'invalid_request' };
    return store.transaction(() => {
      const device = store.getDevice(deviceId);
      const license = device && store.getLicense(device.licenseId);
      if (!license || license.ownerId !== owner.id) return { result: 'not_found' };
      if (device.state !== 'active') return { result: 'ok', deviceId, alreadyReleased: true };
      store.releaseDevice(device.id, at, 'owner');
      event('device.released', { requestId: ctx.requestId, licenseId: license.id, ownerId: owner.id, deviceId }, { reason: 'owner' });
      return { result: 'ok', deviceId };
    });
  }

  // ---- admin (server.cjs checks the admin token) ----

  // N units -> N codes. The raw codes are in this answer once; after that only the delivery
  // boxes hold them (encrypted) until each is redeemed or its box expires.
  function createOrder(input, ctx = {}) {
    const at = now();
    const { channel, planId, quantity = 1, paymentId } = input || {};
    const purchaserEmail = input && input.purchaserEmail !== undefined ? emailOf(input.purchaserEmail) : null;
    const valid = ['direct', 'reseller'].includes(channel) && isStr(planId, PLAN)
      && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= opts.maxUnitsPerOrder
      && (paymentId === undefined || isStr(paymentId, PAYMENT))
      && (channel === 'direct' ? !!purchaserEmail : input.purchaserEmail === undefined);
    if (!valid) return { result: 'invalid_request' };
    if (!store.getPlan(planId)) return { result: 'invalid_request', field: 'planId' };

    return store.transaction(() => {
      if (paymentId !== undefined) {
        const prior = store.getOrderByPayment(paymentId);
        if (prior) return { result: 'duplicate_payment', orderId: prior.id };
      }
      const order = { id: newId('ord'), channel, purchaserEmail, paymentId, planId, createdAt: at };
      store.insertOrder(order);
      const ids = { requestId: ctx.requestId, paymentId, orderId: order.id };
      event('order.created', ids, { channel, planId, quantity });
      const units = [];
      for (let seq = 1; seq <= quantity; seq++) {
        const unitId = newId('unit');
        const codeId = newId('code');
        const code = codes.generate();
        const expiresAt = at + opts.deliveryTtlMs;
        store.insertUnit({ id: unitId, orderId: order.id, seq });
        store.insertCode({ id: codeId, unitId, hmac: codes.hmac(keys.codeSecret, code), suffix: codes.suffix(code), createdAt: at });
        store.insertBox({ codeId, ...seal(code, codeId, expiresAt), expiresAt, createdAt: at });
        event('code.issued', { ...ids, unitId, codeId }, { suffix: codes.suffix(code) });
        units.push({ unitId, code: codes.format(code), suffix: codes.suffix(code) });
      }
      return { result: 'ok', orderId: order.id, units };
    });
  }

  // Re-sending a failed email: the same code from its box, while the box lives. Nothing new is
  // minted, and once the code is redeemed (or the box expires) there is nothing to re-send.
  function redeliver(input, ctx = {}) {
    const at = now();
    const { unitId } = input || {};
    if (!isStr(unitId, ID)) return { result: 'invalid_request' };
    return store.transaction(() => {
      const row = store.getCodeByUnit(unitId);
      if (!row) return { result: 'not_found' };
      if (row.state !== 'ready') return { result: 'delivery_unavailable', reason: row.state };
      const box = store.getBox(row.id);
      if (!box) return { result: 'delivery_unavailable', reason: 'missing' };
      if (at >= box.expiresAt) {
        store.deleteBox(row.id);
        return { result: 'delivery_unavailable', reason: 'expired' };
      }
      let code;
      try { code = unseal(box); } catch { return { result: 'delivery_unavailable', reason: 'unreadable' }; }
      if (codes.hmac(keys.codeSecret, code) !== row.hmac) return { result: 'delivery_unavailable', reason: 'unreadable' };
      event('code.redelivered', { requestId: ctx.requestId, unitId, codeId: row.id }, { suffix: row.suffix });
      return { result: 'ok', unitId, code: codes.format(code), suffix: row.suffix, expiresAt: box.expiresAt };
    });
  }

  // Refund or cancellation of one unit. An unredeemed code is revoked (and can never be redeemed
  // or become ready again); a redeemed one stays 'redeemed' and its license is revoked instead.
  function revokeUnit(input, ctx = {}) {
    const at = now();
    const { unitId, reason = 'refund' } = input || {};
    if (!isStr(unitId, ID) || !isStr(reason, REASON)) return { result: 'invalid_request' };
    return store.transaction(() => {
      const unit = store.getUnit(unitId);
      if (!unit) return { result: 'not_found' };
      const order = store.getOrder(unit.orderId);
      const row = store.getCodeByUnit(unitId);
      const ids = { requestId: ctx.requestId, paymentId: order.paymentId, orderId: order.id, unitId, codeId: row.id };
      if (store.refundUnit(unitId, at)) event('unit.refunded', ids, { reason });
      if (store.revokeCode(row.id, at)) {
        store.deleteBox(row.id);
        event('code.revoked', ids, { reason, suffix: row.suffix });
      }
      const license = store.getLicenseByCode(row.id);
      if (license && store.revokeLicense(license.id, at)) event('license.revoked', { ...ids, licenseId: license.id, ownerId: license.ownerId }, { reason });
      return {
        result: 'ok', unitId, codeState: store.getCode(row.id).state,
        licenseState: license ? store.getLicense(license.id).state : null,
      };
    });
  }

  const purgeExpired = () => store.transaction(() => store.purgeExpired(now()));

  return {
    publicKey, challenge, verify, redeem, recover, refresh, releaseDevice,
    createOrder, redeliver, revokeUnit, purgeExpired,
  };
}

module.exports = { createService, DEFAULTS, DEFAULT_PLANS };
