// Requests to the licensing server: POST, JSON in and out, a bounded time per request (connecting,
// waiting and reading the answer all count), a bounded answer size, no redirects, and one result
// shape. A request that gets no usable answer (no network, a timeout, a server error, an answer that
// isn't the server's JSON) is { result: 'unavailable', reason }: its result is NOT known. The server
// may have carried it out (an answer lost on the way back) or not; the caller sends the same request
// again (the same idempotency key, so the server treats it as the same) to find out, and never tells
// the person that nothing changed. `fetch` is injected (Electron's net.fetch in the app, so the
// system's proxy settings apply; a stand-in in tests).
const ROUTES = {
  challenge: '/v1/owner/challenge',
  verify: '/v1/owner/verify',
  redeem: '/v1/redeem',
  recover: '/v1/recover',
  refresh: '/v1/license/refresh',
};

const unavailable = (reason, status) => ({ result: 'unavailable', reason, ...(status ? { status } : {}) });

// The answer's text, refusing more than `max` bytes.
async function readLimited(res, max) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text) > max) throw Object.assign(new Error('too large'), { tooLarge: true });
    return text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw Object.assign(new Error('too large'), { tooLarge: true });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createApi({ baseUrl, fetch, timeoutMs = 15000, maxBytes = 64 * 1024 }) {
  if (!baseUrl) throw new Error('no licensing server');
  if (typeof fetch !== 'function') throw new Error('no fetch');

  async function post(route, body) {
    const path = ROUTES[route];
    if (!path) throw new Error(`unknown route ${route}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        redirect: 'error',
      });
      const text = await readLimited(res, maxBytes);
      // a server error: the result isn't known either (the server may have failed after acting)
      if (res.status >= 500) return unavailable('server', res.status);
      let json;
      try { json = JSON.parse(text); } catch { return unavailable('badAnswer', res.status); }
      if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.result !== 'string') return unavailable('badAnswer', res.status);
      return json;
    } catch (err) {
      if (err && err.tooLarge) return unavailable('badAnswer');
      return unavailable(ctrl.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  return { post };
}

module.exports = { createApi, ROUTES };
