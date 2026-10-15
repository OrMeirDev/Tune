# Windows validation: what CI proves, and what still needs a person

CI (`.github/workflows/ci.yml`) runs on GitHub's `windows-latest` runners: a fresh, disposable
Windows VM for every job, signed in as an administrator, with no UAC prompts. That makes it the
disposable VM the audit asks for: the jobs that change the machine run only there (each script
refuses to run outside `GITHUB_ACTIONS`). It runs on every push to `main` and `claude/**` and on
every pull request.

## What runs automatically

| Job | Check | What it proves |
| --- | --- | --- |
| test | `npm test` (Windows) | unit, architecture, IPC and licensing tests, plus the two Windows-only ones: every generated PowerShell script parses (including the elevated admin helper and the install/removal scripts), and cleanup never follows a junction |
| e2e | `e2e:licensing` | activation, renewal deferrals, an outage, release and recovery, the clock set back and corrected, Hebrew RTL, in the real app with **real DPAPI and the runner's own machine id** (MachineGuid + SMBIOS UUID read through PowerShell); `license.bin` holds nothing readable |
| e2e | `e2e:ipc-probes`, `e2e:layout`, `e2e:scan-failure` | the locked window→main connection; layout in English and Hebrew at 980×640 and 1347×852, Settings card included; failed scans never shown as fine |
| package | `npm run dist` + `scripts/ci/packaged-check.cjs` | what the installer packs (never the licensing server, tests or docs); the packaged app ignores every `TUNE_*` licensing override (not open, DPAPI storage, open policy); the service manifest is packed and matches the shipped service files; Tune.exe, TuneService.exe and the installer carry valid signatures (a throwaway certificate, audit TUN-09) |
| package | `scripts/ci/service-deadlines-check.ps1` | TUN-06 on a console copy of the built service: a silent or half-sent client is dropped after about 5 s; a hung operation is ended with its child process and answered `timedOut`; meanwhile `version` is answered at once and a second change hears `busy` |
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
| DPAPI across Windows users (`license.bin` copied to another account reads as unreadable and is kept) | possible with the second account the installer check creates; not automated yet | the roadmap's L02 step 2 |
| The machine id after a Tune reinstall (same) and a Windows reinstall (changes, by design) | a Windows reinstall | by hand |
| The app's own updater: finding, downloading and starting an update | needs a published release feed (publishing is the owner's call); CI runs the installer the way the updater does | after the next release, update a 1.3.1 install from the app, then accept the service update in Settings |
| Accessibility: NVDA, 125/150/200% DPI | needs a screen reader and display scaling | audit TUN-18 |
| The real code-signing certificate, SmartScreen reputation | needs the certificate (the owner's decision 9 in `docs/roadmap/decisions-he.md`) | sign a release with it; the same CI checks then run with the real signer |

Machine-changing checks never run on a real PC (AGENTS.md): only on the CI runner or a disposable VM.
