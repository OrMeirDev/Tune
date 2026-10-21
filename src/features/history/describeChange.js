// One line for each thing Tune changed, as the history page and the before/after panel show it.
import { fmtGB, tOr } from '../../presentation/format.jsx';

export function describeChange(h, t) {
  const d = h.detail || {};
  switch (h.action) {
    case 'drivers': return t('h.drivers', { items: (d.items || []).join(', ') }) + (d.reboot ? t('h.reboot') : '');
    case 'gpu': return t('h.gpu', { file: d.file });
    case 'bios': return t('h.bios', { v: d.version, file: d.file });
    case 'service': return t(!d.installed ? 'h.serviceOut' : d.pawnio === 'installed' ? 'h.serviceInPawn' : 'h.serviceIn');
    case 'enable': return t('h.enable', { name: d.name });
    // Newer entries store category keys; older ones stored the Hebrew label itself.
    case 'clean': return t('h.clean', { size: fmtGB(d.freed || 0), cats: (d.cats || []).map((c) => tOr(t, `junk.${c}`, c)).join(', ') });
    case 'startup': return t(d.enabled ? 'h.startupOn' : 'h.startupOff', { name: d.name });
    case 'setting': return t('h.setting', { title: d.key ? t(`rec.${d.key}.title`) : d.title });
    case 'restore': return t('h.restore');
    case 'serviceOperation': return t('h.operation', { op: t(`h.op.${d.op}`), state: t(`h.state.${d.operationState}`) });
    default: return h.action;
  }
}
