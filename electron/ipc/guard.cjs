// Every request from the window passes here before anything runs:
// 1. the sender must be Tune's own window, its main frame, showing Tune's own page;
// 2. the arguments must match the channel's rules (ipc/channels.cjs).
// A request that fails either gets { ok: false } and runs nothing. Pure apart from what it is
// given; tested in tests/ipc.test.cjs.
const { argsMatch } = require('./validate.cjs');

// The page address without query or hash (a reload in development keeps the same page).
const pageOf = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return null; } };

// webContents: Tune's window; pageUrl: the page Tune loads (file:// in the app, the dev server
// while developing).
function isTrustedSender(event, { webContents, pageUrl }) {
  if (!event || !webContents || event.sender !== webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== webContents.mainFrame) return false;
  return pageOf(frame.url) !== null && pageOf(frame.url) === pageOf(pageUrl);
}

const REFUSED = { ok: false, error: 'refused' };
const INVALID = { ok: false, error: 'invalid request' };

// Runs a channel for one request, or refuses it. `trusted` decides about the sender.
async function dispatch(channel, event, args, trusted) {
  if (!trusted(event)) return REFUSED;
  if (!argsMatch(channel.args, args)) return INVALID;
  return channel.run(...args);
}

module.exports = { isTrustedSender, dispatch, pageOf, REFUSED, INVALID };
