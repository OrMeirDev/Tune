# Audit batch C2: shell hooks and the main process split

Branch: `audit/batch-c2` (on top of batch C). Nothing published or merged. Continues TUN-10.
No logic, text or behavior changed; code moved verbatim with its comments.

## Renderer: the shell keeps only composition

`src/App.jsx` 256 → 134 lines (1,191 before batch C).

| Hook | Lines | Owns |
| --- | --- | --- |
| `app/useScanResults.js` | 96 | scan results, full and drivers-only scans, per-area reloads, last-launch cache, check states |
| `app/useOperations.js` | 34 | one action at a time, progress events, the result banner, `lockWhile` |
| `app/useCommands.js` | 43 | what each button runs and what it reloads afterwards |

## Main process: `electron/system.cjs` split by responsibility

`system.cjs` 1,025 → 27 lines: a facade with exactly the same 29 exports, so `main.cjs`, the
service build script and test harnesses that replace `sys.*` are unchanged.

| Module | Lines | Owns |
| --- | --- | --- |
| `infra/powershell.cjs` | 41 | running PowerShell as the user (`runPS`) |
| `infra/download.cjs` | 35 | HTTPS downloads with progress and SHA-256 |
| `domain/versions.cjs` | 12 | version compare |
| `domain/recommendation-policy.cjs` | 114 | power plan, memory channels/speed, `advise` (pure) |
| `domain/advice-rules.cjs` | 28 | vendor guidance with source/review date (moved from `electron/`) |
| `features/hardware.cjs` | 23 | hardware scan |
| `features/drivers.cjs` | 19 | Windows Update drivers, install, enable device |
| `features/gpu-drivers.cjs` | 92 | AMD/NVIDIA drivers, signer check |
| `features/bios.cjs` | 91 | BIOS catalogs and download |
| `features/cleanup.cjs` | 33 | leftover files |
| `features/startup.cjs` | 27 | startup apps |
| `features/sensors.cjs` | 106 | live readings, CPU & memory |
| `features/recommendations.cjs` | 55 | reading settings, applying the ones Tune can change |
| `features/restore.cjs` | 14 | restore points |
| `privilege/operations.cjs` | 151 | the fixed admin operations (the only elevated code) and their shared scripts |
| `privilege/admin-session.cjs` | 126 | UAC admin session |
| `privilege/service.cjs` | 165 | the LocalSystem service: calls, status, install/remove |

Splitting surfaced the one real coupling: the service and the admin session build their scripts from
the operations, while the features call the service. The operations now sit in their own catalog
(`privilege/operations.cjs`) that both read, so dependencies run one way. This is also the natural
place for the fixed operation IDs the audit asks for in TUN-02 / TUN-05.

## Commands and results

| Check | Result |
| --- | --- |
| `npm test` | 29 pass (+3 main-process architecture rules, +6 recommendation characterization tests) |
| `npm run build`, `node --check` on every `electron/**/*.cjs` | pass |
| Facade exports vs. before the split | same 29 names, all defined |
| Generated service script (`ops.ps1`) vs. before the split | identical (9,318 chars); `SERVICE_VERSION` 5 unchanged |
| `advise()` on fixtures vs. before the split | identical |
| Every page in the real app (service pipe refused) | 9 pages + guide, 0 renderer errors; real read-only recommendation checks ran through the new modules |
| Scan-failure run, overlap test (16/16), celebration test | unchanged |

## Pending

- The elevated paths (`installService`, `runElevated`, the admin session, service calls that change
  the PC) moved without changes but were not executed: they need a disposable Windows VM.
- Known gap pinned by a test, for TUN-16: an unreadable memory part number makes the speed "fine".

## Next

- TUN-05: typed IPC in `main.cjs` (sender check, payload schemas, descriptors held in main by ID).
- TUN-16: diagnostic policies return facts + confidence; unknown stays unknown.
- TUN-01/02/06 (service authorization, protected broker, deadlines): design can start; validation needs a Windows VM.
