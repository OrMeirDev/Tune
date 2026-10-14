# Tune licensing server: proof of concept

Proves step one of the licensing plan: **a Serial is redeemed exactly once, atomically, into one
license, and the license can be recovered on the same PC.** Node 22, CommonJS, no npm
dependencies (`node:crypto`, `node:sqlite`, `node:http`, `node:test`).

This folder is **not shipped inside the Tune installer**: electron-builder packs only `dist/**`,
`electron/**` and `package.json`. The pieces both sides need live in the app's packaged client
folder, `electron/licensing/`: the certificate format and check (`certificate.cjs`), device keys and
signed requests (`device-keys.cjs`) and how a Serial is typed (`serial.cjs`). They need only
`node:crypto`; this folder's `certificate.cjs` and `device.cjs` are one-line re-exports of them, and
`codes.cjs` takes its typing rules from `serial.cjs`, so the server and the app can't drift apart.
Nothing here (database, signing keys, admin token, outbox) is in the app.

## Run

```
node --test "licensing/**/*.test.cjs"     # the licensing suite (about 1-2 s)
npm test                                  # the whole repo, licensing included
```

On Node 22, `node --test licensing/` does not work: a directory argument is loaded as a module,
not searched. Use the quoted glob above; the quotes let Node expand it the same way on Windows
and Unix shells. `node:sqlite` prints an `ExperimentalWarning` on Node 22, which is expected.

To run a development server: `node licensing/server.cjs`. `TUNE_LICENSING_DB` and
`TUNE_LICENSING_KEYS` name the database and the key file (a fresh key file is created if
missing); `PORT` defaults to 8787 and `HOST` to 127.0.0.1. Both files default to the OS temp
folder and are for development only.

## What it proves

| Claim | Plan | Test |
| --- | --- | --- |
| 8 processes redeem the same codes at the same moment on one SQLite file: exactly one license per code, all others `already_redeemed`. The same over HTTP, with 3 server processes on one database. | LC05, LC06 | `race.test.cjs` |
| Redemption, license, device binding, idempotency record and removal of the delivery box happen in one `BEGIN IMMEDIATE` transaction. The code moves out of `ready` through a conditional `UPDATE ... WHERE state = 'ready'` (exactly one change), and UNIQUE constraints back it up. Any failure rolls back. | LC05, LC06 | `race.test.cjs`, `redeem.test.cjs` |
| A code never returns to `ready`: not after a refund, not via a direct SQL write (triggers). Codes and licenses are never deleted. | LC06 | `redeem.test.cjs` |
| A retry after a lost response, with the same idempotency key, owner and device, gets the same license. The same key from another owner, device or code gets `idempotency_conflict` and nothing else. | LC07 | `redeem.test.cjs`, `http.test.cjs` |
| Failures are distinguished: `invalid_code`, `code_revoked`, `already_redeemed`, `owner_mismatch`, `device_limit`, `license_inactive`, `rate_limited`. `already_redeemed` reveals nothing about the other customer; only the license's own owner is told which license it is (`yours: true`). | LC04 | `redeem.test.cjs` |
| Failed attempts are rate-limited per client address and per owner. | LC05 | `redeem.test.cjs` |
| A direct sale can be redeemed only by its verified purchaser (order email). A reseller code goes to the first verified owner who redeems it. | LC01 | `redeem.test.cjs` |
| Codes are 32 Crockford Base32 characters from a CSPRNG (160 bits, no modulo bias), shown as `XXXX-XXXX-...` (8 groups). Input is normalized: case, spaces and dashes ignored; O becomes 0; I and L become 1. | LC08 | `codes.test.cjs` |
| Only HMAC-SHA256(secret, code) and the last 4 characters are stored. After issuing, redeeming, failed attempts, re-delivery and a refund, the full code is in no table, in no byte of the database files (including the WAL), and in no log line. The log carries the suffix. | LC08 | `http.test.cjs` |
| Re-delivery returns the same code from an AES-256-GCM box while the box is valid. Once the code is redeemed or the box expires, re-delivery returns nothing. | (re-delivery) | `redeem.test.cjs` |
| The signed certificate (Ed25519) is checked offline. Signature, tampered payload, wrong key, expiry, another machine, another device key and a clock rolled back before the issue time are all detected. | LC09, LC11 | `certificate.test.cjs` |
| Refresh needs a request signed by the device's private key, with a recent timestamp that is newer than the last one used. Unsigned, wrongly signed, stale or replayed requests are refused, as is a refresh for a revoked or expired license. | LC11 | `devices.test.cjs` |
| Reinstall on the same PC (verified owner, same machine id, new device key) gets the same license and a certificate for the new key. No new license is created, the code is unchanged, and the old install's key stops working. | LC09 | `devices.test.cjs` |
| Another PC on a 1-device plan gets `device_limit` until the verified owner releases the old device. Then the new PC gets the same license, and the code stays `redeemed`. | LC09 | `devices.test.cjs` |
| The shared client modules in `electron/licensing/` need only `node:crypto`, and this folder only re-exports them; only `store.cjs` touches the database. | | `layout.test.cjs` |

