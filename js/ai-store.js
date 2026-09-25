/* Données du coach IA : clé Gemini et historique des dernières conversations.
   Chiffrées dans le coffre (TC.storage.getSecure) et synchronisées entre appareils
   (voir sync.js) : fusion conversation par conversation, la plus récente gagne.

   Format :
   { key: { value, updatedAt } | null,
     chats: { id: { id, title, period, context, messages: [...], createdAt, updatedAt }
              ou { id, deleted: true, updatedAt } } } */
window.TC = window.TC || {};

TC.aiStore = (function () {
  'use strict';

  const { storage } = TC;
  const NAME = 'ai';
  const MAX_CHATS = 10;            // conversations gardées
  const MAX_MESSAGES = 40;         // messages gardés par conversation
  const MAX_TOMBSTONES = 50;

  let data = null;
  const listeners = [];

  function empty() { return { key: null, chats: {} }; }

  function normalize(d) {
    const out = empty();
    if (d && d.key && typeof d.key.value === 'string') {
      out.key = { value: d.key.value, updatedAt: Number(d.key.updatedAt) || 0 };
    }
    for (const [id, c] of Object.entries((d && d.chats) || {})) {
      if (!c || typeof c !== 'object') continue;
      const updatedAt = Number(c.updatedAt) || 0;
      if (c.deleted) { out.chats[id] = { id, deleted: true, updatedAt }; continue; }
      if (!Array.isArray(c.messages)) continue;
      out.chats[id] = {
        id,
        title: String(c.title || 'Conversation'),
        period: c.period || null,
        context: String(c.context || ''),
        messages: c.messages.filter((m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string').slice(-MAX_MESSAGES),
        createdAt: Number(c.createdAt) || updatedAt,
        updatedAt
      };
    }
    return out;
  }

  /* Garde les 10 conversations les plus récentes (règle identique sur tous les appareils) */
  function prune() {
    const all = Object.values(data.chats);
    const live = all.filter((c) => !c.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const c of live.slice(MAX_CHATS)) data.chats[c.id] = { id: c.id, deleted: true, updatedAt: c.updatedAt };
    const dead = Object.values(data.chats).filter((c) => c.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const c of dead.slice(MAX_TOMBSTONES)) delete data.chats[c.id];
  }

  async function load() {
    if (!data) data = normalize(await storage.getSecure(NAME));
    return data;
  }

  async function persist(notify) {
    prune();
    await storage.setSecure(NAME, data);
    if (notify) listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignoré */ } });
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  return {
    MAX_CHATS,

    /* Appelé à chaque modification faite sur cet appareil (pour la synchro) */
    onChange(fn) { listeners.push(fn); },

    async getKey() { await load(); return data.key && data.key.value ? data.key.value : null; },
    async setKey(value) {
      await load();
      data.key = value ? { value: value.trim(), updatedAt: Date.now() } : { value: '', updatedAt: Date.now() };
      await persist(true);
    },

    /* Conversations visibles, la plus récente d'abord */
    async listChats() {
      await load();
      return Object.values(data.chats).filter((c) => !c.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async getChat(id) {
      await load();
      const c = data.chats[id];
      return c && !c.deleted ? JSON.parse(JSON.stringify(c)) : null;
    },

    newChat({ title, period, context }) {
      const now = Date.now();
      return { id: newId(), title, period, context, messages: [], createdAt: now, updatedAt: now };
    },

    async saveChat(chat) {
      await load();
      chat.updatedAt = Date.now();
      chat.messages = chat.messages.slice(-MAX_MESSAGES);
      data.chats[chat.id] = JSON.parse(JSON.stringify(chat));
      await persist(true);
    },

    async deleteChat(id) {
      await load();
      data.chats[id] = { id, deleted: true, updatedAt: Date.now() };
      await persist(true);
    },

    /* ---------- Pour la synchronisation ---------- */
    async exportAll() {
      await load();
      return JSON.parse(JSON.stringify(data));
    },

    /* Renvoie true si quelque chose a changé ici */
    async mergeRemote(remote) {
      await load();
      const theirs = normalize(remote);
      let changed = false;
      if (theirs.key && (!data.key || theirs.key.updatedAt > data.key.updatedAt)) {
        data.key = theirs.key;
        changed = true;
      }
      for (const [id, c] of Object.entries(theirs.chats)) {
        const mine = data.chats[id];
        if (!mine || c.updatedAt > mine.updatedAt) {
          data.chats[id] = c;
          changed = true;
        }
      }
      if (changed) await persist(false);
      return changed;
    },

    /* Même contenu = même clé et mêmes conversations aux mêmes dates */
    same(a, b) {
      const ka = (a && a.key) || null, kb = (b && b.key) || null;
      if ((ka && ka.updatedAt) !== (kb && kb.updatedAt)) return false;
      const ca = (a && a.chats) || {}, cb = (b && b.chats) || {};
      const ids = Object.keys(ca);
      if (ids.length !== Object.keys(cb).length) return false;
      return ids.every((id) => cb[id] && cb[id].updatedAt === ca[id].updatedAt && !!cb[id].deleted === !!ca[id].deleted);
    },

    lock() { data = null; }
  };
})();
