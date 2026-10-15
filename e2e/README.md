# Tune end-to-end checks

Each check builds the app, runs it in Electron with a throwaway profile on the second monitor (if
there is one), and writes screenshots to `e2e/output/<check>/` (not in git).

| Command | What it checks |
| --- | --- |
| `npm run e2e:celebration` | the "all up to date" bubble: animation frames, the chime plays once |
| `npm run e2e:ipc-probes` | harmless forged requests to the locked window → main connection are refused |
| `npm run e2e:layout` | overlapping or clipped text at the smallest and a typical window size (he/en), including the Settings card itself (no sideways scroll, no text clipped or outside it) |
| `npm run e2e:licensing` | activation, licence status, an outage with retry, recovery, a release the server confirms (shown on "Check now", enforced, then recovered), the main process's clock set back and corrected (the open row follows without a click), an entitlement bypass attempt, Hebrew RTL and keyboard use, against the licensing server PoC on this PC (needs Node 22+ on PATH); on Windows with real DPAPI and the PC's own machine id, elsewhere with the app's test-only storage |
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
