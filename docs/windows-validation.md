# Windows validation: what CI proves, and what still needs a person

CI (`.github/workflows/ci.yml`) runs on GitHub's `windows-latest` runners: a fresh, disposable
Windows VM for every job, signed in as an administrator, with no UAC prompts. That makes it the
disposable VM the audit asks for: the jobs that change the machine run only there (each script
refuses to run outside `GITHUB_ACTIONS`). It runs on every push to `main` and `claude/**` and on
every pull request.

## What runs automatically

| Job | Check | What it proves |
| --- | --- | --- |
| test | `npm audit --audit-level=moderate`, `npm test` (Windows) | unit, architecture, IPC and licensing tests, plus the two Windows-only ones: every generated PowerShell script parses (including the elevated admin helper and the install/removal scripts), and cleanup never follows a junction |
| e2e | `e2e:smoke`, `e2e:celebration` | every page, keyboard dialog flow, startup switches, one chime per completed scan; temporary profiles and service stand-ins |
| e2e | `e2e:licensing` | activation, renewal deferrals, an outage, release and recovery, the clock set back and corrected, Hebrew RTL, in the real app with **real DPAPI and the runner's own machine id** (MachineGuid + SMBIOS UUID read through PowerShell); `license.bin` holds nothing readable |
| e2e | `e2e:licensing-startup` | licensing at start (WIN-R01), five new-profile starts of the real app: three timed (how long the licence row and this PC's identity read take while the app's own start-up scans run, printed), one where the identity answers after 20 s (the row must not wait), one where it fails (reported as unavailable); one identity read per start |
| e2e | `e2e:ipc-probes`, `e2e:layout`, `e2e:scan-failure` | the locked window→main connection; layout in English and Hebrew at 980×640 and 1347×852, Settings card included; failed scans never shown as fine |
| e2e | `e2e:service-update` | an older background service (WIN-R03), with a stand-in for the service pipe, the admin session and the installer (nothing reaches a real pipe or prompt): the notice, Later remembered across a reload, a cancelled, a failed and a successful update in Settings, a change requested straight from the window never reaching the old service, Hebrew right to left |
| package | `npm run dist` + `scripts/ci/packaged-check.cjs` | what the installer packs (never the licensing server, tests or docs); the packaged app ignores every `TUNE_*` licensing override (not open, DPAPI storage, open policy); the service manifest is packed and matches the shipped service files; Tune.exe, TuneService.exe and the installer carry valid signatures (a throwaway certificate, audit TUN-09) |
| package | `scripts/ci/dpapi-users-check.ps1` | real Electron safeStorage and the actual licensing store across two real Windows accounts; a synthetic licence decrypts for its owner, is unreadable for the second account and remains byte-for-byte intact |
| package | `scripts/ci/service-journal-check.cjs` | real service console copy with a unique test pipe and stand-in operations: disconnect after start, recover per-driver/restore/reboot result, no duplicate execution, reject a changed request with the same ID, preserve completion across restart, report interrupted/missing outcomes as unconfirmed |
| package | `scripts/ci/service-deadlines-check.ps1` | TUN-06 on a console copy of the built service: a silent or half-sent client is dropped after about 5 s; a hung operation is ended with its child process and answered `timedOut`; meanwhile `version` is answered at once and a second change hears `busy` |
| package | `scripts/ci/service-containment-check.ps1` | WIN-R02 on console copies of a test build of the service (fault injection compiled in only there): job creation, configuration, assignment and resume made to fail (refused, the operation never ran, nothing left); the assignment delayed 3 s (the process waits suspended, so the child it starts at once ends with it); a termination refused twice (`timedOut` with stopped false and the processes still in the job named, which really still run; the next change hears `busy`; at the one after, the service ends the job, confirms it and runs the change) |
| package | `scripts/ci/admin-session-check.cjs` | TUN-02: the admin session starts elevated from the command line alone (no script in `%TEMP%`), answers over its own pipe, runs the fixed operations (two that change nothing), refuses others, and stops when asked |
| package | `scripts/ci/installer-check.ps1` | silent install; the service as LocalSystem in its own version folder in Program Files, writable only by administrators and SYSTEM, every file matching the manifest, validly signed; TUN-01: an administrator may ask for a (no-op) change, a new standard user may not (`notAllowed`) but may ask `version`; that standard user reaches an elevated helper whose pipe names its account (with Windows' over-the-shoulder prompt the helper runs as the administrator who signed in), and not one that names nobody; TUN-02: a service file changed in the per-user folder is refused and the running service is untouched; TUN-12: an update installs side by side and keeps the previous version, an update whose service never starts is rolled back (`service-update-check.cjs`); silent uninstall removes Tune and the service |
| upgrade | `scripts/ci/upgrade-check.ps1` | from the published 1.3.1 (its service in the old layout, files directly in the folder): as an automatic update (the installer run with `--updated`, as the updater runs it) the service is left as it was, without a prompt, and updating it as Settings offers moves it to this version's folder and removes the old layout; running the new installer over 1.3.1 by hand sets up this version directly; Tune's data is kept both ways |

## What still needs a person or a real PC

| Check | Why CI can't | How |
| --- | --- | --- |
| Windows 10 and Windows 11 client editions | the runner image is Windows Server (Windows 11 24H2 code base) | run the e2e suite and the installer checks once on each |
| The UAC prompt itself: approve, decline, and a standard user's credentials prompt | runners have no interactive prompt (CI checks what follows the prompt: the helper's pipe admits the standard user's account) | install, use the admin session, decline once; as a standard user, a change asks for an administrator's credentials (the service refuses the standard user, TUN-01) and then works |
| Real hardware: CPU/GPU sensors through PawnIO, the PawnIO driver install | virtual hardware; the driver may not load in a VM | on a real PC: Settings shows the service with PawnIO, the performance page shows live readings |
| Start-up timing (P00): event 100 fields and event 27's boot type, as a standard user and as an administrator, after a full start, a Fast Startup start and a resume | needs real restarts | see the roadmap's "Next steps" |
| Real driver installs from Windows Update | the runner has no devices with offered drivers | only in a disposable VM with real devices |
| Sleep and resume, lock and unlock, a Windows clock change, with Settings open (R01/R07) | no sleep or session switching on a runner | the roadmap's L02 step 5 |
| DPAPI after an actual Windows reinstall | CI checks two user accounts automatically; a Windows reinstall is a separate identity/protection boundary | old files must remain preserved but unreadable; recovery requires the owner/server flow |
| The machine id after a Tune reinstall (same) and a Windows reinstall (changes, by design) | a Windows reinstall | by hand |
| The app's own updater: finding, downloading and starting an update; then the service notice with the real prompt | needs a published release feed (publishing is the owner's call); CI runs the installer the way the updater does, and the notice and routing only with a stand-in service | after the next release, update a 1.3.1 install from the app: the notice names the installed and bundled versions (candidate service 11); Later, then Settings' Update & start with the real prompt (approve, and once declined) |
| Containment of what Windows starts for an operation through its own services (Windows Installer, Windows Update) | those processes are Windows' own, outside the operation's job by design | none needed; documented limit (`docs/audit/STATUS.md`, TUN-06) |
| Accessibility: NVDA, 125/150/200% DPI | needs a screen reader and display scaling | audit TUN-18 |
| The real code-signing certificate, SmartScreen reputation | needs the certificate (the owner's decision 9 in `docs/roadmap/decisions-he.md`) | sign a release with it; the same CI checks then run with the real signer |

Machine-changing checks never run on a real PC (AGENTS.md): only on the CI runner or a disposable VM.

## Candidate 1.4.1

The candidate branch is `claude/tune-core-hardening-20261019`. The app version is 1.4.1;
the bundled service contract is 11. This branch is not a release.

- The upgrade CI job uploads `Tune-test-installer-<commit>`: the unsigned setup, blockmap,
  SHA-256 checksum and a test-only notice. A successful upload is not production approval.
- The package job uses a disposable signing certificate trusted on that runner only. Its private
  key never enters the artifacts. Production publication refuses missing/self-signed credentials,
  waits for all four CI jobs on the same commit and validates all three signed executables.
- `B1`: the filtered event-100 query probes log readability when it reports no matches.
  `needsAdmin` means access denied; `none` requires a readable/empty log. Tests execute the real
  PowerShell collector with read-only query stand-ins. The owner-supplied local validation of
  f6c6fba also confirms the denied path on a filtered administrator token.
- `B3`: service-update screenshots wait for painting, bound capture time and retry recognized
  UnknownVizError failures only; exhaustion still fails the test. Re-run on the physical desktop
  that showed the intermittent capture failure; CI success alone cannot establish that it is gone.
- Sensors: wait more than 10 seconds after disconnect/stalling the read and confirm old values
  disappear. Requested VID must not be labelled measured core voltage. CPU/GPU reads stay read-only.
- Firmware applicability tests use synthetic catalogs. Check a representative ASUS, Dell, HP and
  Lenovo model against its manufacturer's actual page before trusting a new model/family. Unknown
  matches should offer the official page, never another model's installer.
- Service journal is protected under `Program Files\\Tune Service\\journal`, shared by side-by-side
  versions. The local profile index keeps IDs and outcomes only. After a disconnect, History asks
  status; it never repeats the change. Unknown/interrupted means the result still needs checking.
  At 10,000 records/64 MiB new service mutations stop rather than evicting accepted IDs; an
  administrator must archive evidence before maintenance. Uninstall removes the service root,
  including its journal; the profile's history/index are retained.
- Set main branch protection in GitHub (owner administration): require the four CI job checks and
  review; block force-pushes. The connected GitHub App cannot change that setting.

Product sign-off still needs the client-edition/hardware/UAC/accessibility checks above and the
owner's real signing certificate. Paid licensing additionally needs commercial decisions and a
production service/email/payment setup; the current build keeps no server and the open policy.
