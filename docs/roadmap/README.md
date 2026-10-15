# Product and licensing roadmap

Source: *Tune product and licensing plan* (Hebrew, 2026-10-14). The plan's IDs are used as is:
`PF01`–`PF08` are the user features, `LC01`–`LC14` the licensing requirements, `P00`–`P07` and
`L00`–`L05` the development tasks. The phases are an order of priority and dependency, not release
dates. Prices, licence length, paid features, trial and existing users are still open business
decisions (see the end).

## Status

| Task | What | Status |
| --- | --- | --- |
| P00 | Measurement infrastructure | **Step one done**: what a measurement is, how it is stored, when two may be compared |
| P01 | Diagnosis by problem + before/after (PF01, PF02) | **Step one done**: three problems, findings, before/after panel, history |
| P02 | Smart startup management (PF03) | Not started; needs P00/P01 (boot timing per start is in place) |
| P03 | Software updates through WinGet (PF04) | Not started; WinGet feasibility first |
| P04 | Storage analysis (PF05) | Not started |
| P05 | Game session recording (PF06) | Not started; PresentMon feasibility first |
| P06 | Profiles (PF07) | Not started; needs P01, P02 |
| P07 | Upgrade advice (PF08) | Not started; needs P01, P05 |
| L00 | Licence policy and choice of service | Open decisions (below) |
| L01 | Server and one-time redemption | **Proof of concept completed**: `licensing/` (not shipped in the installer); run `node --test "licensing/**/*.test.cjs"` |
| L02 | Activation and recovery inside Tune | **Implemented and repaired after three reviews (R01–R08), Windows validation pending**: main-process client, renewal while Tune runs, confirmed release, Settings flow in English and Hebrew, entitlement mechanism (shipped policy: open). Verified off Windows with a DPAPI stand-in; the Windows steps below are not done yet |
| L03 | Admin and manual sale | Not started (the PoC has the admin issuing call only) |
| L04 | Automatic payment | Not started; needs a payment provider |
| L05 | Self-service recovery | Not started (L02 recovers on the same PC; moving to another PC needs a release, which only the server API offers) |

Separate work, not part of L01 or L02: payment and webhooks (L04), real email delivery (the PoC
writes owner codes to an outbox table), an admin UI (L03), and production infrastructure (hosting,
the database, key management, monitoring). No build points customers at the PoC server.

The audit's privileged-boundary findings (2026-10-15, [`docs/audit/STATUS.md`](../audit/STATUS.md)):
TUN-01, TUN-02, TUN-06 and TUN-12 are fixed and validated on disposable Windows CI runners; TUN-09
(signing) stays open until there is a certificate (the pipeline is ready, decision 9 in
[`decisions-he.md`](decisions-he.md)). Licensing changes none of them: a licence grants no Windows
administrator rights.

**Windows validation** now runs in CI on every push ([`docs/windows-validation.md`](../windows-validation.md)):
the real app with real DPAPI, the packaged build, the installer and the service. That document lists
what still needs a person or a real PC.

## Step one: what was built

### P00: measurements (`electron/domain/measurement-policy.cjs`, `electron/measure-store.cjs`, `electron/features/measurements.cjs`)

