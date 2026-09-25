/* Stockage des données — dans le navigateur (localStorage), chiffrées par TC.vault.

   Chaque jour est enregistré avec sa date de modification (`updatedAt`), et une
   suppression laisse une trace (`deleted: true`). C'est ce qui permet à la
   synchronisation de fusionner deux appareils jour par jour : pour un même jour,
   la modification la plus récente gagne.

   Format d'un jour :
   { pnl, note, trades: [{ instrument, dir, units, opened, closed, result }], updatedAt }
   ou, pour un jour supprimé : { deleted: true, updatedAt } */
window.TC = window.TC || {};

TC.storage = (function () {
  'use strict';

  const KEYS = {
    data: 'ct.data',            // entrées chiffrées
    legacy: 'ct.entries',       // toute première version, en clair (migrée puis supprimée)
    seed: 'ct.seedVersion',
    theme: 'ct.theme',
    view: 'ct.view',
    securePrefix: 'ct.sec.'     // réglages sensibles chiffrés (ex. synchro)
  };

  let cache = null;             // en mémoire, uniquement quand c'est déverrouillé
  let available = true;
  let queue = Promise.resolve();
  const listeners = [];

  function read(key) {
    try { return localStorage.getItem(key); }
    catch (e) { available = false; return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (e) { available = false; return false; }
  }
  function removeKey(key) {
    try { localStorage.removeItem(key); } catch (e) { /* rien à faire */ }
  }

  /* ---------- Validation / normalisation ---------- */
  function cleanTrade(t) {
    if (!t || typeof t.result !== 'number' || !Number.isFinite(t.result)) return null;
    return {
      instrument: String(t.instrument || '?'),
      dir: t.dir === 'buy' || t.dir === 'sell' ? t.dir : null,
      units: typeof t.units === 'number' && Number.isFinite(t.units) ? t.units : null,
      opened: typeof t.opened === 'string' ? t.opened : null,
      closed: typeof t.closed === 'string' ? t.closed : null,
      result: t.result
    };
  }

  function cleanEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const updatedAt = typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt) ? e.updatedAt : 0;
    if (e.deleted) return { deleted: true, updatedAt };
    if (typeof e.pnl !== 'number' || !Number.isFinite(e.pnl)) return null;
    const entry = { pnl: e.pnl, note: e.note || null, updatedAt };
    if (Array.isArray(e.trades)) {
      const trades = e.trades.map(cleanTrade).filter(Boolean);
      if (trades.length) entry.trades = trades;
    }
    return entry;
  }

  function mergeInto(target, source, stamp) {
    for (const [key, raw] of Object.entries(source || {})) {
      const entry = cleanEntry(raw);
      if (!entry) continue;
      if (stamp) entry.updatedAt = stamp;
      target[key] = entry;
    }
  }

  function visible(map) {
    const out = {};
    for (const [key, e] of Object.entries(map)) if (!e.deleted) out[key] = e;
    return out;
  }

  /* ---------- Écriture chiffrée ---------- */
  /* Les écritures passent l'une après l'autre : la dernière gagne toujours. */
  function persist() {
    queue = queue.catch(() => {}).then(async () => {
      const box = await TC.vault.encryptJSON(cache);
      if (!write(KEYS.data, JSON.stringify(box))) throw new Error('Stockage indisponible');
    });
    return queue;
  }

  function notifyLocalChange() {
    listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignoré */ } });
  }

  async function loadCache() {
    if (cache) return;
    const fresh = {};
    const stored = read(KEYS.data);
    if (stored) mergeInto(fresh, await TC.vault.decryptJSON(JSON.parse(stored)));
    cache = fresh;

    // Migration : données de la toute première version, enregistrées en clair
    const legacy = read(KEYS.legacy);
    if (legacy) {
      try { mergeInto(cache, JSON.parse(legacy), Date.now()); } catch (e) { /* illisible : ignoré */ }
      await persist();
      removeKey(KEYS.legacy);
    }
  }

  return {
    isAvailable() { return available; },

    /* Jours visibles (sans les suppressions) */
    async loadAll() {
      await loadCache();
      return visible(cache);
    },

    async save(key, entry) {
      await loadCache();
      const clean = cleanEntry({ ...entry, updatedAt: Date.now() });
      if (!clean) throw new Error('Entrée invalide');
      cache[key] = clean;
      await persist();
      notifyLocalChange();
      return clean;
    },

    /* Enregistre plusieurs jours d'un coup (import CSV). */
    async saveMany(entries) {
      await loadCache();
      mergeInto(cache, entries, Date.now());
      await persist();
      notifyLocalChange();
    },

    async remove(key) {
      await loadCache();
      cache[key] = { deleted: true, updatedAt: Date.now() };
      await persist();
      notifyLocalChange();
    },

    /* ---------- Pour la synchronisation ---------- */

    /* Tout, y compris les traces de suppression */
    async exportAll() {
      await loadCache();
      return JSON.parse(JSON.stringify(cache));
    },

    /* Fusionne des données venues d'un autre appareil : pour chaque jour, la
       version la plus récente gagne. Renvoie true si quelque chose a changé ici. */
    async mergeRemote(remote) {
      await loadCache();
      let changed = false;
      for (const [key, raw] of Object.entries(remote || {})) {
        const theirs = cleanEntry(raw);
        if (!theirs) continue;
        const mine = cache[key];
        if (!mine || theirs.updatedAt > mine.updatedAt) {
          cache[key] = theirs;
          changed = true;
        }
      }
      if (changed) await persist();
      return changed;
    },

    /* Appelé à chaque modification faite sur cet appareil */
    onLocalChange(fn) { listeners.push(fn); },

    /* Réglages sensibles (jeton GitHub, clé de synchro), chiffrés comme les données */
    async getSecure(name) {
      const raw = read(KEYS.securePrefix + name);
      if (!raw) return null;
      return TC.vault.decryptJSON(JSON.parse(raw));
    },
    async setSecure(name, value) {
      if (value === null) { removeKey(KEYS.securePrefix + name); return; }
      const box = await TC.vault.encryptJSON(value);
      if (!write(KEYS.securePrefix + name, JSON.stringify(box))) throw new Error('Stockage indisponible');
    },

    /* ---------- Divers ---------- */

    /* Importe les données de départ (seed.js, fichier local uniquement)
       si cette version n'a jamais été importée. Elles ne remplissent que les jours
       vides et sont datées « le plus ancien possible » : elles ne remplacent jamais
       une vraie saisie, ni ici ni sur un autre appareil via la synchro. */
    async applySeed(seed) {
      if (!seed || !seed.version || read(KEYS.seed) === seed.version) return false;
      await loadCache();
      const missing = {};
      for (const [key, entry] of Object.entries(seed.data || {})) {
        if (!cache[key]) missing[key] = { ...entry, updatedAt: 0 };
      }
      mergeInto(cache, missing);
      await persist();
      write(KEYS.seed, seed.version);
      notifyLocalChange();
      return true;
    },

    /* Au verrouillage : on oublie tout ce qui est en mémoire. */
    lock() { cache = null; },

    /* Code oublié : suppression définitive des données de cet appareil. */
    wipe() {
      cache = null;
      [KEYS.data, KEYS.legacy, KEYS.seed].forEach(removeKey);
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith(KEYS.securePrefix))
          .forEach(removeKey);
      } catch (e) { /* ignoré */ }
    },

    getTheme() {
      const t = read(KEYS.theme);
      return t === 'light' || t === 'dark' ? t : null;
    },
    setTheme(theme) { write(KEYS.theme, theme); },

    getView() { return read(KEYS.view) === 'week' ? 'week' : 'month'; },
    setView(view) { write(KEYS.view, view); }
  };
})();
