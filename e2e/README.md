# Tune end-to-end checks

Each check builds the app, runs it in Electron with a throwaway profile on the second monitor (if
there is one), and writes screenshots to `e2e/output/<check>/` (not in git).

| Command | What it checks |
| --- | --- |
| `npm run e2e:celebration` | the "all up to date" bubble: animation frames, the chime plays once |
| `npm run e2e:ipc-probes` | harmless forged requests to the locked window → main connection are refused |
| `npm run e2e:layout` | overlapping or clipped text at the smallest and a typical window size (he/en), including the Settings card itself (no sideways scroll, no text clipped or outside it) |
| `npm run e2e:ui-polish` | all ten pages, en/he at 1347×852 and 980×640, native details by mouse/keyboard, retained actions, sample exports, failed reads and historical boot data; every Windows read and change is replaced with synthetic data |
| `npm run e2e:licensing` | activation, licence status, an outage with retry, a second "Check now" within a minute answered without a request, recovery, a release the server confirms (shown on "Check now", enforced, then recovered), the main process's clock set back and corrected (the open row follows without a click), an entitlement bypass attempt, Hebrew RTL and keyboard use, against the licensing server PoC on this PC (needs Node 22+ on PATH); on Windows with real DPAPI and the PC's own machine id, elsewhere with the app's test-only storage |
| `npm run e2e:licensing-startup` | licensing at start, five new-profile starts: timed (the licence row and this PC's identity read, printed), a 20 s identity read (the row must not wait), a failing one (reported as unavailable); one read per start |
| `npm run e2e:service-update` | an older background service: the update notice, Later remembered, a cancelled, failed and successful update, changes never sent to it (stand-ins for the service pipe, the admin session and the installer) |
| `npm run e2e:scan-failure` | three scans with sample results: a failed check never shows "all up to date" |
| `npm run e2e:screenshots` | every screen in Hebrew at 1347×852 (settings and history copied from the real profile, read only) |
| `npm run e2e:smoke` | opens every page and the power-limit guide; reports renderer errors, dialog accessibility, switches |

Safety: nothing here changes the PC.
- The Tune service pipe is refused, except the read-only `version` and `sensors` requests in `screenshots`.
- `licensing` uses a throwaway profile, database and keys in the temp folder and removes them (Chromium may write a few profile files back as it quits); it never contacts anything but the local PoC server.

`licensing` passes only when every step ran and no check failed (`e2e/harness.cjs`): an unexpected error,
a timeout or a cleanup that fails is a failure, exits non-zero and never prints `ALL PASSED`; cleanup runs
either way and its own error is reported after the first one (`tests/e2e-harness.test.cjs`).
- Windows operations are replaced by sample results where a check needs them; the IPC probes send only requests that cannot reach an admin prompt even if a check failed.

## UI polish evidence

`ui-polish` writes synthetic screenshots to `output/ui-polish/after/`. It never copies the real
profile. Sample hardware exports are written only under its throwaway profile. On Windows, a small
cleanup process removes that profile after Electron releases its files, as in `licensing`.

To make an equivalent visual baseline, run the same harness with `TUNE_UI_BASELINE_DIR` pointing at
a separate checkout with its renderer already built. Baseline frames go to `output/ui-polish/before/`.
This flag exists only in the test harness; it is never read by the app.

On a Linux host without a desktop, build first and run, for example:

```sh
ELECTRON_DISABLE_SANDBOX=1 node_modules/.bin/electron \
  --no-sandbox --ozone-platform=headless --ozone-override-screen-size=1920,1080 --disable-gpu \
  e2e/headless-run.cjs e2e/ui-polish.cjs
```

The runner disables the single-instance socket and hardware acceleration in that test process
only. Product startup and packaged behavior are unchanged. `celebration` and `scan-failure` also
stub the healthy inputs they depend on, so a host without Windows/PowerShell can exercise their
intended states. Layout checks ignore unpainted contents of closed native disclosures and retain
their visible summaries; the UI suite separately opens them and checks their content and bounds.
