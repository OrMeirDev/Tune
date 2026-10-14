// What the main process itself found in its last scans, so a request from the window only points at
// one of those things by ID and never brings its own details: the window says "install update X",
// "download the BIOS you found", "turn off startup entry Y"; the URL, hash, device or registry entry
// come from here. An ID that wasn't offered is refused. Pure; tested in tests/ipc.test.cjs.

const APPLYABLE = ['power', 'gamemode', 'hags']; // the settings Tune can change itself

function createOffers() {
  const last = {};
  const no = (error) => ({ ok: false, error });
  return {
    // remember a scan's result (only successful ones replace the last)
    remember(kind, r) { if (r && r.ok) last[kind] = r.data; return r; },
    has: (kind) => last[kind] != null,

    // the board as the hardware scan saw it, for the BIOS check
    board() {
      const h = last.hw;
      if (!h) return no('no hardware scan yet');
      return { ok: true, data: { maker: h.boardMaker, model: h.boardModel, version: h.bios?.version, date: h.bios?.date, systemMaker: h.systemMaker, systemModel: h.systemModel, systemSku: h.systemSku } };
    },
    gpus() {
      const h = last.hw;
      return h ? { ok: true, data: { gpus: h.gpus || [], amdSoftware: h.amdSoftware || null } } : no('no hardware scan yet');
    },
    hardware: () => (last.hw ? { ok: true, data: last.hw } : no('no hardware scan yet')),

    // Windows Update drivers offered in the last search
    drivers(ids) {
      const offered = new Map([].concat(last.wu || []).map((u) => [String(u.id).toLowerCase(), u]));
      const items = ids.map((id) => offered.get(String(id).toLowerCase()));
      return items.every(Boolean) ? { ok: true, data: items } : no('update not offered');
    },
    // a newer graphics driver found for this GPU (by its name, as the check reported it)
    gpuDriver(gpu) {
      const g = [].concat(last.gpu || []).find((x) => x.gpu === gpu && x.newer && x.url);
      return g ? { ok: true, data: g } : no('no driver offered for this GPU');
    },
    // the newer BIOS the maker's catalog offered
    bios() {
      const b = last.bios;
      return b && b.supported && b.newer && b.latest?.url ? { ok: true, data: b } : no('no BIOS offered');
    },
    // a device with a problem, from the hardware scan
    problemDevice(id) {
      const p = [].concat(last.hw?.problems || []).find((x) => x.id === id);
      return p ? { ok: true, data: p } : no('device not found');
    },
    // cleanup categories the last scan listed
    junkCategories(keys) {
      const listed = new Map([].concat(last.junk || []).map((c) => [c.key, c]));
      const cats = keys.map((k) => listed.get(k));
      return cats.every(Boolean) ? { ok: true, data: cats } : no('category not listed');
    },
    // a startup entry the last list showed
    startupEntry(source, key) {
      const e = [].concat(last.startup || []).find((x) => x.source === source && x.key === key);
      return e ? { ok: true, data: e } : no('startup entry not found');
    },
    // a recommendation Tune can apply, present in the last list
    recommendation(key) {
      const r = APPLYABLE.includes(key) && [].concat(last.recs || []).find((x) => x.key === key);
      return r ? { ok: true, data: r } : no('recommendation not offered');
    },
  };
}

module.exports = { createOffers, APPLYABLE };
