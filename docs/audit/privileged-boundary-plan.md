# Plan: the privileged boundary (TUN-01, TUN-02, TUN-06, TUN-11 journal, TUN-12)

Status: **designed, not implemented**. These change code that runs as LocalSystem or elevated, and
each needs a disposable Windows VM with two accounts to prove both the allowed and the denied
cases. Shipping them untested could leave Tune's background service broken on users' PCs, so they
wait for that environment. Everything here builds on what batches C2–E already put in place.

## What already narrows the boundary (done)

- One catalog of the only elevated code: `electron/privilege/operations.cjs` (fixed operations,
  fixed cleanup roots, startup entries checked against the registry, update IDs as GUIDs).
- The window can no longer choose what an operation acts on (TUN-05): requests carry IDs of what
  the main process found itself.
- Cleanup never enters junctions/symlinks; Windows Update's cache waits while it installs (TUN-15).
- Restore-point outcome verified by date: created / recent / unavailable (TUN-11, outcome part).

## TUN-01: who may ask the service to change the PC

Today: the pipe grants the Interactive SID read/write; any process of the logged-on user can send a
mutation op. Design:

1. **Split the pipe**: `TuneService.Sensors` (read-only ops: version, sensors; Interactive, as now)
   and `TuneService.Ops` (mutations).
2. **Caller check on the ops pipe** (`GetNamedPipeClientProcessId` → process image path +
   Authenticode): accept only `Tune.exe` from its install folder, and only once Tune and the service
   are code-signed (TUN-09) by the same publisher; before signing, a path check alone is weak
   (per-user install folder is user-writable), so the release that enables this must be signed.
3. **Per-operation policy** in the service, not the app: drivers/enable/clean/startup/hags/restore
   each have an allow rule (e.g. `startup` only HKLM entries that exist, `clean` only fixed keys).
4. **Record the caller** (PID, image, user SID) in the journal (TUN-11).
5. Decision for the owner: whether a standard (non-admin) user may run these operations through the
   service at all, or only users in the local Administrators group. Document the choice in README.

VM tests: two accounts (admin, standard); a direct pipe client (PowerShell) from each, from a
non-Tune process, and from Tune → allowed/denied as per policy; denied requests make no change.

## TUN-02: no elevated execution of user-writable scripts

Today: the admin session writes `helper.ps1` to `%TEMP%` and starts it elevated; service install
copies files from the per-user app folder.

1. Start the elevated helper with `-EncodedCommand` carrying a small bootstrap that decompresses an
   embedded, gzip+base64 script (stays under the 32,767-char command-line limit); no script file.
2. Requests to the admin session are signed with an HMAC key passed on that command line (not
   readable by medium-integrity processes); unsigned or replayed requests are ignored.
3. Service install: compute SHA-256 of every file in the bundle at build time
   (`scripts/build-service.cjs` writes `manifest.json`), verify inside the elevated script before
   copying, then set and check ACLs on `Program Files\Tune Service` (Administrators + SYSTEM only).

VM tests: modify the temp helper / a bundle file between preparation and elevation → elevation
refuses; normal install and operations still work.

## TUN-06: deadlines on the pipe and operations

1. Per-connection read deadline (e.g. 5 s for the request line) and request size limit (exists).
2. More listeners for read-only ops than for mutations; a slow client can't block sensors.
3. Operation deadline per op (drivers 30 min, others 5–10 min); on expiry the operation's process
   tree is ended through a Job Object, and the result is recorded as `timed-out`.
4. Operation IDs: the app can ask "status of op X" after a disconnect instead of running it again.

VM tests: a client that connects and never sends; one that sends a partial line; a hung mock op.

## TUN-11: operation journal

The service appends one line per operation to `ProgramData\Tune\journal.jsonl` (ACL: SYSTEM +
Administrators write, users read): op ID, caller, start, end, per-update results, reboot needed,
restore outcome. The app's history reads it, so a closed window or a timeout doesn't lose the record.

## TUN-12: recoverable service updates

1. Install to `Tune Service\v<N>` side by side; switch a `current` pointer (registry value read by
   the service wrapper) only after the new version answers a health check; keep the previous one.
2. On failure: switch back and restart the previous version.
3. Generate the service version from one place (`package.json` → `build-service.cjs` writes
   `Version` into the C# and `SERVICE_VERSION` reads it), so the two can't drift.
4. The uninstaller acts on the service removal's exit code and tells the user if it failed.

VM tests: kill the update mid-copy, block the new exe from starting → previous version keeps
working; uninstall with the service locked → visible, recoverable failure.

## Also waiting for the next service update

- TUN-16 (sensors): the service reports which reading the CPU voltage came from (`core` vs `VID`)
  so the UI can label it; today a VID fallback looks like a measured voltage.
