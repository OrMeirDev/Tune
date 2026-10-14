# Audit batch C: the renderer split into features and components

Branch: `audit/batch-c` (on top of batch B). Nothing published or merged. Part of TUN-10.

## What changed

`src/App.jsx` went from 1,191 lines to 256: it now holds only the app shell (state, scan
orchestration, navigation). Every page, dialog and shared piece moved verbatim, with its comments,
to its own module; no logic, text or markup changed. The split was done by a script that parses the
code and computes each file's imports from the names it uses, then checked for unresolved names
(0 across 33 files).

| Module | Lines | Was in App.jsx as |
| --- | --- | --- |
| `app/routes.js` | 20 | PAGES, NAV_GROUPS |
| `api.js` | 2 | `window.tune` |
| `presentation/format.jsx` | 41 | ltr, fmtGB, fmtDate, errText, mmss, tempClass, rich, median, rpm, … |
| `components/TaskProgress.jsx` | 18 | ProgressPill |
| `components/NoticeBanner.jsx` | 15 | Banner |
| `components/AppUpdateBanner.jsx` | 21 | UpdateBanner |
| `components/ScanSuccess.jsx` | 71 | AllGood, playChime |
| `components/ScanIncomplete.jsx` | 17 | ScanIncomplete |
| `features/updates/UpdatesPage.jsx` | 146 | UpdatesPage |
| `features/bios/BiosGuideDialog.jsx`, `biosGuides.js` | 44, 11 | BiosGuide, BIOS_HINTS |
| `features/hardware/HardwarePage.jsx`, `devicePresentation.js` | 43, 15 | HardwarePage, classIcon |
| `features/overview/OverviewPage.jsx` | 50 | OverviewPage |
| `features/cleanup/CleanupPage.jsx` | 54 | CleanPage |
| `features/startup/StartupPage.jsx` | 30 | StartupPage |
| `features/performance/PerformancePage.jsx`, `coolingFindings.js` | 50, 10 | PerfPage, coolingFindings |
| `features/sensors/CpuMetrics.jsx`, `useSensorSnapshot.js` | 39, 29 | LiveCpu, useLiveSensors |
| `features/diagnostics/DiagnosticsPage.jsx`, `FindingRow.jsx`, `findingSelectors.js`, `recommendationText.js` | 40, 45, 44, 45 | CenterPage, CenterRow, centerItems/GROUPS, recTitle/recValue/recNote/recIf |
| `features/guides/SettingGuideDialog.jsx` | 36 | SettingGuide, GUIDE_STEPS |
| `features/history/HistoryPage.jsx` | 50 | HistoryPage |
| `features/settings/SettingsPage.jsx`, `PrivilegeSessionChip.jsx` | 63, 40 | SettingsPage, AdminChip |

Dependency rules are written in `AGENTS.md` and enforced by `tests/architecture.test.cjs`.

## Commands and results

| Check | Result |
| --- | --- |
| `npm test` | 20 pass (14 from batch B + 6 architecture rules) |
| `npm run build` | pass |
| Unresolved-identifier scan over `src/` | 0 in 33 files |
| Every page opened in the real app (service pipe refused) | 9 pages + the power-limit guide render, 0 renderer errors |
| Scan-failure run (batch B) | unchanged: incomplete / partial note / celebration |
| Overlap test, he/en, 1347×852 and 980×640 | 16/16 ok |
| Celebration test | chime once per finished scan |

## Still to do in TUN-10 (next)

- Move the scan and operation orchestration out of `App.jsx` into hooks (`useScan` /
  `ScanCoordinator`, `useOperations`), so the shell only composes pages.
- `coolingFindings` still returns translated text; turn it into a pure policy that returns facts
  and confidence (with TUN-16).
- Main process: split `electron/system.cjs` (1,000+ lines) into application services and Windows
  adapters, starting with the pure parts (memory and power advice) next to `advice-rules.cjs`.
