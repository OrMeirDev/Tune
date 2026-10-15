# Working on Tune

Tune is a Windows driver updater and PC optimizer: Electron (main process + preload), a React
renderer, and a LocalSystem background service (`service/TuneService.cs`). Green brand, English and
Hebrew (RTL).

## Product rules

- Drivers come only from official, verified sources; nothing is installed without a deliberate click.
- CPU/GPU monitoring is read-only. Never touch coolers, fan or motherboard controllers, or power supplies.
- Machine changes go through the fixed operations in `electron/privilege/operations.cjs` / the service;
  no arbitrary scripts from the renderer.
- Elevated code never runs from, writes to or loads modules from a place a user can write: elevated
  PowerShell gets its script on the command line, answers over its own pipe, and loads modules only
  from `$PSHOME` (`privilege/elevated.cjs`); the service is installed into a protected Program Files
  folder and checked there against the manifest built with this version. The service changes the PC
  only for members of the local Administrators group; read-only requests stay open. It runs an
  operation only once it is contained in a job object (created suspended, then assigned, then resumed)
  and starts no other change until an end is confirmed.
- The app sends a change to the service only when it answers the version this app was built with
  (`privilege/service-version.cjs`); an older, unverifiable or missing service means Windows' prompt
  (the admin session), and a request that may have run is never sent a second time
  (`privilege/service.cjs`). Raise the version with every change to the service.
- The window is untrusted: every request is checked in `electron/ipc/` (sender, argument shape), and
  actions carry only an ID of something the main process found itself; never a URL, hash, path or
  descriptor from the window. A new IPC channel goes in `ipc/channels.cjs` with its argument rules.
- A result the app couldn't check is shown as unchecked, never as fine (see `src/domain/scan-verdict.mjs`).

## Structure (renderer, `src/`)

| Folder | Owns | May import |
| --- | --- | --- |
| `App.jsx` | App shell: state, scan orchestration, navigation | everything below |
| `app/` | pages and sidebar groups | – |
| `features/<area>/` | one area's page and its parts (updates, hardware, diagnose, overview, cleanup, startup, performance, sensors, diagnostics, guides, bios, history, license, settings) | `components/`, `presentation/`, `domain/`, `api.js`, `i18n.js`, non-page modules of other features |
| `components/` | shared presentation (progress, banners, scan result) | `presentation/`, `domain/`, `i18n.js` |
| `presentation/` | formatting helpers | `i18n.js` |
| `domain/` | pure rules (no React, no Electron) | `domain/` only |
| `api.js` | the preload bridge (`window.tune`) | – |

Rules, enforced by `tests/architecture.test.cjs`: only `main.jsx` imports `App.jsx`; `domain/` is
pure; `components/` and `presentation/` never import `features/` or the shell; a feature never imports
another feature's page; the renderer never imports Node/Electron modules; no import cycles.

The shell's state lives in hooks: `app/useScanResults.js` (scan results, full and drivers-only
scans, the last launch's cache, whether each check answered), `app/useOperations.js` (one action at
a time, progress, the result banner), `app/useCommands.js` (what each button runs).

## Structure (main process, `electron/`)

| Folder / file | Owns | May require |
| --- | --- | --- |
| `main.cjs`, `preload.cjs` | windows, IPC, the bridge | `system.cjs`, `report.cjs`, `oem-bios.cjs`, `measure-store.cjs`, `licensing/index.cjs` |
| `ipc/` | every request from the window: who may send it (`guard.cjs`), its exact arguments and what it runs (`channels.cjs`), and what the main process found itself (`offers.cjs`) | `ipc/` only (operations are injected) |
| `system.cjs` | facade: the one interface `main.cjs` uses (same exports as before the split) | everything below |
| `features/` | hardware, drivers, gpu-drivers, bios, cleanup, startup, sensors, measurements, recommendations, restore | `infra/`, `domain/`, `privilege/` |
| `privilege/operations.cjs` | the fixed admin operations (PowerShell bodies) — the only code ever elevated | – |
| `privilege/service.cjs`, `privilege/admin-session.cjs` | the LocalSystem service (install, update side by side with rollback, removal) and the UAC admin session that run those operations | `infra/`, `privilege/` |
| `privilege/elevated.cjs`, `privilege/pipe.cjs` | starting elevated PowerShell from the command line alone; the one-request-per-connection pipe protocol the service and the elevated helpers speak | `infra/`, `privilege/` |
| `privilege/service-version.cjs` | the service's version, compiled into `service/TuneService.cs` by `scripts/build-service.cjs` (which also writes the file manifest, and signs the service when a certificate is configured) | – |
| `infra/` | running PowerShell, downloading files | Node only |
| `domain/` | pure rules: recommendation policy, vendor guidance with sources (`advice-rules.cjs`), version compare, measurements and their comparison (`measurement-policy.cjs`) | `domain/` only |
| `licensing/` | the licensing client that ships: config, API requests, DPAPI storage, identity and device key, certificate checks and licence state, entitlements, the flows (`client.cjs`); `index.cjs` puts them together for `main.cjs` | `licensing/`, `infra/` (never `features/`, `privilege/`, `ipc/`) |