Plan IDs not named above (LC02, LC03, LC10, LC12, LC14) were not part of this step's brief and are
not mapped here.

**Offline PCs (the TTL trade-off).** A certificate already on an old, offline PC keeps working
until it expires, even after the device is released or the order is refunded. The certificate
TTL (default 7 days, `certTtlMs`) sets how long that window lasts. Choosing it is an open business
decision.

## Files

| File | Role |
| --- | --- |
| `codes.cjs` | generate, HMAC, and a log guard that masks anything code-shaped; normalize, format and suffix come from `electron/licensing/serial.cjs` |
| `certificate.cjs` | re-exports `electron/licensing/certificate.cjs`: canonical JSON, `sign`, `verify(cert, serverPublicKey, { now, machineId, devicePublicKey, skewMs })` returning `{ ok, reason }` (reasons: `malformed`, `signature`, `clock`, `expired`, `machine`, `device`) |
| `device.cjs` | re-exports `electron/licensing/device-keys.cjs`: the PC's side: device key pair, machine id (hash of MachineGuid + SMBIOS UUID), signing requests |
| `store.cjs` | SQLite schema and every query (WAL, `busy_timeout`, foreign keys, triggers) |
| `service.cjs` | the rules; each call returns `{ result: 'ok', ... }` or `{ result: '<reason>', ... }` |
| `server.cjs` | the HTTP API, admin token check, request log, dev server entry point |
| `rate-limit.cjs` | fixed-window counters in memory |
| `keys.cjs` | the server's secrets (code HMAC secret, delivery key, signing key, admin token) |

## API

All routes are `POST` and take a JSON body. Clients switch on `result` in the response body; the
HTTP status is only a coarse hint (200 ok, 400 bad input, 401 not authenticated / bad signature,
403 owner mismatch, 404 unknown code or object, 409 state conflicts, 410 delivery unavailable,
413 too large, 429 rate limited). "Server unavailable" (LC04) is the client's own result, for when
no answer arrives.

| Route | Body | `ok` returns | Other results |
| --- | --- | --- | --- |
| `/v1/owner/challenge` | `email` | `challengeId`, `expiresAt`; a 6-digit code is written to the outbox | `invalid_request`, `rate_limited` |
| `/v1/owner/verify` | `challengeId`, `code` | `ownerToken` (30 min), `expiresAt` | `owner_code_invalid` (+`attemptsLeft`), `owner_code_expired`, `too_many_attempts` |
| `/v1/redeem` | `code`, `ownerToken`, `machineId`, `devicePublicKey`, `idempotencyKey` | `licenseId`, `deviceId`, `planId`, `licenseExpiresAt`, `certificate` (+`replayed` on a retry) | `invalid_code`, `code_revoked`, `already_redeemed` (+`yours`, `licenseId` for the owner only), `owner_mismatch`, `idempotency_conflict`, `owner_unverified`, `rate_limited`, `invalid_request` |
| `/v1/recover` | `ownerToken`, `machineId`, `devicePublicKey`, optional `licenseId` | as redeem | `device_limit` (+`deviceLimit`, the owner's `devices`), `license_inactive` (+`status`), `license_required` (+the owner's `licenses`), `not_found` |
| `/v1/license/refresh` | `licenseId`, `deviceId`, `machineId`, `ts`, `signature` | as redeem | `bad_signature`, `stale_request`, `machine_mismatch`, `device_released`, `license_inactive` |
| `/v1/device/release` | `ownerToken`, `deviceId` | `deviceId` (+`alreadyReleased`) | `not_found` |
| `/v1/admin/orders` | `channel` (`direct`/`reseller`), `planId`, `quantity` (1-100), `purchaserEmail` (direct only), optional `paymentId` | `orderId`, `units: [{ unitId, code, suffix }]`: the raw codes, shown this once | `duplicate_payment` (+`orderId`), `invalid_request` |
| `/v1/admin/redeliver` | `unitId` | the same `code`, `suffix`, `expiresAt` | `delivery_unavailable` (+`reason`: `redeemed`, `revoked`, `expired`, `missing`, `unreadable`), `not_found` |
| `/v1/admin/revoke` | `unitId`, optional `reason` | `codeState`, `licenseState` | `not_found` |

Admin routes need `Authorization: Bearer <adminToken>`, a token separate from owner tokens.

**Recovery without a `licenseId`** picks the license this machine already holds, or the owner's
only license. If neither applies, the answer is `license_required` with the owner's own licenses
(plan, status, code suffix).

**Signed refresh.** `signature` is Ed25519, made with the device's private key, over the
canonical JSON of `{ action: 'refresh', body: { licenseId, deviceId, machineId }, ts }`, encoded
base64url. `ts` is the client's time in milliseconds. The request is accepted when
`|server time - ts|` is at most 5 minutes and `ts` is newer than the last accepted request from
that device. A replay inside the window is refused too.

