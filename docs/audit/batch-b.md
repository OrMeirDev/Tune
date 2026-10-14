# Audit batch B: truthful scan result, microcode baseline, CSV export

Audit of commit `24ad1b1` (Tune 1.2.4), revalidated against the same checkout on 2026-10-14.
Branch: `audit/batch-b`. Nothing published or merged.

## Findings in this batch

| ID | Status | What changed | Evidence |
| --- | --- | --- | --- |
| TUN-03 | Fixed | Each check of a scan (hardware, Windows Update, GPU, BIOS) records `ok` / `error` / `unsupported` (`src/domain/scan-verdict.mjs`). "All up to date" needs every applicable check to have answered; a failed check shows "The scan didn't finish" (no animation, no chime) or, when updates were found, a "not checked this time" note. A failed check keeps the last answer instead of becoming an empty list. A BIOS catalog failure that came back as `ok` with an `error` field now counts as a failure. A later successful scan clears the old Windows Update error banner. | `tests/scan-verdict.test.cjs` (6 tests); app run with sample failures, see below |
| TUN-04 | Fixed | The microcode rule moved to `electron/advice-rules.cjs` with its source and review date. Baseline 0x12B → 0x12F. Intel's page (checked 2026-10-14) says: "the latest BIOS version containing Microcode 0x12F or later". An unreadable revision gives no finding (never "fine"). UI texts updated (en/he). | `tests/advice-rules.test.cjs` (5 tests) |
| TUN-17 | Fixed | `csvCell` in `electron/report.cjs`: text starting with `= + - @`, tab or CR gets a leading apostrophe; plain numbers stay numbers; Hebrew and quotes intact. | `tests/report.test.cjs` (3 tests) |

The other 15 findings were not revalidated in this batch; their status is unchanged (open).

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` (new: `node --test`) | 14 pass, 0 fail |
| `npm run build` | pass |
| `node --check electron/*.cjs` | all pass |
| Scan-failure run in the real app (service pipe refused, sample results) | WU fails → "didn't finish", 0 chimes; GPU fails + BIOS update → update shown with note; all answer → celebration, 1 chime; the WU error banner clears after a good scan |
| Overlap test, he/en at 1347×852 and 980×640 | 16/16 ok |
| Celebration test | chime once per finished scan |

## Pending (needs Windows / real conditions)

- A real Windows Update failure (service stopped) on an installed build, to confirm the error path end to end.
- Excel opening an exported CSV with formula-like device names (the apostrophe convention is standard, but not yet checked in Excel itself).

## Next batches (from the audit backlog)

| Batch | Scope | Status | Blocked by |
| --- | --- | --- | --- |
| C | Extract existing pages/components and feature hooks from `App.jsx` | Ready | – |
| D | Typed IPC, main-owned candidates (TUN-05) | Ready | contract design |
| A/E | Service caller policy, protected broker, deadlines, journal (TUN-01/02/06/11/12) | Planned | a disposable Windows VM for validation |
| F | Electron/dependency upgrade, process/download runners (TUN-07/13) | Planned | test baseline |
| G | Signing, notices, accessibility, installer QA (TUN-09/18) | Planned | signing certificate, candidate build |
