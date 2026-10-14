# Audit batch D: the window → main process connection (TUN-05)

Branch: `audit/batch-d` (on top of batch C2). Nothing published or merged.

## Finding, revalidated

TUN-05 was still present: every one of the 40 IPC channels ran whatever arrived, from any sender,
and the actions took their details from the window: the GPU installer URL, the whole BIOS
descriptor (URL and hash), the list of updates, the device to enable, the startup entry, the board
used for the BIOS check, the hardware data to export. The window had no CSP, no navigation or
new-window limits; context isolation was on and Node integration off (kept).

## What changed

| Piece | What it does |
| --- | --- |
| `electron/ipc/guard.cjs` | every request: the sender must be Tune's window, its main frame, on Tune's own page; then the arguments must match the channel's rules. Otherwise `{ ok: false }` and nothing runs. |
| `electron/ipc/validate.cjs` | small argument rules (string length, one of, boolean, bounded array, JSON size); extra arguments are refused |
| `electron/ipc/offers.cjs` | what the main process found in its own last scans; an action points at one by ID, and an ID that wasn't offered is refused |
| `electron/ipc/channels.cjs` | all 40 channels in one table: exact argument rules and what each runs; Windows operations are injected, so the table is tested without Electron |
| `electron/main.cjs` | registers channels only through the guard (one loop); the window gets an explicit `sandbox: true`, no new windows, no navigation away, no webviews; loads its page by URL so the sender check knows it |
| `vite.config.js` | a Content-Security-Policy in the built page: only the app's own scripts, styles, images, sound and fonts |
| renderer (`useCommands`, `useScanResults`) | actions send IDs: update IDs, the GPU name, category keys, the startup entry's source+key, the recommendation key, the export format; the GPU and BIOS checks send nothing (the main process uses its own hardware scan) |

Request by request:

| Channel | Before: from the window | Now |
| --- | --- | --- |
| `drv:install` | update objects | update IDs (GUIDs, ≤100) that the last search offered |
| `drv:gpuInstaller` | download URL | GPU name; the URL comes from the last GPU check |
| `bios:download` | BIOS descriptor (URL, hash) | nothing; the BIOS the catalog offered |
| `bios:check` / `drv:gpu` | board / GPU list | nothing; from the main process' hardware scan |
| `dev:enable` | device object | device ID that the scan reported with a problem |
| `junk:clean` | category objects | category keys the last scan listed |
| `startup:toggle` | entry object | source + key of an entry the last list showed |
| `rec:apply` | recommendation object | one of power / gamemode / hags, present in the last list |
| `hw:export` | all hardware data | `csv` or `txt`; the main process' own scan |
| `link:open` | any https URL | https, without credentials in the address |

## Commands and results

| Check | Result |
| --- | --- |
| `npm test` | 38 pass: +8 connection tests (foreign sender, 15 malformed requests, unoffered IDs, actions use main's own details, every bridge call guarded, one registration loop, window settings) +1 architecture rule |
| `npm run build` | pass, CSP in `dist/index.html` |
| Real app, every page (service pipe refused) | 9 pages + guide, 0 errors (sandbox + CSP + sender check work with the packaged-style `file://` page) |
| Real app, harmless probes | BIOS not offered → refused, 0 downloads; malformed export → invalid; folder outside the scan → nothing; non-https link → invalid; `window.open` → blocked; navigating away → blocked; injected inline script → blocked by CSP |
| Scan-failure run, overlap test (16/16), celebration (sound under CSP) | unchanged |

## Pending

- Probes of the admin actions with forged IDs were run only in the unit tests (with fake
  operations), not in the real app, so nothing could reach a UAC prompt on a real PC. On a Windows
  VM: forged `drv:install` / `dev:enable` / `junk:clean` / `startup:toggle` must be refused before
  any elevation.
- The installed (asar) build: the sender check compares against `dist/index.html` inside
  `app.asar`; verify once on the next packaged build.

## Next

- TUN-16: diagnostic policies return facts + confidence; unknown stays unknown.
- TUN-01/02/06: service caller authorization, protected broker, deadlines (needs a Windows VM).
