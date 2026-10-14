# Working on Tune

Tune is a Windows driver updater and PC optimizer: Electron (main process + preload), a React
renderer, and a LocalSystem background service (`service/TuneService.cs`). Green brand, English and
Hebrew (RTL).

## Product rules

- Drivers come only from official, verified sources; nothing is installed without a deliberate click.
- CPU/GPU monitoring is read-only. Never touch coolers, fan or motherboard controllers, or power supplies.
- Machine changes go through the fixed operations in `electron/privilege/operations.cjs` / the service;
  no arbitrary scripts from the renderer.
- The window is untrusted: every request is checked in `electron/ipc/` (sender, argument shape), and
  actions carry only an ID of something the main process found itself; never a URL, hash, path or
  descriptor from the window. A new IPC channel goes in `ipc/channels.cjs` with its argument rules.
- A result the app couldn't check is shown as unchecked, never as fine (see `src/domain/scan-verdict.mjs`).

## Structure (renderer, `src/`)

| Folder | Owns | May import |
| --- | --- | --- |
| `App.jsx` | App shell: state, scan orchestration, navigation | everything below |
| `app/` | pages and sidebar groups | – |
| `features/<area>/` | one area's page and its parts (updates, hardware, overview, cleanup, startup, performance, sensors, diagnostics, guides, bios, history, settings) | `components/`, `presentation/`, `domain/`, `api.js`, `i18n.js`, non-page modules of other features |
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
| `main.cjs`, `preload.cjs` | windows, IPC, the bridge | `system.cjs`, `report.cjs`, `oem-bios.cjs` |
| `ipc/` | every request from the window: who may send it (`guard.cjs`), its exact arguments and what it runs (`channels.cjs`), and what the main process found itself (`offers.cjs`) | `ipc/` only (operations are injected) |
| `system.cjs` | facade: the one interface `main.cjs` uses (same exports as before the split) | everything below |
| `features/` | hardware, drivers, gpu-drivers, bios, cleanup, startup, sensors, recommendations, restore | `infra/`, `domain/`, `privilege/` |
| `privilege/operations.cjs` | the fixed admin operations (PowerShell bodies) — the only code ever elevated | – |
| `privilege/service.cjs`, `privilege/admin-session.cjs` | the LocalSystem service and the UAC admin session that run those operations | `infra/`, `privilege/` |
| `infra/` | running PowerShell, downloading files | Node only |
| `domain/` | pure rules: recommendation policy, vendor guidance with sources (`advice-rules.cjs`), version compare | `domain/` only |

Also enforced by `tests/architecture.test.cjs`: `domain/` is pure; `infra/` and `privilege/` never
require `features/`; no require cycles. `report.cjs` (exports) and `oem-bios.cjs` (OEM BIOS
catalogs) sit next to `main.cjs`.

## Commands

- `npm test`: unit and architecture tests (`node --test`, no Electron or Windows needed)
- `npm run build`: renderer build
- `node --check electron/*.cjs`: main-process syntax

## Safety while developing

- Never run machine-changing operations (driver installs, cleanup, startup changes, restore points,
  service install) on a real PC to test a change; use mocks, or a disposable Windows VM.
- Test harnesses must refuse the service pipe (`\\.\pipe\TuneService`) except for the read-only
  `version` and `sensors` requests.
- Publishing a release needs the owner's explicit go-ahead.

## Audit

The 2026-10-14 audit's findings and their status: `docs/audit/`.