Also enforced by `tests/architecture.test.cjs`: `domain/` is pure; `infra/` and `privilege/` never
require `features/`; no require cycles. `report.cjs` (exports), `oem-bios.cjs` (OEM BIOS
catalogs) and `measure-store.cjs` (the local measurement history) sit next to `main.cjs`.

## Diagnosis and measurements

- The "fix a problem" page (`src/features/diagnose/`) judges with `src/domain/diagnosis.mjs`: a cause
  is "possible", a reading is "measured", a check that couldn't run is "not checked"; never "solved"
  while a check is missing.
- Measurements are taken by the main process itself (`measure:take` names only the kind). A before and
  an after are compared only when taken the same way (`electron/domain/measurement-policy.cjs`);
  otherwise both are shown and nothing is credited. Monitoring stays read only.

## Licensing

- `licensing/` (top level) is the licensing **server** proof of concept. It is never packed into the
  installer and nothing in `electron/` requires it. What both sides share (certificate format and
  check, device keys, Serial typing) lives in `electron/licensing/` and the server re-exports it.
- `electron/licensing/` is the **client** in the main process. Tokens, the device private key and
  certificates stay there; the window gets summaries through the `license:*` channels.
- Shipped defaults: no licensing server, entitlement policy `open` (nothing is gated). Don't change
  them without the owner's commercial decisions (docs/roadmap). `TUNE_*` licensing variables work in
  unpackaged builds only.
- Entitlements are enforced in `ipc/channels.cjs` (the gate) before an action runs; never rely on
  hiding a button. Recovery, exports, history, restore points and settings are never gated. A licence
  is never a Windows administrator right.
- Private keys are never stored without DPAPI; a licensing failure never deletes settings, history or
  the licence file, and never interrupts a running action.

The plan and the status of every task: `docs/roadmap/`.

## Commands

- `npm test`: unit and architecture tests (`node --test`, no Electron or Windows needed)
- `npm run build`: renderer build
- `node --check electron/*.cjs`: main-process syntax
- `node --test "licensing/**/*.test.cjs"`: the licensing server PoC alone (also part of `npm test`)
- `npm run e2e:<name>`: the real app with a display (`e2e/README.md`); `e2e:licensing` needs Node 22+ on PATH
- CI (`.github/workflows/ci.yml`) runs the Windows checks on disposable runners, including the packaged
  build, the installer and the service; what still needs a person: `docs/windows-validation.md`

## Safety while developing

- Never run machine-changing operations (driver installs, cleanup, startup changes, restore points,
  service install) on a real PC to test a change; use mocks, or a disposable Windows VM.
- Test harnesses must refuse the service pipe (`\\.\pipe\TuneService`) except for the read-only
  `version` and `sensors` requests. The CI scripts in `scripts/ci/` that change the machine refuse to
  run outside a GitHub Actions runner; there they may also ask the service for a change that changes
  nothing (`clean` with no categories) to check who may ask, and run a console copy of the service
  with a test `ops.ps1`. Fault injection exists only in a test build of the service
  (`build-service.cjs --test-faults <folder>`, `/define:TUNE_FAULTS`), never in what ships.
- Publishing a release needs the owner's explicit go-ahead.

## Audit and roadmap

The 2026-10-14 audit's findings and their status: `docs/audit/`. The product and licensing plan's
tasks and their status: `docs/roadmap/`.
