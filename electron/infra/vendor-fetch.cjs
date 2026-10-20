const { allowedAddress, downloadHosts } = require('../domain/download-policy.cjs');

// Check BEFORE each request. A final URL check alone is too late to stop an unauthorized request.
async function vendorFetch(url, { headers = {}, signal, maxRedirects = 5 } = {}) {
  const hosts = downloadHosts(url);
  let current = String(url);
  const requestHeaders = new Headers(headers);
  for (let hop = 0; ; hop++) {
    if (!allowedAddress(current, hosts)) throw new Error('insecure or unauthorized download address');
    const r = await fetch(current, { headers: requestHeaders, signal, redirect: 'manual' });
    if (r.url && !allowedAddress(r.url, hosts)) {
      await r.body?.cancel?.();
      throw new Error('redirected to an insecure or unauthorized address');
    }
    if (![301, 302, 303, 307, 308].includes(r.status)) return r;
    const location = r.headers.get('location');
    await r.body?.cancel?.();
    if (!location) throw new Error('download redirect has no location');
    if (hop >= maxRedirects) throw new Error('too many download redirects');
    const next = new URL(location, current);
    if (!allowedAddress(next.href, hosts)) throw new Error('redirected to an insecure or unauthorized address');
    if (next.origin !== new URL(current).origin) {
      requestHeaders.delete('authorization');
      requestHeaders.delete('cookie');
      requestHeaders.delete('proxy-authorization');
    }
    current = next.href;
  }
}
async function boundedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel?.();
    throw new Error('catalog is too large');
  }
  if (!response.body) throw new Error('catalog has no body');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('catalog is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
module.exports = { vendorFetch, boundedBody };
