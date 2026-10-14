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
| L01 | Server and one-time redemption | **Proof of concept done**: `licensing/` (not shipped in the installer); run `node --test "licensing/**/*.test.cjs"` |
| L02 | Activation and recovery inside Tune | Not started; the certificate check it needs is in the PoC |
| L03 | Admin and manual sale | Not started (the PoC has the admin issuing call only) |
| L04 | Automatic payment | Not started; needs a payment provider |
| L05 | Self-service recovery | Not started |

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

1. Run the step-one checks on a real Windows 10 and 11 PC (`npm run e2e:layout` now includes the new
   page) and confirm the start-up event fields; decide whether start-up timing should go through the
   service (needs a service version bump).
2. **P02 / PF03**: per-entry startup impact (measured vs estimated), delayed start for supported entry
   types with undo, protected categories (security, accessibility, backup, sync) never get a blanket
   "turn off".
3. **L00**: the open decisions below; then **L02** (activation screen in Hebrew and English, licence
   module in the main process using the PoC's certificate check, offline window).
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
