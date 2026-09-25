/* Stockage des données — dans le navigateur (localStorage), chiffrées par TC.vault.
   Toute l'appli passe par ces fonctions : pour synchroniser plus tard
   PC ↔ téléphone, il suffira de modifier ce fichier (les données voyageront
   chiffrées). Les fonctions sont « async » pour pouvoir brancher un serveur
   sans toucher au reste du code. */
window.TC = window.TC || {};

TC.storage = (function () {
  'use strict';

  const KEYS = {
    data: 'ct.data',            // entrées chiffrées
    legacy: 'ct.entries',       // ancienne version en clair (migrée puis supprimée)
    seed: 'ct.seedVersion',
    theme: 'ct.theme'
  };

  let cache = null;             // { 'AAAA-MM-JJ': { pnl, note } } — en mémoire, déverrouillé uniquement
  let available = true;
  let queue = Promise.resolve();

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

  function isValidEntry(e) {
    return e && typeof e.pnl === 'number' && Number.isFinite(e.pnl);
  }
  function mergeInto(target, source) {
    for (const [key, entry] of Object.entries(source || {})) {
      if (isValidEntry(entry)) target[key] = { pnl: entry.pnl, note: entry.note || null };
    }
  }

  /* Les écritures passent l'une après l'autre : la dernière gagne toujours. */
  function persist() {
    queue = queue.catch(() => {}).then(async () => {
      const box = await TC.vault.encryptJSON(cache);
      if (!write(KEYS.data, JSON.stringify(box))) throw new Error('Stockage indisponible');
    });
    return queue;
  }

  async function loadCache() {
    if (cache) return;
    const fresh = {};
    const stored = read(KEYS.data);
    if (stored) mergeInto(fresh, await TC.vault.decryptJSON(JSON.parse(stored)));
    cache = fresh;

    // Migration : données de la version précédente, enregistrées en clair
    const legacy = read(KEYS.legacy);
    if (legacy) {
      try { mergeInto(cache, JSON.parse(legacy)); } catch (e) { /* illisible : ignoré */ }
      await persist();
      removeKey(KEYS.legacy);
    }
  }

  return {
    isAvailable() { return available; },

    async loadAll() {
      await loadCache();
      return { ...cache };
    },

    async save(key, entry) {
      await loadCache();
      cache[key] = entry;
      await persist();
    },

    /* Enregistre plusieurs jours d'un coup (import CSV). */
    async saveMany(entries) {
      await loadCache();
      mergeInto(cache, entries);
      await persist();
    },

    async remove(key) {
      await loadCache();
      delete cache[key];
      await persist();
    },

    /* Importe les données de départ (seed.js, fichier local uniquement)
       si cette version n'a jamais été importée. */
    async applySeed(seed) {
      if (!seed || !seed.version || read(KEYS.seed) === seed.version) return false;
      await loadCache();
      mergeInto(cache, seed.data);
      await persist();
      write(KEYS.seed, seed.version);
      return true;
    },

    /* Au verrouillage : on oublie tout ce qui est en mémoire. */
    lock() { cache = null; },

    /* Code oublié : suppression définitive des données de cet appareil. */
    wipe() {
      cache = null;
      [KEYS.data, KEYS.legacy, KEYS.seed].forEach(removeKey);
    },

    getTheme() {
      const t = read(KEYS.theme);
      return t === 'light' || t === 'dark' ? t : null;
    },
    setTheme(theme) { write(KEYS.theme, theme); }
  };
})();
