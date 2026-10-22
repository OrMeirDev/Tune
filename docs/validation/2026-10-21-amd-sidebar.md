# AMD catalog and compact sidebar — 21 October 2026

Candidate: 1.4.2, branch `claude/tune-gpu-sidebar-20261021`, based on published 1.4.1 at a5a30070f4c4957088615720752c5647bd7db316. Not published or installed on the user's PC.

## Findings and changes

- AMD previously inspected only the generic minimalsetup link. The renderer correctly treated an autodetect-only result as unknown, so even a healthy AMD page could never produce a completed card-specific check.
- Supported desktop Radeon RX 5000, 6000, 7000 and 9000 names now select the official product page. Its product identity, Windows 10/11 64-bit section, WHQL recommendation, release and official executable address are checked. The public Adrenalin release is read from AMD CN ReleaseVersion; uninstall DisplayVersion is not assumed to have the same meaning. Where no release is available, matching official release notes can confirm the Windows Driver Store version; ambiguous branches remain unknown. The previous official autodetect action remains available as a fallback. Unsupported mobile/workstation/legacy names never receive a guessed package.
- Transient graphics catalog network/408/429/5xx failures get one retry; redirects retain the existing vendor allowlist and installers retain signature validation.
- In RTL, Chromium's offsetLeft included the left scrollbar inset while the pseudo-element's containing block already accounted for that inset. Removing the duplicate inset aligns the Liquid Glass selection. Selection groups are observed for layout size changes.
- Compact menu row padding and group spacing fit all ten destinations without scrolling at 980×640. Existing font sizes are preserved.
- Sidebar completion now follows the same driver source verdict as the Updates page. Partial failures cannot display a green completed state.

## Verification

- Full local unit suite: 278 total, 274 passed, 0 failed, 4 Windows-only skips. Follow-up note identity checks: all 6 AMD tests passed.
- Renderer build passed.
- Real Electron renderer with synthetic Windows data: all ten pages, both languages, 1347×852 and 980×640. Geometry assertions check every navigation item is visible without scrolling, and all four glass edges align with the active item. Forced-scrollbar checks cover the original coordinate bug independently of the compact layout.
- AMD fixtures cover newer/current releases, transient HTTP recovery, exact product/OS binding, rejecting foreign or mismatched downloads, internal versus public version numbers, missing release recovery and ambiguous branch fallback. No real install or machine change is performed.
- The parser was also run against the live official RX 7900 XTX product HTML retrieved on 21 October. It selected the Windows 11 recommended WHQL package, version 26.10.1, and its matching notes. This is catalog evidence, not identification of the user's card.

## Remaining practical validation

The exact user's AMD model has not been supplied and this container cannot inspect that PC or its registry. Check the candidate on that AMD machine, including its detected model/release and the smallest normal window at the user's Windows scaling. Windows CI separately verifies the candidate build and installer. Network access cannot be guaranteed; absent evidence must remain unknown.
