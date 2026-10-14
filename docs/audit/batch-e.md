# Audit batch E: hardening that can be proven here

Branch: `audit/batch-e` (on top of batch D).

| ID | Change | Evidence |
| --- | --- | --- |
| – | Every PowerShell script Tune generates is parsed by PowerShell's own parser in `npm test` (13 scripts: scans, user actions, the admin operations, the service's `ops.ps1`, the admin helper) | a deliberately broken script is caught with its line number |
| TUN-16 | Memory speed: below the speed the stick reports is certainly too slow; otherwise, without a readable part number, "unknown" (was "fine") | characterization test updated on purpose |
| TUN-13 | `downloadFile`: overall deadline, stall limit, size ceiling, no redirect to http, write to `.part` and rename when complete and verified, disk errors returned; `runPS`, the admin session, `runElevated` and `rstrui` handle a failed process start; OEM CAB extraction async with a time limit | `tests/resilience.test.cjs`: 8 failure cases leave no file; missing PowerShell → error result |
| TUN-14 | An OEM catalog value is used as SHA-256 only if it is 64 hex characters (Lenovo names it "CRC"); otherwise no hash → download refused, never a false match | test |
| TUN-15 | Cleanup walks folders itself and never enters a junction or symbolic link; Windows Update's download cache is skipped while TiWorker / TrustedInstaller / MoUsoCoreWorker run, and the user is told | `tests/cleanup-containment.test.cjs` runs the real cleanup operation on a throwaway folder with a junction to an outside file. Note: PowerShell 5.1 on the test PC did not follow the junction with the old code either, so the escape was not reproducible; the guarantee is now explicit and version-independent |
| TUN-11 | Restore point outcome: created / recent (a point from the last 24 h, checked by its date) / unavailable; the manual button no longer says "one exists" when none does | parse test (running it needs admin) |
| TUN-18 | `DialogFrame`: dialogs announced to screen readers, Escape and outside click close, focus moves in, Tab stays inside, focus returns; switches `role="switch"` + `aria-checked`; banner and progress announced; `THIRD_PARTY_NOTICES.md` in the installer | real app: role/label/focus checked, Escape closes |
| TUN-07 | Electron 33.4.11 → 44.7.2, electron-builder 25.1.8 → 26.15.3, pinned. Breaking changes 34–44 reviewed (none affect Tune) | audit critical 1→0, high 14→1 (Vite dev server); all checks on Electron 44; packaged build: page from `app.asar`, IPC answers, malformed request refused, CSP present |
| TUN-08 | `.github/workflows/ci.yml`: tests, build and main-process syntax on Windows for every push/PR | runs on the next push |
| – | Service version 5 → 6, so installed services get the new `ops.ps1` (cleanup containment, restore outcome) through Tune's existing "update the service" prompt. The C# code is unchanged | `service/bin/ops.ps1` contains the new scripts |

Pending by hand: NVDA and DPI passes (TUN-18); a real restore point and cleanup through the
service on a VM; the next service update (voltage source, TUN-01/02/06/12 per the plan).
