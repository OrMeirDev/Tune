// AMD's per-product download page is evidence of device and OS applicability. The generic
// auto-detect tool is not a release catalog and cannot establish whether a driver is current.
const compact = s => String(s || '').replace(/&(?:trade|reg);|\((?:TM|R)\)|[™®]/gi, '').replace(/[^a-z0-9]/gi, '').replace(/^amd/i, '').toLowerCase();
function amdProductPage(name) {
  const match = String(name || '').replace(/\((?:TM|R)\)|[™®]/gi, '').trim().match(/^(?:AMD\s+)?Radeon\s+RX\s+([5679]\d{3})(?:\s+(XT|XTX|GRE))?$/i);
  if (!match) return null; // Mobile, workstation and legacy cards must not receive a guessed package.
  const model = `${match[1]}${match[2] ? '-' + match[2].toLowerCase() : ''}`;
  return `https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/radeon-rx-${match[1][0]}000-series/amd-radeon-rx-${model}.html`;
}
function amdDriverFromPage(html, name, windows11) {
  const meta = String(html).match(/<meta\b[^>]*property=["']og:title["'][^>]*>/i)?.[0];
  const title = meta?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
  if (!title || !compact(title).startsWith(compact(name) + 'drivers')) throw new Error('AMD page does not match this GPU');
  const sections = String(html).split(/<div\b[^>]*class=["'][^"']*\baccordion-item\b[^"']*["'][^>]*>/i).slice(1);
  const section = sections.find(s => new RegExp(`Windows\\s*${windows11 ? '11' : '10'}\\s*-\\s*64-Bit`, 'i').test(s));
  if (!section) throw new Error('AMD page does not list this Windows edition');
  const articles = [...section.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(m => m[1]);
  for (const article of articles) {
    if (!/<h4\b[^>]*>\s*AMD Software:\s*Adrenalin Edition\s*<\/h4>/i.test(article)) continue;
    const version = article.match(/Adrenalin\s+(\d{2}\.\d{1,2}\.\d{1,2})\s+WHQL\s*\(Recommended\)/i)?.[1];
    if (!version) continue;
    const url = [...article.matchAll(/\bhref=["']([^"']+)["']/gi)].map(m => m[1]).find(value => {
      try {
        const u = new URL(value);
        return u.protocol === 'https:' && u.hostname === 'drivers.amd.com' && !u.username && !u.password && (!u.port || u.port === '443') &&
          u.pathname.includes(`adrenalin-edition-${version}-`) && /-win(?:10|11)(?:-|\.)/.test(u.pathname) && /\.exe$/i.test(u.pathname) && !/minimalsetup/i.test(u.pathname);
      } catch { return false; }
    });
    if (!url) throw new Error('AMD recommended package has no verified download');
    const notePath = article.match(/href=["'](\/en\/resources\/support-articles\/release-notes\/RN-RAD-WIN-[\d-]+\.html)["']/i)?.[1];
    const matchingNotes = notePath && notePath.toLowerCase().endsWith('/rn-rad-win-' + version.replaceAll('.', '-') + '.html');
    return { version, url, notes: matchingNotes ? 'https://www.amd.com' + notePath : null };
  }
  throw new Error('AMD page has no recommended WHQL graphics package');
}
function amdReleaseVersion(value) { return /^\d{2}\.\d{1,2}\.\d{1,2}$/.test(String(value || '').trim()) ? String(value).trim() : null; }
module.exports = { amdProductPage, amdDriverFromPage, amdReleaseVersion };
