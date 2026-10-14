# Response to the 1.3.0 audit recheck

The recheck (main `ea07144`, tag `v1.3.0`) was right: TUN-03 had been marked fixed too early, and
the passing tests missed five gaps because they used the wrong failure shapes. Each gap below was
reproduced with the real shape first; each new test fails on the `v1.3.0` code and passes now.

| Gap | Cause | Fix | Evidence |
| --- | --- | --- | --- |
| R1 GPU failure → "all up to date" | NVIDIA/AMD errors were caught per card while the outer result stayed `ok`; AMD/NVIDIA HTTP errors and a page without a driver link also read as "no update" | every card gets `status`: `ok` / `error` / `unsupported`; HTTP status checked, 20 s limit, empty NVIDIA list not cached, missing link = error; `sourcesFrom` marks the GPU check failed if any card failed | `tests/recheck-regressions.test.cjs` (NVIDIA down, AMD 500, AMD page without a link, mixed Intel+AMD, Intel only); e2e scenario 3 |
| R2 ASUS failure → "unsupported" → "all up to date" | both catalog addresses failing returned an empty list | an empty list counts only when ASUS answered properly; network/HTTP/bad JSON/"FAIL" on both → error; 20 s limit | regression test (down, FAIL, 503, valid empty); e2e scenario 2 |
| R3 failed cleanup/startup scans → healthy | loaders replaced failures with empty lists | failures keep the last answer and record `junk`/`startup`/`recs` = error (the full scan no longer wipes these); the center shows "not checked", the pages say the scan failed, the overview shows "—" | regression test runs the real loaders (bundled) and selector; e2e scenario 4 |
| R4 up-to-date count without a successful check | count = devices − offers whenever not loading | shown only when Windows Update answered; otherwise "—" | e2e scenario 1 |
| R5 old offers actionable after a failed refresh | `remember` kept the last success and ignored failures | a failed refresh marks that kind out of date: viewable, not actionable, until a successful scan; the user is told to scan again | regression test for every action kind |

Also from the recheck:

- **E2E scripts were not gates.** All five Tune checks now assert their expectations and exit
  non-zero on any failure (`smoke` 14, `ipc-probes` 8, `celebration` 2, `layout` 16,
  `scan-failure` 14 checks); `scan-failure` uses the real per-card failure shape.
- **TUN-13 vendor catalogs.** OEM catalog requests (Lenovo/Dell/HP) and the ASUS and GPU makers'
  requests now have time limits; CAB catalogs a size ceiling. Not done: an allow-list of final hosts
  for generic downloads (integrity rests on the SHA-256 / publisher signature checks).

## Dependency dispositions (TUN-07)

`npm audit` after the upgrade: 0 critical, 1 high, 9 moderate.

| Package | Severity | Shipped in the app? | Disposition |
| --- | --- | --- | --- |
| vite (and esbuild) | high / moderate | no: build and dev server only; the app ships the built files | accepted until the Vite 8 migration (separate change); never run the dev server on an untrusted network |
| electron-builder, app-builder-lib, dmg-builder, electron-builder-squirrel-windows, @electron/get, global-agent, roarr, sprintf-js | moderate | no: packaging tools | accepted; revisit on the next electron-builder release |

Still open as listed in [STATUS.md](STATUS.md): TUN-01, 02, 06, 09, 12 (privileged boundary, signing).