- **Fields** (PF02.1): every measurement records its metric, value (or `null` with the reason it
  couldn't be taken), unit, time, method, and the conditions it was taken under. A start of Windows
  records its kind (full start, Fast Startup, resume from hibernation) and when it began.
- **What is measured now**, all read only:
  - free space on the system drive, right before and right after a cleanup (file system, no PowerShell);
  - the PC at rest: CPU load, CPU temperature (from the service's read-only `sensors` request) and
    memory in use, a reading every 2 s for 20 s, stored as medians; a busy PC is stored as *busy*
    and never compared with rest measurements;
  - Windows' own start-up timing (Diagnostics-Performance event 100: power-on to desktop, desktop to
    settled), each paired with the kind of start (Kernel-Boot event 27); Fast Startup and the system
    drive's media.
- **Comparison rules** (PF02.2): a before and an after are compared only when taken the same way
  (same method; both at rest; starts of the same kind; the same drive); otherwise both values are
  shown and nothing is claimed. Differences within normal variation are "no measurable change"; a
  change for the worse is shown as worse. Several starts or rest measurements are combined by their
  median. A rest "before" older than a week isn't compared. Each change's measurements are only
  those taken after the previous change to Windows and before the next one (startup, settings,
  drivers, devices, the service); a change with nothing measured in its own window is "not
  comparable", never credited.
- **Only the current read is judged**: when Windows' start-up records can't be read this time, the
  diagnosis says so and shows the last stored start as *historical*, never as "OK". A start's kind is
  taken only from its own Kernel-Boot event (the one written soon after it began, not a neighbouring
  start's); two that disagree leave it unknown.
- **Linked to changes** (PF02.3): history entries now carry an ID; a cleanup stores its before/after
  pair under that ID; a startup change waits for the next start of Windows; a power-plan change waits
  for the next rest measurement. The history page shows what each change measurably did; the
  measurements export as CSV (formula-safe). Everything stays in the profile folder.

### P01: fix a problem (`src/domain/diagnosis.mjs`, `src/features/diagnose/`)

- A new **Fix a problem** page (first in *Optimize*; also reachable from shortcuts on the overview):
  *Windows starts slowly*, *Games don't run smoothly*, *The PC gets hot* (PF01.1). Each runs the
  checks that fit, from the scans and sensors Tune already has.
- Each finding shows the measurement, a short explanation, how sure it is (**Measured** / **Possible
  cause** / **Not checked**), its likely impact, and one action: open the right page, apply a setting
  Tune already knows how to change, open a BIOS guide, install the service, or check again (PF01.2).
  Findings are ranked by impact (PF01.3).
- A check that couldn't run is *not checked*, never fine; the page says "nothing found, but N checks
  couldn't run" instead of a verdict, and even "nothing found" says the problem may lie elsewhere.
- What each problem's diagnosis can't measure yet is stated on the page (frame times until PF06; each
  startup app's own share until PF03).

### L01: proof of concept (`licensing/`)

See [`licensing/README.md`](../../licensing/README.md): one-time atomic redemption under real
concurrency, idempotent retries, codes stored only as HMAC + suffix, signed certificates, recovery on
the same PC, device release. Not part of the Tune build.

### L02: activation and recovery in Tune (`electron/licensing/`, `src/features/license/`)

What is implemented and tested off Windows:

- **What ships and what doesn't**: the app's licensing client lives in `electron/licensing/` (packed
  with the app); it shares the certificate check, device keys and Serial rules with the server PoC,
  which re-exports them. The server, its database, signing keys, admin token and outbox stay in
  `licensing/`, outside the installer (architecture tests check both).
- **Shipped defaults change nothing**: no licensing server is configured and the entitlement policy is
  `open`, so every feature stays available and Settings says licensing is not open. A development
  build can point at a local PoC server with `TUNE_LICENSING_URL` and `TUNE_LICENSING_PUBLIC_KEY`
  (https, or this PC only); a packaged build ignores every `TUNE_*` licensing variable.
- **Main process only**: networking, the owner token, the pending request, the device private key
  and certificates never reach the window; eight `license:*` channels take what the person typed or
  chose (checked shapes) and return summaries.
- **Requests**: bounded time (connect, wait, read), bounded size, no redirects. No usable answer is
  "unavailable": the server may or may not have carried the request out, so the window says the result
  *isn't confirmed* (never "nothing changed"), and Try again resends the same request (same Serial,
  owner, device key and idempotency key), so an activation the server carried out returns its licence
  and no second one is made.
- **Renewal while Tune runs**: the certificate (7 days) is renewed in the background 12 hours after the
  last successful check, or sooner to renew ahead of its end (2 days before it, but not before half
  the time to it has passed). A certificate that already ends with the licence (its last week) can't
  be extended by renewing, so it isn't renewed ahead of its end: the next check is 12 hours after the
  last one, or at the licence's end if that comes sooner, and never sooner than an hour after a
  success. On the last day that is one check at 12 hours and one at the end, which the server answers
  as ended. Every result plans the next request: no answer is tried again after 1, 2, 4 ... minutes
  (at most an hour apart); an answer that didn't renew (a refusal, a certificate that doesn't
  verify, which never replaces the stored one) after 1, 2, 4 ... hours (at most 12); a server's
  `rate_limited` delay is always waited for (up to 12 hours). That wait, and a minute after the
  previous refresh request, hold for every refresh whoever sends it (the background, "Check now", Try
  again, a request straight from the window): until then the check is answered in Tune with the time
  left ("Too many attempts. Try again in N seconds."), without a request, with the stored licence and
  a pending Try again unchanged and the deadline unmoved. "Check now" never waits for the next
  scheduled renewal, only for those two. A look happens at least every 15
  minutes, when the certificate runs out, and at once on resume or unlock, always against the current
  clock (a clock set back stops renewal and is reported); none of these sends before the planned
  time. One request at a time: "Check now" during a background renewal takes its answer, and its own
  result plans the next one too; any other action starts after it. Timers never keep Tune running and
  stop when it quits. Nothing renews without a server, without a licence, or after a release,
  revocation or end the server confirmed (also once the certificate itself ran out, still checked as
  this PC's, signed, for this install; kept across restarts); a certificate that expired during an
  outage while the licence is fine is renewed once the server answers. The Settings row updates by
  itself after a renewal and whenever the clock alone changes the state (set back, corrected, a
  certificate running out), once per change.
- **Release**: when the server confirms this PC's seat was released (the owner moved the licence), the
  release is stored (protected), survives a restart, shows as *released* in English and Hebrew, and
  under an enforcing policy refuses new gated actions (open policy, running actions, data, exports and
  recovery are unaffected). Only this PC's binding changes; the licence and other PCs don't. It becomes
  active again only through a recovery the server approves, with a certificate that verifies. A PC
  that never got the answer (offline) follows its signed certificate. "Check now" shows its result in
  the row.
- **Storage**: one file encrypted with DPAPI (Electron `safeStorage`); no plaintext fallback (without
  protection nothing is activated); an unreadable file is kept, never deleted; a failed write leaves
  the licence valid for the session and Tune usable.
- **Certificates**: verified against the trusted public key when received and again on every load
  (signature, format, plan fields, this PC, this install's key, expiry, policy version). An answer
  that doesn't verify never replaces the stored licence. A valid certificate follows its signed
  expiry during an outage. A clock earlier than the protected last-seen time is reported as such.
- **Recovery** brings back the owner's licence on this PC after a reinstall; it never releases
  another PC, never redeems a Serial and never buys anything; a full licence is reported as full.
- **Entitlements**: checked in the request layer before any action that uses a feature (drivers,
  BIOS, cleanup, startup, settings changes); the window's buttons are not the enforcement. Recovery,
  exports, history, restore points and settings are never gated, and a running action is never
  interrupted. The `enforce` policy exists for later and for tests; the paid feature list is open.
- **Tests**: `tests/licensing-client.test.cjs` (19, the client against the PoC over real HTTP),
  `tests/licensing-repairs.test.cjs` (14, the first review's regressions on a hand-moved clock and
  timers), `tests/licensing-renewal.test.cjs` (9, the second review's: renewal planning and notices),
  `tests/licensing-cooldown.test.cjs` (5, the third review's: the wait before any refresh request),
  `tests/e2e-harness.test.cjs` (7, the e2e runner as real processes), IPC bypass attempts in
  `tests/ipc.test.cjs`, wording in `tests/licensing-text.test.cjs`, architecture rules;
  `npm run e2e:licensing` (30 checks, the real app against the PoC, keyboard, Hebrew RTL, an outage
  and retry, a second "Check now" within a minute answered without a request, a confirmed release and
  its recovery, the clock set back and corrected with the open Settings row following without a
  click).

#### Review repairs (2026-10-14)

The review of `38a2a98` found five gaps. Each has a permanent regression that was run against `38a2a98`
(fails) and after the repair (passes), on Linux:

| ID | Gap | Repair | Evidence |
| --- | --- | --- | --- |
| R01 | Renewal ran only at start; a Tune left open let its certificate expire | Background renewal (above): due times, bounded backoff, 15-minute looks, `resume`/`unlock-screen`, one request at a time, unref'd timers disposed at quit, `license:changed` to the window | `licensing-repairs` R01 (8): 7 of 8 fail on `38a2a98`; the 8th (a resume and an unlock during a renewal) was added after a self-review and failed on the first repair (2 requests) before its fix; all pass now |
| R02 | A release the server confirmed (`device_released`) was dropped; the PC kept showing active | Stored as `serverStatus: released` (protected), evaluated as `released`, shown in the row (en/he), gated under `enforce`; a server-approved recovery clears it | `licensing-repairs` R02 (4): 3 fail on `38a2a98`, the offline guard passes by design; `e2e:licensing` step 5 (release on the server → "Check now" shows it, a gated request is refused, recovery → active) |
| R03 | A lost answer was worded "Nothing changed" | "Isn't confirmed" per action in English and Hebrew; `api.cjs` comments corrected; retry unchanged | `licensing-repairs` R03 (2): both fail on `38a2a98`; the redemption is committed, its answer lost, the wording checked, and the retry gives exactly one licence |
| R04 | `e2e:licensing` printed `ALL PASSED` and exited 0 after an unexpected error | `e2e/harness.cjs`: passes only when every step ran with no failure; cleanup always runs and its error never hides the first | `e2e-harness` (7, real processes): 6 fail on `38a2a98` (no runner); the real app with a broken `node` on PATH: before, `ALL PASSED`/exit 0 both with an error before the first check and after five passing ones; after, `1 FAILED (stopped before the end)`/exit 1 |
| R05 | The Settings background-service note was wider than the card (sideways scroll) | The row's text column may shrink (`min-width: 0`) and its notes wrap in the Settings card; no clipping, no smaller type | `e2e:layout` checks the card itself (scroll width, clipped or outside text): 4 fail on `38a2a98` (card 1356–1666 px wide for 674–1005 px visible), all 24 pass now |

The second review (of `bc8d17f`, 2026-10-15) found two more gaps in R01. Same method: each regression
run on `bc8d17f` (fails) and after the repair (passes), on Linux:

| ID | Gap | Repair | Evidence |
| --- | --- | --- | --- |
| L02-R06 | Renewal could plan requests with zero delay: (A) a `rate_limited` answer's delay was dropped, (B) a certificate that didn't verify or a refusal was retried at once, (C) after a success on the licence's last day (a 24 h certificate) "2 days before the end" was already past, (D) a licence the server confirmed as ended read as a merely `expired` certificate once that ran out, so renewal went on | Every result plans the next request (`planAfter`: the server's delay, spaced retries for answers that didn't renew, never a request within a minute of the last); the cadence after a success follows the certificate and the licence's end, never sooner than an hour; a confirmed end is read past the certificate's expiry (re-checked as at its last moment: signature, this PC, this install's key) and stops renewal | `licensing-renewal` R06 (6): all 6 fail on `bc8d17f` (A: next timer 0 ms; B: 4 requests for 1; C: next timer 0 ms; D: state `expired`, not `licenseExpired`); each now asserts request counts, future deadlines, stored state and, for D, a restart, with scheduled timers and repeated wakes |
| L02-R07 | A state the clock alone changed didn't reach the window: `tick` compared two readings taken with the same, already changed clock | The client remembers the state the window was last given and tells it when a look finds another one; the next look is also planned for the moment the certificate runs out; the Settings row drops an earlier "Check now" result when the state changes | `licensing-renewal` R07 (3): 2 fail on `bc8d17f` (active → clock: 0 notices; expiry during an outage: told only by the next renewal attempt), the no-flood guard passes before and after; `e2e:licensing` step 6 on the `bc8d17f` app: the gate already refused but the open row still said "Active." (1 FAILED); after: the row shows the clock message and then "Active." again, without a click (28/28) |

The third review (of `62105d1`, 2026-10-15) found that a person's check bypassed a wait the server had
asked for. Same method, on Linux:

| ID | Gap | Repair | Evidence |
| --- | --- | --- | --- |
| L02-R08 | After a `rate_limited` answer (429, retry after 120 s) the background waited, but "Check now", Try again and a request straight from the window (`license:refresh`, `license:retry`) were sent at once: refresh, wake, refresh, refresh sent 3 requests | One guard where every refresh request is sent (`refreshNow`): not before the server's wait ends, nor within a minute of the previous refresh request. Before that the check is answered locally (`rateLimited`, the seconds left, `deferred`): no request, no attempt recorded, the deadline unchanged, the stored licence and a pending Try again kept. The regular background cadence stays separate: "Check now" doesn't wait for the next scheduled renewal | `licensing-cooldown` (5): 4 fail on `62105d1` (the reviewer's sequence: 3 requests for 1; Try again sent during the wait; a second "Check now" within the minimum gap sent; 6 requests from the window for 1), the manual/background coincidence guard passes before and after (one request); now each asserts request counts, the seconds left, the unchanged deadline up to 1 ms before it, the renewal at it, and the cadence 11 hours on. `e2e:licensing` step 4: a second "Check now" right away shows "Try again in N seconds" with the licence as it was; on the `62105d1` app it sent a request instead (1 FAILED); now 30/30 |

On Windows (2026-10-15): CI runs step 1 on every push (Windows Server runner: `e2e:licensing` with
real DPAPI and the runner's machine id, `license.bin` unreadable), step 4's packaged-build check (the
packaged app ignores `TUNE_*`) and step 6 (`e2e:layout` with the Settings card). Still by hand, on
Windows 10 and 11 clients, as listed below and in [`docs/windows-validation.md`](../windows-validation.md):

1. `npm run e2e:licensing` on each, unpackaged (real DPAPI and the PC's own machine id): all checks
   pass; `license.bin` in the profile holds no readable key or certificate (search it for
   `PRIVATE KEY` and `tune-license`); a confirmed release survives closing and reopening Tune.
2. DPAPI boundaries: copy `license.bin` to another Windows user's profile and start Tune there: the
   licence shows as unreadable and is kept; recovery works for the owner. Turn the PC's network off:
   the licence stays active until its certificate's end, and "Check now" says it couldn't connect.
3. The machine id: `MachineGuid` and the SMBIOS UUID read as a standard user; the same id after a Tune
   reinstall; recovery after deleting the profile returns the same licence.
4. A packaged build (`npm run dist` on a disposable VM): Settings says licensing is not open, and
   setting `TUNE_LICENSING_URL` changes nothing.
5. Renewal on a real PC (against a local PoC server, unpackaged): put the PC to sleep and wake it, and
   lock and unlock it: Electron's `resume` and `unlock-screen` reach the client and one renewal is sent
   when due; change the Windows clock forward and back: forward is seen within 15 minutes, back stops
   renewal and is reported, and an open Settings row follows both without a click (Windows' own clock
   change, not the e2e's main-process clock); Tune quits promptly with renewal timers pending.
6. `npm run e2e:layout` on Windows at 980×640 and 1347×852 (English and Hebrew), including the Settings
   card, with the real fonts and the real service status text.

### Known limits of step one

- **Start-up timing may need admin rights.** Windows often keeps the Diagnostics-Performance log to
  administrators. Tune reads it as the user; when refused, the start-up time is *not checked* (the
  other start-up checks still run). Reading it through the service needs a new read-only service
  operation, which means changing `service/TuneService.cs`'s operation list and testing the service
  upgrade on a VM (see TUN-01/TUN-12). It was left out on purpose.
- The PowerShell for start-up records is parse-checked by `npm test` on Windows (CI) but has not been
  run on a real PC yet; the event fields (`BootStartTime`, `MainPathBootTime`, `BootPostBootTime`,
  event 27's boot type) need one check on Windows 10 and 11.
- Thresholds (45 s to the desktop, 60 s after it, 25% background load, 85% memory) are Tune's own
  judgement; the temperature ones match the existing cooling findings.

## Next steps (in the plan's order)

1. On a real Windows 10 and 11 PC (or a disposable VM for anything that changes the PC):
   - the start-up collector: run Tune as a standard user and as an administrator; confirm event 100's
     fields (`BootStartTime`, `MainPathBootTime`, `BootPostBootTime`) and event 27's boot type are
     read, that a standard user who is refused gets "not checked" (not "OK"), that two starts close
     together each get their own kind (a restart right after a Fast Startup start), and that a startup
     change followed by another Windows change before the next start shows "not comparable";
   - `npm run e2e:layout` (it includes the Fix a problem page and the Settings card), knowing it checks
     layout only, not that start-up collection works (it passed on Linux on 2026-10-14, 24 checks, with
     every Windows scan failing there; the Windows run is still to do);
   - the L02 steps above; then decide whether start-up timing should go through the service (needs a
     service version bump).
2. **P02 / PF03**: per-entry startup impact (measured vs estimated), delayed start for supported entry
   types with undo, protected categories (security, accessibility, backup, sync) never get a blanket
   "turn off".
3. **L00**: the open decisions below. L02's mechanism is in place; turning licensing on for customers
   needs a real licensing service, its public key in `electron/licensing/config.cjs`, and a policy
   other than `open`, all after the owner decides.
4. **L03**: admin panel and a manual first sale; then the trial-sale exit criteria from the plan.

## Open decisions (needed before the first sale)

| Decision | Options or rule |
| --- | --- |
| Model and price | perpetual, term or subscription; price and currency |
| Paid package | what stays free, what the licence and the trial include; how to treat existing users (no blocking without a visible policy) |
| Computers and transfer | proposed: one PC; transfer, reset and tolerance to hardware changes |
| Offline | length of the offline window (7 days proposed), and whether a short overlap after a transfer is acceptable |
| Updates and validity | included versions, major upgrades, renewal; usage validity separate from update entitlement |
| Purchase and support | payment provider, ownership binding, delivery, refunds, recovery path |
| Licensing service | a service such as Keygen behind a small adapter vs an own server (cost, data export, one-time redemption support) |