**Certificate.** `{ payload, signature }`. The payload has `format: 'tune-license/1'`,
`licenseId`, `deviceId`, `machineId`, `devicePublicKey` (base64 SPKI DER), `planId`, `features`,
`issuedAt`, `expiresAt` (ms since epoch) and `policyVersion`. The signature is Ed25519 over the
payload's canonical JSON (keys sorted), base64url. `expiresAt` is never later than the license's
own end date. The client keeps only the server's public key.

## Data model

| Table | Holds | Guarantees |
| --- | --- | --- |
| `plans` | `id`, `features` (JSON), `device_limit`, `policy_version`, `license_days` | packages can change without changing the code format |
| `owners` | a verified email | `email` UNIQUE |
| `owner_challenges` | HMAC of the 6-digit code (key derived from the server secret), expiry, attempts, `used_at` | single use: conditional update |
| `owner_tokens` | SHA-256 of the token, owner, expiry | the token itself is never stored |
| `outbox` | the emails "sent" (owner codes only) | stands in for the email provider |
| `orders` | `channel`, `purchaser_email`, `payment_id`, `plan_id` | `payment_id` UNIQUE; a direct sale must have a purchaser |
| `order_units` | one paid unit of an order: `paid` or `refunded` | |
| `codes` | `hmac`, `suffix`, `state` (`ready`, `redeemed`, `revoked`) | `order_unit_id` UNIQUE (one code per unit), `hmac` UNIQUE; triggers allow only `ready` to `redeemed`/`revoked` and forbid deletes |
| `delivery_boxes` | AES-256-GCM of the code; the code id and expiry are the authenticated data | deleted on redemption, refund or expiry |
| `licenses` | `code_id`, owner, plan, `state` (`active`, `revoked`), `expires_at` | `code_id` UNIQUE (one license per code); `revoked` is final; never deleted. "Expired" is derived from `expires_at`. |
| `devices` | `machine_id`, `public_key`, `state` (`active`, `released`), `last_request_ts` | one active device per machine per license (partial UNIQUE index); `released` is final |
| `idempotency_keys` | key, owner, hash of (code HMAC, machine id, device key), license, device | the key only finds an earlier answer for the same owner and request |
| `events` | audit log: type, request id, payment/order/unit/code/license/device/owner ids, detail (state changes, reasons, suffixes) | never the code |

## Design decisions

- **Three guards against a double license**, any one of which is enough: the write lock taken by
  `BEGIN IMMEDIATE`, the conditional update checked by `changes === 1`, and `UNIQUE(code_id)` on
  `licenses`. If the constraint ever fires, the transaction rolls back and the request gets
  `already_redeemed`.
- **The database stays behind `store.cjs`.** The service calls named methods and
  `store.transaction(fn)`, and contains no SQL (`layout.test.cjs` checks this). Transaction bodies
  are synchronous, because SQLite's single connection per process must not interleave requests. A
  Postgres adapter would implement the same methods (with `SELECT ... FOR UPDATE` or the same
  conditional update) and turn the transaction bodies async.
- **Reinstall replaces the device row.** The old row is released (`replaced`) and a new row is
  created for the new key. The seat count stays the same, and the old install can no longer
  refresh.
- **Machine id** is `sha256("tune-machine/1|MachineGuid|SMBIOS UUID")`, computed on the PC. The
  server treats it as 64 opaque hex characters. A random per-install id would change on
  reinstall, which is exactly when the same PC must find its license again.
- **Re-delivery hands the code to the admin caller and never writes it to the outbox.** The outbox
  is a table, and the code must never be in a table. A real delivery worker would pass the code
  straight to the email provider.
- **The 6-digit owner codes are hashed with a key** derived from the server secret. A plain hash of
  a 6-digit number could be reversed instantly from a copy of the database.
- **Plans are read live.** Changing a plan's features or device limit applies to existing licenses
  at their next certificate. `policyVersion` tells the client which rules it received.

## Out of scope / limitations

- Payment provider and webhooks (LC13): `/v1/admin/orders` stands in, and `payment_id` UNIQUE is
  the hook for webhook idempotency. Also out of scope: real email delivery (the outbox table stands
  in), an admin UI, choosing Keygen or our own server, the Postgres adapter, and production key
  management (HSM or secrets manager). There is no key rotation: certificates carry no key id, and
  rotating the code HMAC secret would need a key id on each code row.
- Rate limits live in memory, separately in each process. Several servers would share them in the
  database or a cache. The client address is the socket's; behind a proxy it would come from a
  trusted `X-Forwarded-For`.
- There is no cooldown on releasing devices: an owner can move a seat as often as they like. Limits
  on seat-hopping are a business decision.
- The machine id is computed by the client, so a modified client can lie about it (no hardware
  attestation).
- A revoked license stays revoked (enforced by a trigger). Reinstating one, for example after a
  reversed chargeback, would need an explicit decision.
- Idempotency keys, events and released devices are kept forever (production needs retention
  rules). The owner token travels in the JSON body.
- Not built on the Tune side: storing the device key (DPAPI), clock-rollback detection with a
  last-seen time, the "server unavailable" result, and the UI.
