// What the main process itself found in its last scans, so a request from the window only points at
// one of those things by ID and never brings its own details: the window says "install update X",
// "download the BIOS you found", "turn off startup entry Y"; the URL, hash, device or registry entry
// come from here. An ID that wasn't offered is refused. Pure; tested in tests/ipc.test.cjs.

const APPLYABLE = ['power', 'gamemode', 'hags']; // the settings Tune can change itself

const STALE = 'results are out of date: scan again';

function createOffers() {
  const last = {};
  // A refresh that failed leaves the last results viewable but not actionable: what Windows offered
  // then may no longer be what it offers now, so acting on it waits for a successful scan.
  const stale = {};
  const no = (error) => ({ ok: false, error });
  const fresh = (kind) => !stale[kind];
  return {
    // remember a scan's result: a success replaces the last and makes it actionable; a failure
    // keeps the last for viewing and marks it out of date
    remember(kind, r) {
      if (r && r.ok) { last[kind] = r.data; stale[kind] = false; } else {
        stale[kind] = true;
        // the GPU driver and BIOS offers were found for the hardware the last scan saw; when the
        // hardware scan fails they wait too, until their own checks succeed again
        if (kind === 'hw') { stale.gpu = true; stale.bios = true; }
      }
      return r;
    },
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
      if (!fresh('wu')) return no(STALE);
      const offered = new Map([].concat(last.wu || []).map((u) => [String(u.id).toLowerCase(), u]));
      const items = ids.map((id) => offered.get(String(id).toLowerCase()));
      return items.every(Boolean) ? { ok: true, data: items } : no('update not offered');
    },
    // A newer driver, or AMD's explicit autodetect tool, found by main for this GPU.
    gpuDriver(gpu) {
      if (!fresh('gpu')) return no(STALE);
      const g = [].concat(last.gpu || []).find((x) => x.gpu === gpu && x.url && (x.newer || (x.vendor === 'AMD' && x.installerKind === 'autodetect' && x.status === 'ok')));
      return g ? { ok: true, data: g } : no('no driver offered for this GPU');
    },
    // the newer BIOS the maker's catalog offered
    bios() {
      if (!fresh('bios')) return no(STALE);
      const b = last.bios;
      return b && b.supported && b.newer && b.latest?.url ? { ok: true, data: b } : no('no BIOS offered');
    },
    // a device with a problem, from the hardware scan
    problemDevice(id) {
      if (!fresh('hw')) return no(STALE);
      const p = [].concat(last.hw?.problems || []).find((x) => x.id === id);
      return p ? { ok: true, data: p } : no('device not found');
    },
    // cleanup categories the last scan listed
    junkCategories(keys) {
      if (!fresh('junk')) return no(STALE);
      const listed = new Map([].concat(last.junk || []).map((c) => [c.key, c]));
      const cats = keys.map((k) => listed.get(k));
      return cats.every(Boolean) ? { ok: true, data: cats } : no('category not listed');
    },
    // a startup entry the last list showed
    startupEntry(source, key) {
      if (!fresh('startup')) return no(STALE);
      const e = [].concat(last.startup || []).find((x) => x.source === source && x.key === key);
      return e ? { ok: true, data: e } : no('startup entry not found');
    },
    // a recommendation Tune can apply, present in the last list
    recommendation(key) {
      if (!fresh('recs')) return no(STALE);
      const r = APPLYABLE.includes(key) && [].concat(last.recs || []).find((x) => x.key === key);
      return r ? { ok: true, data: r } : no('recommendation not offered');
    },
  };
}

module.exports = { createOffers, APPLYABLE, STALE };
