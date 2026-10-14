# Working on Tune

Tune is a Windows driver updater and PC optimizer: Electron (main process + preload), a React
renderer, and a LocalSystem background service (`service/TuneService.cs`). Green brand, English and
Hebrew (RTL).

## Product rules

- Drivers come only from official, verified sources; nothing is installed without a deliberate click.
- CPU/GPU monitoring is read-only. Never touch coolers, fan or motherboard controllers, or power supplies.
- Machine changes go through the fixed operations in `electron/system.cjs` / the service; no
  arbitrary scripts from the renderer.
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

Main process (`electron/`): `main.cjs` (windows, IPC), `system.cjs` (Windows operations),
`advice-rules.cjs` (pure vendor-guidance rules with source and review date), `report.cjs` (exports),
`oem-bios.cjs` (OEM BIOS catalogs).

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
