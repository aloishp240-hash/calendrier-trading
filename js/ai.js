/* Coach IA : discussion avec Gemini (offre API gratuite) sur la période affichée,
   historique des 10 dernières conversations, et copie pour Claude.

   Confidentialité : on utilise generateContent, qui ne stocke pas la conversation
   chez Google ; c'est l'appli qui garde l'historique (chiffré, voir ai-store.js).
   Rien n'est envoyé tant que tu ne poses pas de question. */
window.TC = window.TC || {};

TC.ai = (function () {
  'use strict';

  const { cal, aiStore, aiContext } = TC;
  const $ = (id) => document.getElementById(id);

  let apiBase = 'https://generativelanguage.googleapis.com/v1beta/models/';   // modifiable pour les tests
  const MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash'];                    // principal, puis secours
  const KEY_PAGE = 'https://aistudio.google.com/apikey';
  const CLAUDE_URL = 'https://claude.ai/new';

  const SUGGESTIONS = [
    'Analyse ma période : points forts, points faibles',
    'Quels instruments me coûtent le plus, et pourquoi ?',
    'Est-ce que je trade mieux à certaines heures ?',
    'Quelles erreurs reviennent le plus souvent ?'
  ];

  class AiError extends Error {
    constructor(message, code) { super(message); this.name = 'AiError'; this.code = code; }
  }

  /* ---------------- Client Gemini ---------------- */

  /* Lit un flux « server-sent events » et renvoie chaque objet JSON reçu */
  async function* readSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : events.pop();
      for (const ev of events) {
        const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data); } catch (e) { /* morceau illisible : ignoré */ }
      }
      if (done) return;
    }
  }

  function httpError(status, info) {
    const err = (info && info.error) || {};
    const text = `${err.status || ''} ${err.message || ''}`;
    if (/API_KEY_INVALID|API key not valid|API key expired/i.test(text) || status === 401) {
      return new AiError('Clé Gemini invalide ou expirée. Vérifie-la (ou crée-en une nouvelle) sur aistudio.google.com.', 'key');
    }
    if (status === 429) return new AiError('Quota gratuit atteint.', 'quota');
    if (status === 404) return new AiError('Modèle indisponible.', 'model');
    if (status === 403) return new AiError('Accès refusé par Google (clé non autorisée, ou API Gemini indisponible pour ton compte).', 'forbidden');
    if (status >= 500) return new AiError('Gemini est surchargé en ce moment.', 'unavailable');
    return new AiError(`Erreur Gemini (${status})${err.message ? ' : ' + err.message : ''}`, 'http');
  }

  async function streamOnce(model, key, body, signal, onDelta) {
    let res;
    try {
      res = await fetch(`${apiBase}${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new AiError('Pas de connexion internet.', 'offline');
    }
    if (!res.ok) {
      let info = null;
      try { info = await res.json(); } catch (e) { /* pas de détail */ }
      throw httpError(res.status, info);
    }

    const out = { model, answer: '', thoughts: '', signature: null, finish: null, blocked: null };
    for await (const chunk of readSSE(res)) {
      if (chunk.promptFeedback && chunk.promptFeedback.blockReason) out.blocked = chunk.promptFeedback.blockReason;
      const cand = chunk.candidates && chunk.candidates[0];
      if (!cand) continue;
      if (cand.finishReason) out.finish = cand.finishReason;
      for (const part of (cand.content && cand.content.parts) || []) {
        if (part.thoughtSignature) out.signature = part.thoughtSignature;
        if (typeof part.text !== 'string') continue;
        if (part.thought) out.thoughts += part.text;
        else out.answer += part.text;
        onDelta(out);
      }
    }
    if (!out.answer) {
      if (out.blocked || out.finish === 'SAFETY' || out.finish === 'PROHIBITED_CONTENT') {
        throw new AiError('Gemini a refusé de répondre à cette demande. Reformule ta question.', 'blocked');
      }
      throw new AiError('Gemini n’a renvoyé aucune réponse. Réessaie.', 'empty');
    }
    return out;
  }

  /* Pose la question ; bascule sur le modèle de secours si le principal est saturé */
  async function ask({ key, contents, deep, signal, onDelta }) {
    const body = {
      systemInstruction: { parts: [{ text: aiContext.COACH_RULES }] },
      contents,
      generationConfig: { thinkingConfig: { thinkingLevel: deep ? 'high' : 'low', includeThoughts: true } }
    };
    let last = null;
    for (const model of MODELS) {
      try {
        return await streamOnce(model, key, body, signal, onDelta);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (['quota', 'unavailable', 'model'].includes(e.code)) { last = e; continue; }
        throw e;
      }
    }
    if (last && last.code === 'quota') {
      throw new AiError('Quota gratuit atteint sur les deux modèles Gemini. Réessaie dans quelques minutes (la limite quotidienne se réinitialise chaque jour).', 'quota');
    }
    throw last || new AiError('Gemini est indisponible pour le moment.', 'unavailable');
  }

  /* Conversation enregistrée → format de l'API (le contexte précède la 1re question) */
  function toContents(chat) {
    return chat.messages.map((m, i) => {
      if (m.role === 'user') {
        const text = i === 0 ? `Voici mon journal :\n\n${chat.context}\n\nMa question : ${m.text}` : m.text;
        return { role: 'user', parts: [{ text }] };
      }
      const part = { text: m.text };
      if (m.signature) part.thoughtSignature = m.signature;
      return { role: 'model', parts: [part] };
    });
  }

  /* ---------------- Mise en forme des réponses ---------------- */
  /* Mini-Markdown sûr : tout est d'abord échappé, puis on ajoute gras, titres et listes */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  }
  function renderMarkdown(text) {
    const lines = escapeHtml(text).split(/\r?\n/);
    const html = [];
    let list = null;
    let para = [];
    const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
    const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) { flushPara(); closeList(); html.push(`<p class="md-h">${inline(m[1])}</p>`); continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
        flushPara();
        if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
        html.push(`<li>${inline(m[1])}</li>`);
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
        html.push(`<li>${inline(m[1])}</li>`);
        continue;
      }
      closeList();
      para.push(line.trim());
    }
    flushPara();
    closeList();
    return html.join('');
  }

  /* ---------------- Interface ---------------- */
  const els = {};
  let getPeriod = null;         // fourni par app.js : () => { view, isWeek, key }
  let chat = null;              // conversation affichée
  let controller = null;        // pour arrêter une réponse en cours
  let deep = true;

  function show(section) {
    els.setup.hidden = section !== 'setup';
    els.chatView.hidden = section !== 'chat';
    els.history.hidden = section !== 'history';
    els.historyBtn.hidden = section === 'setup';
    els.newBtn.hidden = section === 'setup';
  }

  function setError(msg) { els.error.textContent = msg || ''; }

  function periodLabel() {
    if (chat && chat.period) return chat.period.label;
    const p = getPeriod();
    return p.isWeek ? `Semaine du ${p.view.label}` : p.view.label;
  }

  function scrollToEnd() { els.messages.scrollTop = els.messages.scrollHeight; }

  function messageNode(m) {
    const wrap = document.createElement('div');
    wrap.className = `ai-msg ${m.role === 'user' ? 'from-user' : 'from-ai'}`;
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    if (m.role === 'user') bubble.textContent = m.text;
    else bubble.innerHTML = renderMarkdown(m.text);          // texte échappé dans renderMarkdown
    wrap.append(bubble);
    if (m.role === 'model') {
      const meta = document.createElement('div');
      meta.className = 'ai-meta';
      if (m.thoughts) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Voir le raisonnement';
        const body = document.createElement('div');
        body.className = 'ai-thoughts';
        body.innerHTML = renderMarkdown(m.thoughts);
        details.append(summary, body);
        meta.append(details);
      }
      if (m.model) {
        const tag = document.createElement('span');
        tag.className = 'ai-model';
        tag.textContent = m.model + (m.deep === false ? ' · rapide' : '');
        meta.append(tag);
      }
      wrap.append(meta);
    }
    return wrap;
  }

  function renderChat() {
    els.period.textContent = periodLabel();
    els.messages.replaceChildren();
    const msgs = chat ? chat.messages : [];
    els.suggestions.hidden = msgs.length > 0;
    msgs.forEach((m) => els.messages.append(messageNode(m)));
    scrollToEnd();
  }

  function renderSuggestions() {
    els.suggestions.replaceChildren();
    for (const s of SUGGESTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ai-chip';
      b.textContent = s;
      b.addEventListener('click', () => { els.input.value = s; send(); });
      els.suggestions.append(b);
    }
  }

  async function renderHistory() {
    const chats = await aiStore.listChats();
    els.historyList.replaceChildren();
    els.historyEmpty.hidden = chats.length > 0;
    for (const c of chats) {
      const li = document.createElement('li');
      li.className = 'ai-hist-row';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'ai-hist-open';
      const title = document.createElement('span');
      title.className = 'ai-hist-title';
      title.textContent = c.title;
      const sub = document.createElement('span');
      sub.className = 'ai-hist-sub';
      const d = new Date(c.updatedAt);
      sub.textContent = `${c.period ? c.period.label + ' · ' : ''}${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${c.messages.length} message${c.messages.length > 1 ? 's' : ''}`;
      open.append(title, sub);
      open.addEventListener('click', () => { chat = c; show('chat'); renderChat(); });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ai-hist-del';
      del.setAttribute('aria-label', `Supprimer « ${c.title} »`);
      del.textContent = '×';
      del.addEventListener('click', async () => {
        await aiStore.deleteChat(c.id);
        if (chat && chat.id === c.id) chat = null;
        renderHistory();
      });
      li.append(open, del);
      els.historyList.append(li);
    }
  }

  function setBusy(busy) {
    els.send.textContent = busy ? 'Arrêter' : 'Envoyer';
    els.send.classList.toggle('is-stop', busy);
    els.input.disabled = busy;
    els.historyBtn.disabled = busy;
    els.newBtn.disabled = busy;
  }

  async function send() {
    if (controller) { controller.abort(); return; }          // bouton « Arrêter »
    const question = els.input.value.trim();
    if (!question) return;
    setError('');
    const key = await aiStore.getKey();
    if (!key) { show('setup'); return; }

    if (!chat) {
      const p = getPeriod();
      chat = aiStore.newChat({
        title: question.length > 70 ? question.slice(0, 67) + '…' : question,
        period: { label: p.isWeek ? `Semaine du ${p.view.label}` : p.view.label, key: p.key },
        context: aiContext.build(p.view, p.isWeek)
      });
    }
    const userMsg = { role: 'user', text: question, at: Date.now() };
    chat.messages.push(userMsg);
    els.input.value = '';
    autoGrow();
    renderChat();

    // Bulle de réponse qui se remplit au fil de l'eau
    const live = messageNode({ role: 'model', text: '' });
    live.classList.add('is-live');
    const liveBubble = live.querySelector('.ai-bubble');
    liveBubble.innerHTML = '<span class="ai-typing" aria-label="Gemini réfléchit"><i></i><i></i><i></i></span>';
    els.messages.append(live);
    scrollToEnd();

    controller = new AbortController();
    setBusy(true);
    try {
      const result = await ask({
        key,
        contents: toContents(chat),
        deep,
        signal: controller.signal,
        onDelta: (r) => {
          if (r.answer) liveBubble.innerHTML = renderMarkdown(r.answer);
          else if (r.thoughts) liveBubble.innerHTML = '<span class="ai-thinking">Réflexion en cours…</span>';
          scrollToEnd();
        }
      });
      chat.messages.push({
        role: 'model', text: result.answer, thoughts: result.thoughts || null,
        signature: result.signature, model: result.model, deep, at: Date.now()
      });
      await aiStore.saveChat(chat);
      renderChat();
      if (result.model !== MODELS[0]) setError(`Réponse fournie par le modèle de secours (${result.model}) : le quota du modèle principal est atteint.`);
    } catch (e) {
      // Échec : on retire la question pour pouvoir la renvoyer telle quelle
      chat.messages.pop();
      if (!chat.messages.length) chat = null;
      renderChat();
      els.input.value = question;
      autoGrow();
      if (e.name === 'AbortError') setError('Réponse arrêtée.');
      else {
        setError(e.message || 'Erreur inattendue.');
        if (e.code === 'key') { els.keyInput.value = ''; }
      }
    } finally {
      controller = null;
      setBusy(false);
    }
  }

  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
  }

  async function saveKey() {
    const value = els.keyInput.value.trim();
    setError('');
    // Formats connus : « AIza… » (anciennes clés) et « AQ.… » (nouvelles clés, avec un point)
    if (!/^[A-Za-z0-9._\-]{30,}$/.test(value)) {
      setError('Cette clé ne ressemble pas à une clé Gemini : copie-la en entier depuis AI Studio (bouton « Copier la clé »), sans espace.');
      return;
    }
    await aiStore.setKey(value);
    els.keyInput.value = '';
    show('chat');
    renderChat();
    els.okMsg.textContent = 'Clé enregistrée (chiffrée, et synchronisée avec ton autre appareil si la synchro est active).';
  }

  async function removeKey() {
    await aiStore.setKey(null);
    show('setup');
    els.okMsg.textContent = '';
    setError('Clé supprimée.');
  }

  /* Bouton « Analyser avec Claude » : copie le journal, puis lien vers Claude */
  async function copyForClaude() {
    const p = getPeriod();
    const text = aiContext.forClaude(p.view, p.isWeek);
    els.claudeHint.hidden = false;
    try {
      await navigator.clipboard.writeText(text);
      els.claudeText.hidden = true;
      els.claudeStatus.textContent = 'Journal copié ! Ouvre Claude, colle-le (appui long → Coller), puis envoie.';
    } catch (e) {
      els.claudeText.hidden = false;
      els.claudeText.value = text;
      els.claudeText.select();
      els.claudeStatus.textContent = 'Copie automatique impossible : sélectionne le texte ci-dessous, copie-le, puis ouvre Claude.';
    }
  }

  function open() {
    setError('');
    els.okMsg.textContent = '';
    els.claudeHint.hidden = true;
    els.sheet.classList.remove('closing');
    els.sheet.showModal();
    els.period.textContent = periodLabel();
    aiStore.getKey().then((key) => {
      // Nouvelle période affichée depuis la dernière conversation : on repart de zéro
      if (chat && chat.period && chat.period.key !== getPeriod().key && !chat.messages.length) chat = null;
      if (!key) show('setup');
      else { show('chat'); renderChat(); }
    });
  }

  function lock() {
    if (controller) controller.abort();
    chat = null;
    if (els.sheet && els.sheet.open) els.sheet.close();
    if (els.messages) els.messages.replaceChildren();
    if (els.historyList) els.historyList.replaceChildren();
    if (els.claudeText) els.claudeText.value = '';
  }

  function init(options) {
    getPeriod = options.getPeriod;
    Object.assign(els, {
      sheet: $('aiSheet'), period: $('aiPeriod'), setup: $('aiSetup'), chatView: $('aiChat'),
      history: $('aiHistory'), historyList: $('aiHistoryList'), historyEmpty: $('aiHistoryEmpty'),
      historyBtn: $('aiHistoryBtn'), newBtn: $('aiNewBtn'), closeBtn: $('aiClose'),
      messages: $('aiMessages'), suggestions: $('aiSuggestions'), input: $('aiInput'), send: $('aiSend'),
      deep: $('aiDeep'), error: $('aiError'), okMsg: $('aiOk'),
      keyInput: $('aiKeyInput'), keySave: $('aiKeySave'), keyRemove: $('aiKeyRemove'), keyLink: $('aiKeyLink'),
      claudeBtn: $('aiClaudeBtn'), claudeHint: $('aiClaudeHint'), claudeStatus: $('aiClaudeStatus'), claudeText: $('aiClaudeText'),
      claudeLink: $('aiClaudeLink')
    });
    els.keyLink.href = KEY_PAGE;
    els.claudeLink.href = CLAUDE_URL;
    renderSuggestions();

    els.send.addEventListener('click', send);
    els.input.addEventListener('input', autoGrow);
    els.input.addEventListener('keydown', (e) => {
      // Entrée envoie (Maj+Entrée pour aller à la ligne), sauf sur téléphone
      if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); }
    });
    els.deep.addEventListener('change', () => { deep = els.deep.checked; });
    els.newBtn.addEventListener('click', () => { chat = null; setError(''); show('chat'); renderChat(); els.input.focus(); });
    els.historyBtn.addEventListener('click', () => {
      if (!els.history.hidden) { show('chat'); renderChat(); return; }
      show('history');
      renderHistory();
    });
    els.keySave.addEventListener('click', saveKey);
    els.keyRemove.addEventListener('click', removeKey);
    els.claudeBtn.addEventListener('click', copyForClaude);
    els.closeBtn.addEventListener('click', () => options.close(els.sheet));
    els.sheet.addEventListener('cancel', (e) => { e.preventDefault(); if (!controller) options.close(els.sheet); });
  }

  return {
    init, open, lock, copyForClaude, renderMarkdown,
    /* Rafraîchit l'historique si des conversations arrivent de l'autre appareil */
    onRemoteChange() { if (els.history && !els.history.hidden) renderHistory(); },
    /* Tests uniquement : faux serveur Gemini local */
    _setApiBase(url) { apiBase = url; },
    MODELS
  };
})();
