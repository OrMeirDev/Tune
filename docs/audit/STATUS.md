# Audit status (audit of 2026-10-14, commit 24ad1b1)

Every finding was revalidated against the code before it was changed. Details per batch:
[batch-b](batch-b.md), [batch-c](batch-c.md), [batch-c2](batch-c2.md), [batch-d](batch-d.md),
[batch-e](batch-e.md); the plan for the privileged boundary: [privileged-boundary-plan](privileged-boundary-plan.md).

| ID | Finding | Status | Evidence / what remains |
| --- | --- | --- | --- |
| TUN-01 | LocalSystem pipe authorization | **Open, designed** | needs a Windows VM with two accounts and code signing; plan written |
| TUN-02 | Elevated execution of user-writable scripts | **Open, designed** | as TUN-01; the elevated code is now one catalog (`privilege/operations.cjs`) |
| TUN-03 | Failed scans could show "all up to date" | **Fixed** | `scan-verdict.mjs`, 6 tests, real-app failure runs |
| TUN-04 | Outdated microcode baseline | **Fixed** | 0x12F per Intel (checked 2026-10-14), 5 tests |
| TUN-05 | IPC without sender/payload contracts | **Fixed** | `electron/ipc/`, 8 tests, real-app probes, packaged build |
| TUN-06 | No pipe/operation deadlines | **Open, designed** | service change; VM tests needed |
| TUN-07 | Unsupported Electron, affected dependencies | **Fixed** (one disposition) | Electron 44.7.2, electron-builder 26.15.3; audit critical 1→0, high 14→1. Remaining high: Vite 5 dev server only (not shipped); Vite 8 upgrade is a separate change |
| TUN-08 | No automated release/branch gates | **Partly fixed** | CI workflow (tests + build on Windows); branch protection is a GitHub setting for the owner to turn on |
| TUN-09 | Unsigned installer | **Open** | needs a code-signing certificate |
| TUN-10 | Architecture mixes pages, policies, orchestration | **Fixed** | App.jsx 1,191→134, system.cjs 1,025→27 (facade); architecture tests |
| TUN-11 | Restore evidence and mutation journal | **Partly fixed** | restore outcome verified by date (created/recent/unavailable); journal is in the plan (service) |
| TUN-12 | Service upgrade not recoverable | **Open, designed** | service install change; VM tests needed |
| TUN-13 | Native runners/downloads unbounded | **Fixed** | downloads: deadline, stall, size, no http redirect, atomic `.part`; spawn errors handled; async CAB; 5 tests |
| TUN-14 | Vendor applicability and descriptors | **Partly fixed** | descriptors held in main (TUN-05); an OEM hash used only if it is a SHA-256 (Lenovo "CRC"); per-vendor catalog fixtures from real machines still to collect |
| TUN-15 | Cleanup containment | **Fixed** (escape not reproducible) | PowerShell 5.1 here did not follow a junction; the cleanup now never enters one regardless of version (real-operation test on a throwaway folder); Windows Update cache waits while it installs |
| TUN-16 | Diagnostics overstate certainty | **Partly fixed** | memory speed unknown without a readable part number (tests); voltage source label waits for the next service update |
| TUN-17 | CSV formula injection | **Fixed** | `csvCell`, 3 tests |
| TUN-18 | Accessibility and notices | **Partly fixed** | dialogs (Escape, focus trap, labelled), switches, live status; notices in the installer. NVDA and 125/150/200% DPI passes still to do by hand |

Tests: `npm test` = 45 (unit, architecture, IPC, PowerShell parse, cleanup containment, resilience).
