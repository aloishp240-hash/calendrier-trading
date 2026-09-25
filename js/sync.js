/* Synchronisation entre appareils via un dépôt GitHub privé.

   - Les données envoyées sont chiffrées avec une « clé de synchro » aléatoire de
     256 bits (AES-GCM) : ni GitHub ni personne d'autre ne peut les lire, et elles
     ne dépendent pas du code à 6 chiffres.
   - La clé de synchro et le jeton GitHub sont rangés dans le coffre de chaque
     appareil (TC.storage.getSecure), donc protégés par le code / Face ID.
   - Fusion jour par jour : la modification la plus récente gagne (voir storage.js).
   - Un second appareil se relie avec un « code de liaison » (jeton + clé). */
window.TC = window.TC || {};

TC.sync = (function () {
  'use strict';

  const { storage } = TC;
  let apiBase = 'https://api.github.com';     // modifiable uniquement pour les tests (_setApiBase)
  const REPO = 'calendrier-trading-donnees';
  const FILE = 'calendrier.enc.json';
  const CONFIG_NAME = 'sync';
  const DEBOUNCE_MS = 1500;
  const TOKEN_REMINDER_DAYS = 330;         // le jeton est créé pour 1 an
  const PAIR_PREFIX = 'CT1-';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  let config = null;          // { owner, repo, token, key, setupAt, lastSync }
  let syncKey = null;         // CryptoKey
  let running = null;
  let again = false;
  let timer = null;
  let state = { status: 'off', lastSync: null, error: null };
  const statusListeners = [];
  const remoteListeners = [];

  function setState(patch) {
    state = { ...state, ...patch };
    statusListeners.forEach((fn) => { try { fn(state); } catch (e) { /* ignoré */ } });
  }

  class SyncError extends Error {
    constructor(message, code) { super(message); this.name = 'SyncError'; this.code = code; }
  }

  /* ---------- Chiffrement ---------- */
  function importKey(raw) {
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async function encryptMap(map, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(map)));
    return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
  }
  async function decryptMap(text, key) {
    try {
      const box = JSON.parse(text);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new SyncError('Les données en ligne sont chiffrées avec une autre clé. Relie cet appareil avec le code de liaison de ton autre appareil.', 'bad-key');
    }
  }

  /* ---------- API GitHub ---------- */
  async function api(cfg, path, options = {}) {
    let res;
    try {
      res = await fetch(apiBase + path, {
        ...options,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        }
      });
    } catch (e) {
      throw new SyncError('Pas de connexion internet — nouvel essai plus tard.', 'offline');
    }
    return res;
  }

  function httpError(res) {
    if (res.status === 401) return new SyncError('Jeton GitHub invalide ou expiré. Crée un nouveau jeton puis reconfigure la synchro.', 'auth');
    if (res.status === 403) return new SyncError('GitHub refuse l’accès (droits du jeton insuffisants ou trop de requêtes).', 'forbidden');
    if (res.status === 404) return new SyncError(`Dépôt « ${REPO} » introuvable ou non autorisé pour ce jeton.`, 'not-found');
    return new SyncError(`Erreur GitHub (${res.status}).`, 'http');
  }

  const contentsPath = (cfg) => `/repos/${cfg.owner}/${cfg.repo}/contents/${FILE}`;

  async function pull(cfg, key) {
    const res = await api(cfg, contentsPath(cfg));
    if (res.status === 404) return { map: null, sha: null };
    if (!res.ok) throw httpError(res);
    const json = await res.json();
    const text = atob((json.content || '').replace(/\s/g, ''));
    return { map: await decryptMap(text, key), sha: json.sha };
  }

  async function push(cfg, key, map, sha) {
    const body = {
      message: `Synchro ${new Date().toISOString()}`,
      content: btoa(await encryptMap(map, key))
    };
    if (sha) body.sha = sha;
    const res = await api(cfg, contentsPath(cfg), { method: 'PUT', body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) return false;       // modifié entre-temps
    if (!res.ok) throw httpError(res);
    return true;
  }

  /* Même contenu = mêmes jours avec les mêmes dates de modification */
  function sameMaps(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b || {});
    if (ka.length !== kb.length) return false;
    return ka.every((k) => b[k] && b[k].updatedAt === a[k].updatedAt && !!b[k].deleted === !!a[k].deleted);
  }

  /* Contenu du fichier en ligne. Version 2 : { v: 2, days, ai, wealth } (trades, coach IA, patrimoine).
     Version 1 (ancienne) : directement la liste des jours. */
  function splitPayload(map) {
    if (!map) return { days: null, ai: null };
    if (map.v === 2) return { days: map.days || {}, ai: map.ai || null, wealth: map.wealth || null };
    return { days: map, ai: null, wealth: null };
  }

  async function runSync() {
    const ai = TC.aiStore;
    const wealth = TC.wealthStore;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await pull(config, syncKey);
      const theirs = splitPayload(remote.map);
      let changedHere = theirs.days ? await storage.mergeRemote(theirs.days) : false;
      if (theirs.ai && ai && await ai.mergeRemote(theirs.ai)) changedHere = true;
      if (theirs.wealth && wealth && await wealth.mergeRemote(theirs.wealth)) changedHere = true;

      const merged = {
        v: 2,
        days: await storage.exportAll(),
        ai: ai ? await ai.exportAll() : null,
        wealth: wealth ? await wealth.exportAll() : null
      };
      const upToDate = remote.map && remote.map.v === 2
        && sameMaps(merged.days, theirs.days)
        && (!ai || ai.same(merged.ai, theirs.ai))
        && (!wealth || wealth.same(merged.wealth, theirs.wealth));
      if (!upToDate) {
        const pushed = await push(config, syncKey, merged, remote.sha);
        if (!pushed) continue;               // conflit : on recommence avec la version à jour
      }
      return changedHere;
    }
    throw new SyncError('Conflit de synchronisation — réessaie dans un instant.', 'conflict');
  }

  async function saveConfig() {
    await storage.setSecure(CONFIG_NAME, config);
  }

  /* ---------- Code de liaison ---------- */
  function encodePairing(cfg) {
    const json = JSON.stringify({ o: cfg.owner, r: cfg.repo, t: cfg.token, k: cfg.key, s: cfg.setupAt });
    return PAIR_PREFIX + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodePairing(code) {
    const clean = (code || '').trim().replace(/\s/g, '');
    if (!clean.startsWith(PAIR_PREFIX)) throw new SyncError('Ce n’est pas un code de liaison valide (il commence par « CT1- »).', 'pairing');
    try {
      let s = clean.slice(PAIR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      const p = JSON.parse(decodeURIComponent(escape(atob(s))));
      if (!p.o || !p.r || !p.t || !p.k) throw new Error('incomplet');
      return { owner: p.o, repo: p.r, token: p.t, key: p.k, setupAt: p.s || Date.now(), lastSync: null };
    } catch (e) {
      throw new SyncError('Code de liaison incomplet ou abîmé — recopie-le en entier.', 'pairing');
    }
  }

  const self = {
    REPO,

    isConfigured() { return !!config; },
    getState() { return state; },
    onStatus(fn) { statusListeners.push(fn); },
    /* Appelé quand des données venues de l'autre appareil ont été fusionnées ici */
    onRemoteChange(fn) { remoteListeners.push(fn); },

    tokenNeedsRenewal() {
      return !!(config && Date.now() - config.setupAt > TOKEN_REMINDER_DAYS * 86400000);
    },

    /* À appeler après le déverrouillage */
    async load() {
      config = await storage.getSecure(CONFIG_NAME);
      syncKey = config ? await importKey(unb64(config.key)) : null;
      setState({ status: config ? 'idle' : 'off', lastSync: config ? config.lastSync : null, error: null });
    },

    /* Au verrouillage */
    lock() {
      clearTimeout(timer);
      config = null;
      syncKey = null;
      setState({ status: 'off', lastSync: null, error: null });
    },

    /* Synchronise maintenant (ou se joint à la synchro en cours) */
    syncNow() {
      if (!config) return Promise.resolve(false);
      if (running) { again = true; return running; }
      setState({ status: 'syncing', error: null });
      running = runSync()
        .then(async (changedHere) => {
          config.lastSync = Date.now();
          await saveConfig();
          setState({ status: 'idle', lastSync: config.lastSync, error: null });
          if (changedHere) remoteListeners.forEach((fn) => { try { fn(); } catch (e) { /* ignoré */ } });
          return changedHere;
        })
        .catch((e) => {
          setState({ status: 'error', error: e.message || 'Erreur de synchronisation.' });
          return false;
        })
        .finally(() => {
          running = null;
          if (again) { again = false; self.schedule(); }
        });
      return running;
    },

    /* Synchro un peu plus tard (regroupe les modifications rapprochées) */
    schedule(delay = DEBOUNCE_MS) {
      if (!config) return;
      clearTimeout(timer);
      timer = setTimeout(() => self.syncNow(), delay);
    },

    /* Premier appareil : vérifie le jeton, crée la clé et envoie les données */
    async setup(token) {
      token = (token || '').trim();
      if (!/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(token)) {
        throw new SyncError('Ce jeton ne ressemble pas à un jeton GitHub (il commence par « github_pat_ »).', 'token');
      }
      const probe = { token, owner: '', repo: REPO };
      const me = await api(probe, '/user');
      if (!me.ok) throw httpError(me);
      probe.owner = (await me.json()).login;

      const repo = await api(probe, `/repos/${probe.owner}/${REPO}`);
      if (!repo.ok) throw httpError(repo);
      const existing = await api(probe, contentsPath(probe));
      if (existing.ok) {
        throw new SyncError('Une synchro existe déjà : sur cet appareil, colle plutôt le code de liaison de ton autre appareil, puis touche « Lier cet appareil ».', 'exists');
      }
      if (existing.status !== 404) throw httpError(existing);

      const raw = crypto.getRandomValues(new Uint8Array(32));
      config = { owner: probe.owner, repo: REPO, token, key: b64(raw), setupAt: Date.now(), lastSync: null };
      syncKey = await importKey(raw);
      raw.fill(0);
      await saveConfig();
      await self.syncNow();
      if (state.status === 'error') throw new SyncError(state.error, 'first-sync');
    },

    /* Appareil suivant : se relie avec le code de liaison */
    async link(code) {
      const cfg = decodePairing(code);
      const key = await importKey(unb64(cfg.key));
      await pull(cfg, key);                   // vérifie jeton + clé avant d'enregistrer
      config = cfg;
      syncKey = key;
      await saveConfig();
      await self.syncNow();
      if (state.status === 'error') throw new SyncError(state.error, 'first-sync');
    },

    /* Tests uniquement : faire parler la synchro à un faux GitHub local */
    _setApiBase(url) { apiBase = url; },

    pairingCode() {
      if (!config) throw new SyncError('Synchro non configurée.', 'off');
      return encodePairing(config);
    },

    /* Désactive la synchro sur CET appareil (les données en ligne restent) */
    async disable() {
      clearTimeout(timer);
      config = null;
      syncKey = null;
      await storage.setSecure(CONFIG_NAME, null);
      setState({ status: 'off', lastSync: null, error: null });
    }
  };

  return self;
})();
