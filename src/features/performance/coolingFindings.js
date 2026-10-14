// Findings about cooling from the recent temperature samples.
import { median } from '../../presentation/format.jsx';

export function coolingFindings(history, t) {
  const rest = history.filter((h) => h.cpuTempC != null && h.cpuLoad != null && h.cpuLoad < 20);
  if (rest.length < 5) return [];
  const temp = median(rest.map((h) => h.cpuTempC));
  if (temp >= 55) return [{ level: 'warn', text: t(temp >= 70 ? 'fd.cpuHot' : 'fd.cpuWarm', { t: temp }), tips: t('fd.tipCpu') }];
  return [{ level: 'ok', text: t('fd.ok', { t: temp }) }];
}
