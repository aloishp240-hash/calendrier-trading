/* Données du patrimoine : comptes (banque, livrets, PEA, assurance vie…) et
   historique de leurs soldes. Chiffrées dans le coffre et synchronisées
   (voir sync.js) : fusion compte par compte, la version la plus récente gagne.

   Format :
   { accounts: { id: { id, name, category, institution, rate, finaryId,
                       snapshots: [{ d: 'AAAA-MM-JJ', v: 1234.56, s: 'manuel' | 'finary' }],
                       createdAt, updatedAt }
                  ou { id, deleted: true, updatedAt } } } */
window.TC = window.TC || {};

TC.wealthStore = (function () {
  'use strict';

  const { storage } = TC;
  const NAME = 'wealth';
  const CATEGORIES = ['courant', 'livret', 'assurance-vie', 'pea', 'trading212', 'autre'];
  const MAX_SNAPSHOTS = 400;          // plus d'un an de mises à jour quotidiennes

  let data = null;
  const listeners = [];

  const round2 = (n) => Math.round(n * 100) / 100;
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  /* Hypothèses de prévision choisies par toi (null = valeurs par défaut) */
  function cleanForecast(f) {
    if (!f || typeof f !== 'object') return null;
    const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
    const out = {};
    if (num(f.rate) !== undefined) out.rate = num(f.rate);
    if (num(f.vol) !== undefined) out.vol = Math.max(0, num(f.vol));
    if (num(f.monthly) !== undefined) out.monthly = Math.max(0, num(f.monthly));
    if (f.cap === null) out.cap = null;
    else if (num(f.cap) !== undefined) out.cap = Math.max(0, num(f.cap));
    if (typeof f.preset === 'string' || f.preset === null) out.preset = f.preset;
    return Object.keys(out).length ? out : null;
  }

  function cleanAccount(id, a) {
    if (!a || typeof a !== 'object') return null;
    const updatedAt = Number(a.updatedAt) || 0;
    if (a.deleted) return { id, deleted: true, updatedAt };
    const snaps = new Map();
    for (const s of Array.isArray(a.snapshots) ? a.snapshots : []) {
      if (s && isDate(s.d) && Number.isFinite(Number(s.v))) snaps.set(s.d, { d: s.d, v: round2(Number(s.v)), s: s.s === 'finary' ? 'finary' : 'manuel' });
    }
    return {
      id,
      name: String(a.name || 'Compte').slice(0, 80),
      category: CATEGORIES.includes(a.category) ? a.category : 'autre',
      institution: a.institution ? String(a.institution).slice(0, 60) : null,
      rate: Number.isFinite(Number(a.rate)) && a.rate !== null && a.rate !== '' ? Number(a.rate) : null,
      finaryId: a.finaryId ? String(a.finaryId) : null,
      forecast: cleanForecast(a.forecast),
      snapshots: [...snaps.values()].sort((x, y) => (x.d < y.d ? -1 : 1)).slice(-MAX_SNAPSHOTS),
      createdAt: Number(a.createdAt) || updatedAt,
      updatedAt
    };
  }

  function normalize(d) {
    const out = { accounts: {} };
    for (const [id, a] of Object.entries((d && d.accounts) || {})) {
      const c = cleanAccount(id, a);
      if (c) out.accounts[id] = c;
    }
    return out;
  }

  async function load() {
    if (!data) data = normalize(await storage.getSecure(NAME));
    return data;
  }

  async function persist(notify) {
    await storage.setSecure(NAME, data);
    if (notify) listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignoré */ } });
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const copy = (x) => JSON.parse(JSON.stringify(x));

  return {
    CATEGORIES,
    onChange(fn) { listeners.push(fn); },

    /* Comptes visibles */
    async listAccounts() {
      await load();
      return Object.values(data.accounts).filter((a) => !a.deleted).map(copy);
    },

    async getAccount(id) {
      await load();
      const a = data.accounts[id];
      return a && !a.deleted ? copy(a) : null;
    },

    newAccount(fields) {
      const now = Date.now();
      return cleanAccount(newId(), { ...fields, snapshots: [], createdAt: now, updatedAt: now });
    },

    /* Enregistre un compte (nouveau ou modifié) */
    async saveAccount(account) {
      await load();
      const clean = cleanAccount(account.id, { ...account, updatedAt: Date.now() });
      data.accounts[clean.id] = clean;
      await persist(true);
      return copy(clean);
    },

    async deleteAccount(id) {
      await load();
      data.accounts[id] = { id, deleted: true, updatedAt: Date.now() };
      await persist(true);
    },

    /* Plusieurs comptes d'un coup (import Finary), une seule écriture */
    async saveMany(accounts) {
      await load();
      const now = Date.now();
      for (const a of accounts) data.accounts[a.id] = cleanAccount(a.id, { ...a, updatedAt: now });
      await persist(true);
    },

    /* ---------- Pour la synchronisation et la sauvegarde ---------- */
    async exportAll() { await load(); return copy(data); },

    async mergeRemote(remote) {
      await load();
      const theirs = normalize(remote);
      let changed = false;
      for (const [id, a] of Object.entries(theirs.accounts)) {
        const mine = data.accounts[id];
        if (!mine || a.updatedAt > mine.updatedAt) { data.accounts[id] = a; changed = true; }
      }
      if (changed) await persist(false);
      return changed;
    },

    same(a, b) {
      const x = (a && a.accounts) || {}, y = (b && b.accounts) || {};
      const ids = Object.keys(x);
      if (ids.length !== Object.keys(y).length) return false;
      return ids.every((id) => y[id] && y[id].updatedAt === x[id].updatedAt && !!y[id].deleted === !!x[id].deleted);
    },

    lock() { data = null; }
  };
})();
