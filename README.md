# Tune

Windows driver updater and PC optimizer, in English and Hebrew (right-to-left), switchable in Settings. Drivers come only from official sources, and nothing on the system changes without a click.

## Install

Download `Tune-Setup-x.y.z.exe` from the [latest release](https://github.com/OrMeirDev/Tune/releases/latest) and run it. At the end of setup Windows asks for approval once: that installs Tune's background service, after which drivers, cleanup and settings apply without further prompts. Declining is fine; Tune then asks once per 10 minutes instead, and the service can be installed later from Settings.

Installed copies update themselves: when a new release is published, Tune shows an "update available" bar, and the update installs silently with a restart.

The installer is not code-signed, so Windows SmartScreen warns on first run: click **More info → Run anyway**.

## What it does

**Drivers and BIOS**
- Windows Update drivers (published by the hardware makers, signed by Microsoft), one at a time or all at once, with download and install progress and a restore point first.
- Graphics drivers straight from AMD and NVIDIA, checked against the maker's digital signature before they open. Intel Arc: the official page (intel.com only serves browsers).
- BIOS: ASUS boards, and Lenovo, Dell and HP computers, from each maker's own catalog, checked against the published SHA-256 (and signature), with install steps for that maker. Other boards get a search on their maker's site.
- Disabled devices, export of the full hardware list (Excel or text).

**Optimization**
- Cleanup (temp files older than a day, Windows Update leftovers, browser caches, thumbnails, crash reports), each with a link to its folder.
- Startup apps on/off, recommended settings (power plan, game mode, GPU scheduling).
- CPU, coolant and GPU temperatures, fans, what loads the CPU and memory, and plain-language findings on why the PC runs hot.
- History of every change, and restore points.

## Background service

`service/TuneService.cs` runs as LocalSystem so privileged operations need no prompt each time. It listens on a named pipe that only users signed in at the PC can open, runs only the fixed operations in its `ops.ps1` (installed with it in Program Files), and reads sensors through [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) with the signed [PawnIO](https://pawnio.eu/) driver. Corsair Commander coolers are read passively while iCUE is open; Tune never writes to them.

## Develop

```bash
npm install
npm run build:service   # compiles the service with Windows' own C# compiler, fetches LibreHardwareMonitor (pinned)
npm start               # build the service and run the app
npm run dist            # build the installer into release/
npm run release         # build and publish a GitHub release (needs GH_TOKEN)
```

To publish an update: bump `version` in `package.json`, then run `npm run release`. If the service changed, also bump `SERVICE_VERSION` in `electron/system.cjs` and `Version` in `service/TuneService.cs`; installed copies then offer a one-click service update.

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
