# Third-party notices

Tune's background service bundles these components (in `resources/service`):

| Component | License | Source |
|---|---|---|
| LibreHardwareMonitorLib 0.9.6 | MPL-2.0 (full text in `LibreHardwareMonitor-LICENSE.txt`) | https://github.com/LibreHardwareMonitor/LibreHardwareMonitor |
| HidSharp | Apache-2.0 | https://www.zer7.com/software/hidsharp |
| BlackSharp.Core, DiskInfoToolkit, RAMSPDToolkit-NDD | see each project | dependencies of LibreHardwareMonitor |
| System.Buffers, System.Memory, System.Numerics.Vectors, System.Runtime.CompilerServices.Unsafe, System.Security.AccessControl, System.Security.Principal.Windows, System.Threading.AccessControl | MIT (.NET) | https://github.com/dotnet/runtime |

These are the unmodified files from the official LibreHardwareMonitor 0.9.6 release. LibreHardwareMonitorLib embeds signed PawnIO modules (LGPL-2.1, https://github.com/namazso/PawnIO.Modules).

Not bundled, downloaded during setup from the official release and checked (SHA-256 and signature): the PawnIO driver installer (https://github.com/namazso/PawnIO.Setup).

The CPU-temperature and Corsair reading logic follows LibreHardwareMonitor and liquidctl (https://github.com/liquidctl/liquidctl) as references.
