// The icon for each kind of device.
import { Bluetooth, Camera, Cpu, HardDrive, Monitor, Network, Usb, Volume2, Wifi } from 'lucide-react';

export function classIcon(cls = '', name = '') {
  const s = `${cls} ${name}`.toUpperCase();
  if (/DISPLAY|RADEON|GEFORCE/.test(s)) return Monitor;
  if (/BLUETOOTH/.test(s)) return Bluetooth;
  if (/WI-?FI|WIRELESS|802\.11/.test(s)) return Wifi;
  if (/NET|ETHERNET|LAN/.test(s)) return Network;
  if (/MEDIA|AUDIO|SOUND/.test(s)) return Volume2;
  if (/CAMERA|IMAGE/.test(s)) return Camera;
  if (/USB/.test(s)) return Usb;
  if (/DISK|STORAGE|NVME|SCSI/.test(s)) return HardDrive;
  return Cpu;
}
